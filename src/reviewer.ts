import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolCallEvent, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { ApprovalConfig, ReviewResult } from "./types.ts";
import { validModelRef } from "./config.ts";
import { REVIEW_POLICY } from "./policy.ts";

export function resolveReviewer(ctx: ExtensionContext, config: ApprovalConfig, override?: string): Model<Api> {
  const provider = ctx.model?.provider;
  const configured = override || (provider && config.reviewers[provider]);
  if (configured) {
    if (!validModelRef(configured)) throw new Error("Reviewer 必须是 provider/model-id。");
    const slash = configured.indexOf("/");
    const model = ctx.modelRegistry.find(configured.slice(0, slash), configured.slice(slash + 1));
    if (!model) throw new Error(`未找到审批模型 ${configured}。请先在 Pi 中配置该模型。`);
    return model;
  }
  if (provider === "openai-codex" && ctx.model?.api === "openai-codex-responses") {
    const dedicated = ctx.modelRegistry.find(provider, "codex-auto-review");
    if (dedicated) return dedicated;
    const template = ctx.modelRegistry.find(provider, "gpt-5.4") ?? ctx.model;
    return {
      ...template,
      id: "codex-auto-review",
      name: "Codex Auto-review",
      reasoning: true,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  }
  throw new Error("该 provider 尚未配置审批模型。使用 /permissions reviewer provider/model-id，或 --approval-reviewer provider/model-id。");
}

function limited(text: string, size: number) {
  return text.length <= size ? text : text.slice(0, size) + "\n[omitted: evidence truncated]";
}
function transcript(ctx: ExtensionContext) {
  const branch = ctx.sessionManager.getBranch();
  const conversation: Array<{ role: string; text: string }> = [];
  const evidence: Array<{ role: string; text: string }> = [];
  for (const entry of branch) {
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      evidence.push({ role: "untrusted_summary", text: limited(entry.summary, 2000) });
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") continue;
    const text = typeof message.content === "string" ? message.content : message.content.flatMap(block => {
      if (block.type === "text") return [block.text];
      if (block.type === "toolCall") return [JSON.stringify({ tool: block.name, arguments: block.arguments })];
      return [];
    }).join("\n");
    const item = { role: message.role, text: limited(text, message.role === "user" ? 6000 : 2000) };
    if (message.role === "user") conversation.push(item);
    else evidence.push(item);
  }
  return { userMessages: conversation.slice(-6), recentEvidence: evidence.slice(-12) };
}

export async function review(
  event: ToolCallEvent,
  ctx: ExtensionContext,
  config: ApprovalConfig,
  boundary: string,
  tool?: ToolInfo,
  override?: string,
  lifetime?: AbortSignal,
): Promise<ReviewResult> {
  let reviewer: string | undefined;
  let usage: ReviewResult["usage"];
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, ...(ctx.signal ? [ctx.signal] : []), ...(lifetime ? [lifetime] : [])]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const model = resolveReviewer(ctx, config, override);
    reviewer = `${model.provider}/${model.id}`;
    const action = JSON.stringify({ tool: event.toolName, input: event.input });
    if (action.length > 128_000) throw new Error("操作参数过大，无法完整审批；请缩小操作范围。");
    const context = {
      systemPrompt: REVIEW_POLICY,
      messages: [{
        role: "user" as const,
        content: [{ type: "text" as const, text: JSON.stringify({
          workspace: ctx.cwd,
          boundary,
          toolDescription: limited(tool?.description ?? "Unknown tool", 2000),
          unverifiedAnnotations: tool?.annotations,
          ...transcript(ctx),
          proposedAction: JSON.parse(action),
        }) }],
        timestamp: Date.now(),
      }],
    };
    const response = await Promise.race([
      ctx.modelRegistry.streamSimple(model, context, {
        signal,
        reasoning: "low",
        maxTokens: 4096,
      }).result(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("审批超时；这并不表示操作本身不安全。"));
          controller.abort();
        }, config.timeoutMs);
      }),
      new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(new Error("审批已取消。"));
        else signal.addEventListener("abort", () => reject(new Error("审批已取消。")), { once: true });
      }),
    ]);
    usage = response.usage;
    if (signal.aborted) throw new Error("审批已取消。");
    if (response.stopReason !== "stop" || response.content.some(block => block.type === "toolCall")) {
      throw new Error("审批模型未返回完整判断。");
    }
    const text = response.content.filter(block => block.type === "text").map(block => block.text).join("").trim();
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      Object.keys(parsed).length !== 2 ||
      (parsed.decision !== "allow" && parsed.decision !== "deny") ||
      typeof parsed.reason !== "string" || !parsed.reason.trim() || parsed.reason.length > 2000) {
      throw new Error("审批模型返回了无效 JSON 判断。");
    }
    return { decision: parsed.decision, reason: parsed.reason, reviewer, usage };
  } catch (error) {
    return {
      decision: "unavailable",
      reason: `未获得有效审批，操作已拦截。${limited(error instanceof Error ? error.message : String(error), 600)}`,
      reviewer,
      usage,
    };
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}

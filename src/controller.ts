import { createHash } from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { boundaryReason } from "./boundary.ts";
import { configPath, loadConfig, saveConfig, validModelRef } from "./config.ts";
import { DENIAL_GUIDANCE } from "./policy.ts";
import { APPROVAL_INHERITANCE_ENV, captureApprovalInheritance, publishApprovalInheritance, restorePublishedApprovalInheritance, type ApprovalInheritance } from "./inheritance.ts";
import { resolveReviewer, review } from "./reviewer.ts";
import { isMode, MODES, MODE_LABELS, type ApprovalConfig, type ApprovalMode, type ApprovalRecord, type ReviewResult } from "./types.ts";
import { confirmDenied, confirmFull, displayText, reviewingStatus, selectMode, status } from "./ui.ts";

const STATE = "pi-approve:state";
const AUDIT = "pi-approve:review";

function addUsage(a: Usage | undefined, b: Usage): Usage {
  if (!a) return b;
  return {
    input: a.input + b.input, output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: {
      input: a.cost.input + b.cost.input, output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead, cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
}

export class ApprovalController {
  private mode: ApprovalMode = "ask";
  private config: ApprovalConfig = { reviewers: Object.create(null), timeoutMs: 90_000 };
  private error = "审批插件尚未初始化。";
  private epoch = 0;
  private lifetime = new AbortController();
  private stopReviewing?: () => void;
  private queue: Promise<unknown> = Promise.resolve();
  private records: ApprovalRecord[] = [];
  private usages = new Map<string, Usage>();
  private denials: boolean[] = [];
  private consecutive = 0;
  private tripped = false;
  private readonly inheritance: ApprovalInheritance = captureApprovalInheritance();
  private readonly previousInheritance = process.env[APPROVAL_INHERITANCE_ENV];
  private publishedInheritance?: string;

  constructor(private pi: ExtensionAPI) {}

  register() {
    this.pi.registerFlag("approval-mode", {
      type: "string", description: "Approval mode: ask | auto | full (tool gate, not an OS sandbox)",
    });
    this.pi.registerFlag("approval-reviewer", {
      type: "string", description: "Independent approval model: provider/model-id",
    });
    this.pi.registerCommand("permissions", {
      description: "Switch Ask for approval / Approve for me / Full access; reviewer, status, log, cycle",
      handler: (args, ctx) => this.command(args.trim(), ctx),
    });
    this.pi.registerShortcut(Key.ctrlShift("a"), {
      description: "Cycle approval modes", handler: ctx => this.cycle(ctx),
    });
    this.pi.on("session_start", (_event, ctx) => this.restore(ctx));
    this.pi.on("session_tree", (_event, ctx) => this.restore(ctx));
    this.pi.on("session_shutdown", () => {
      this.invalidate();
      restorePublishedApprovalInheritance(this.publishedInheritance, this.previousInheritance);
      this.publishedInheritance = undefined;
    });
    this.pi.on("before_agent_start", event => {
      this.invalidate();
      this.denials = [];
      this.consecutive = 0;
      this.tripped = false;
      event.systemPromptOptions.sections.approval_permissions =
        `Approval mode: ${MODE_LABELS[this.mode]}. This is a tool-level gate, not an OS sandbox. ` +
        (this.mode === "full" ? "This extension will not request approval." :
          "Ordinary workspace file access may proceed. Shell, recursive searches, external paths, " +
          "sensitive files and extension/MCP tools require approval. " + DENIAL_GUIDANCE);
    });
    this.pi.on("tool_call", (event, ctx) => {
      const epoch = this.epoch;
      const next = this.queue.then(() => this.gate(event, ctx, epoch));
      this.queue = next.catch(() => undefined);
      return next;
    });
    this.pi.on("tool_result", event => {
      const usage = this.usages.get(event.toolCallId);
      this.usages.delete(event.toolCallId);
      if (usage) return { usage: addUsage(event.usage, usage) };
    });
    this.pi.on("agent_end", () => { this.usages.clear(); });
  }

  private invalidate() {
    this.stopReviewing?.();
    this.stopReviewing = undefined;
    this.epoch++;
    this.lifetime.abort();
    this.lifetime = new AbortController();
  }

  private override() {
    if (this.inheritance.kind === "inherited") return this.inheritance.snapshot.reviewer;
    if (this.inheritance.kind === "invalid") return undefined;
    const value = this.pi.getFlag("approval-reviewer");
    return typeof value === "string" ? value : undefined;
  }

  private publishInheritance() {
    if (this.inheritance.kind !== "root") return;
    this.publishedInheritance = publishApprovalInheritance(
      this.mode, this.override(), Boolean(this.error),
    );
  }

  private async restore(ctx: ExtensionContext) {
    this.invalidate();
    this.mode = "ask";
    this.records = [];
    this.usages.clear();
    this.denials = [];
    this.consecutive = 0;
    this.tripped = false;
    this.error = "";
    let sessionMode: ApprovalMode | undefined;
    const branch = ctx.sessionManager.getBranch();
    for (const entry of branch) {
      if (entry.type !== "custom" || !entry.data || typeof entry.data !== "object") continue;
      const data = entry.data as Record<string, unknown>;
      if (entry.customType === STATE && isMode(data.mode)) sessionMode = data.mode;
      if (entry.customType === AUDIT && typeof data.reason === "string" && typeof data.tool === "string") {
        this.records.push(entry.data as ApprovalRecord);
      }
    }
    this.records = this.records.slice(-10);
    try {
      this.config = await loadConfig();
      if (this.inheritance.kind === "inherited") {
        this.mode = this.inheritance.snapshot.mode;
        if (this.inheritance.snapshot.blocked) throw new Error("父代理审批配置不可用，子代理工具默认拦截。");
      } else if (this.inheritance.kind === "invalid") {
        this.mode = "ask";
        throw new Error(this.inheritance.reason);
      } else {
        this.mode = sessionMode ?? this.config.mode ?? "ask";
        const flag = this.pi.getFlag("approval-mode");
        if (flag !== undefined) {
          if (!isMode(flag)) throw new Error("--approval-mode 必须是 ask、auto 或 full。");
          this.mode = flag;
        }
        const reviewer = this.override();
        if (reviewer !== undefined && !validModelRef(reviewer)) throw new Error("--approval-reviewer 必须是 provider/model-id。");
      }
    } catch (error) {
      this.mode = "ask";
      this.error = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`审批配置错误，工具将默认拦截：${displayText(this.error)}`, "error");
    }
    this.publishInheritance();
    status(ctx, this.mode);
  }

  private async setMode(mode: ApprovalMode, ctx: ExtensionContext) {
    if (mode === this.mode && (this.inheritance.kind !== "root" || mode === this.config.mode)) return;
    if (this.error) {
      ctx.ui.notify(`请修复审批配置并 /reload：${displayText(this.error)}`, "error");
      return;
    }
    const needsFullConfirmation = mode === "full" && (
      mode !== this.mode || (this.inheritance.kind === "root" && this.config.mode !== "full")
    );
    if (needsFullConfirmation && !(await confirmFull(ctx))) return;
    if (mode === "auto") {
      try { resolveReviewer(ctx, this.config, this.override()); }
      catch (error) {
        ctx.ui.notify(displayText(error instanceof Error ? error.message : String(error)), "warning");
        if (!ctx.hasUI || this.override()) return;
        const ref = await ctx.ui.input("为当前 provider 配置审批模型", "provider/model-id");
        if (!ref || !(await this.configureReviewer(ref, ctx))) return;
      }
    }
    if (this.inheritance.kind === "root") {
      try {
        const latest = await loadConfig();
        latest.mode = mode;
        await saveConfig(latest);
        this.config = latest;
      } catch (error) {
        ctx.ui.notify(`权限模式保存失败：${displayText(error instanceof Error ? error.message : String(error))}`, "error");
        return;
      }
    }
    this.invalidate();
    this.mode = mode;
    this.pi.appendEntry(STATE, { mode });
    this.publishInheritance();
    status(ctx, mode);
    ctx.ui.notify(`Permissions: ${MODE_LABELS[mode]}`, "info");
  }

  private async configureReviewer(ref: string, ctx: ExtensionContext): Promise<boolean> {
    if (this.inheritance.kind !== "root") {
      ctx.ui.notify("子代理沿用父代理审批模型，不能修改用户审批配置。", "warning");
      return false;
    }
    if (!ctx.model || !validModelRef(ref)) {
      ctx.ui.notify("先选择主模型，再指定 provider/model-id。", "error");
      return false;
    }
    const slash = ref.indexOf("/");
    if (!ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1))) {
      ctx.ui.notify(`Pi 中不存在模型 ${displayText(ref)}。`, "error");
      return false;
    }
    if (this.override()) {
      ctx.ui.notify("--approval-reviewer 优先于持久配置；请移除该启动参数后再修改。", "warning");
      return false;
    }
    try {
      const latest = await loadConfig();
      latest.reviewers[ctx.model.provider] = ref;
      await saveConfig(latest);
      this.invalidate();
      this.config = latest;
      ctx.ui.notify(`Reviewer: ${displayText(ref)}，已保存到 ${configPath()}`, "info");
      return true;
    } catch (error) {
      ctx.ui.notify(displayText(error instanceof Error ? error.message : String(error)), "error");
      return false;
    }
  }

  private async command(args: string, ctx: ExtensionContext) {
    if (!args) {
      const mode = await selectMode(ctx, this.mode);
      if (mode) await this.setMode(mode, ctx);
      else if (!ctx.hasUI) this.showStatus(ctx);
      return;
    }
    if (isMode(args)) { await this.setMode(args, ctx); return; }
    if (args === "cycle") { await this.cycle(ctx); return; }
    if (args === "status") { this.showStatus(ctx); return; }
    if (args === "log") {
      ctx.ui.notify(this.records.length ? this.records.map(record =>
        `${record.tool}: ${record.decision} | ${record.reviewer ?? "human"} | ${record.reason}`,
      ).map(displayText).join("\n") : "暂无审批记录。", "info");
      return;
    }
    if (args.startsWith("reviewer ")) {
      await this.configureReviewer(args.slice(9).trim(), ctx);
      return;
    }
    ctx.ui.notify("/permissions [ask|auto|full|cycle|status|log|reviewer provider/model-id]", "info");
  }

  private showStatus(ctx: ExtensionContext) {
    let reviewer: string;
    try {
      const model = resolveReviewer(ctx, this.config, this.override());
      reviewer = `${model.provider}/${model.id}`;
    } catch { reviewer = "未配置"; }
    ctx.ui.notify(displayText(`${MODE_LABELS[this.mode]} | Reviewer: ${reviewer} | ${configPath()} | 无系统级沙箱`), "info");
  }

  private async cycle(ctx: ExtensionContext) {
    await this.setMode(MODES[(MODES.indexOf(this.mode) + 1) % MODES.length], ctx);
  }

  private async gate(event: ToolCallEvent, ctx: ExtensionContext, epoch: number): Promise<ToolCallEventResult | undefined> {
    if (epoch !== this.epoch || ctx.signal?.aborted) return { block: true, reason: "审批状态已变更或请求已取消，请重新提交操作。" };
    if (this.error) return { block: true, reason: this.error, terminate: true };
    if (this.mode === "full") return;
    if (this.tripped) return { block: true, reason: "审批拒绝次数达到上限，本轮已中断。", terminate: true };
    const tool = this.pi.getAllTools().find(item => item.name === event.toolName);
    const boundary = await boundaryReason(event, ctx.cwd, tool);
    if (!boundary) {
      this.consecutive = 0;
      return;
    }
    let result: ReviewResult;
    const snapshot = JSON.stringify(event.input);
    if (this.mode === "ask") {
      const approved = ctx.hasUI && snapshot.length <= 128_000 && await ctx.ui.confirm(
        `Allow ${displayText(event.toolName)}?`,
        displayText(`${boundary}\n\n${snapshot}`),
        { signal: AbortSignal.any([this.lifetime.signal, ...(ctx.signal ? [ctx.signal] : [])]) },
      );
      result = { decision: !ctx.hasUI ? "unavailable" : approved ? "allow" : "deny", reason: ctx.hasUI ?
        (approved ? "用户允许本次操作。" : "用户拒绝、取消或操作参数过大。") : "当前模式无法显示人工审批，默认拦截。" };
    } else {
      const stopReviewing = reviewingStatus(ctx, this.mode);
      this.stopReviewing = stopReviewing;
      try {
        result = await review(event, ctx, this.config, boundary, tool, this.override(), this.lifetime.signal);
      } finally {
        stopReviewing();
        if (this.stopReviewing === stopReviewing) this.stopReviewing = undefined;
      }
    }
    if (epoch !== this.epoch || ctx.signal?.aborted || snapshot !== JSON.stringify(event.input)) {
      return { block: true, reason: "审批期间模式、会话或操作参数已改变，请重新提交。" };
    }
    if (this.mode === "auto" && result.decision === "deny") {
      const approved = await confirmDenied(ctx, event.toolName, boundary, snapshot, result.reason,
        AbortSignal.any([this.lifetime.signal, ...(ctx.signal ? [ctx.signal] : [])]));
      if (epoch !== this.epoch || ctx.signal?.aborted || snapshot !== JSON.stringify(event.input)) {
        return { block: true, reason: "人工审批期间模式、会话或操作参数已改变，请重新提交。" };
      }
      if (approved !== undefined) {
        result = {
          ...result, decision: approved ? "allow" : "deny", reviewerDecision: "deny",
          humanDecision: approved ? "allow" : "deny",
          reason: `${result.reason}\n${approved ? "用户允许本次操作。" : "用户拒绝或取消本次操作。"}`,
        };
      }
    }
    if (result.usage) this.usages.set(event.toolCallId, result.usage);
    const record: ApprovalRecord = {
      ...result, tool: event.toolName, mode: this.mode, time: Date.now(),
      actionHash: createHash("sha256").update(ctx.cwd).update(event.toolName).update(snapshot).digest("hex"),
    };
    this.records = [...this.records.slice(-9), record];
    this.pi.appendEntry(AUDIT, record);
    if (this.mode === "auto") {
      this.consecutive = result.decision === "deny" ? this.consecutive + 1 : 0;
      this.denials = [...this.denials.slice(-49), result.decision === "deny"];
      this.tripped = this.consecutive >= 3 || this.denials.filter(Boolean).length >= 10;
      ctx.ui.notify(displayText(`${event.toolName}: ${result.decision} — ${result.reason}`), result.decision === "allow" ? "info" : "warning");
      if (this.tripped) {
        ctx.ui.notify("自动审批连续拒绝 3 次或最近 50 次审批拒绝 10 次，本轮已中断。", "warning");
        ctx.abort();
      }
    }
    if (result.decision === "allow") return;
    return {
      block: true,
      reason: displayText(result.reason) + " " + (result.decision === "deny" ? DENIAL_GUIDANCE :
        "No approval was obtained. Do not execute this action by another route. Configure the reviewer or ask the user."),
      terminate: result.decision === "unavailable" || this.tripped,
    };
  }
}

import assert from "node:assert/strict";
import { access, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startMock } from "./mock-server.ts";
import { startPi } from "./rpc-client.ts";

const temp = await mkdtemp(join(tmpdir(), "pi-approve-e2e-"));
const workspace = join(temp, "workspace");
const agentDir = join(temp, "agent");
const outside = join(temp, "outside");
await Promise.all([workspace, agentDir, outside].map(path => mkdir(path)));
const mock = await startMock();
const dummyToken = ["e30", Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "e2e-account" },
})).toString("base64url"), "fake-signature"].join(".");
await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: {
  e2e: { baseUrl: mock.url, api: "openai-completions", apiKey: "e2e-only", models: [
    { id: "main", contextWindow: 100000, maxTokens: 4096, reasoning: false },
    { id: "reviewer", contextWindow: 100000, maxTokens: 4096, reasoning: false },
  ] },
  "openai-codex": { baseUrl: mock.url, api: "openai-codex-responses", apiKey: dummyToken,
    models: [{ id: "gpt-5.4", contextWindow: 100000, maxTokens: 4096, reasoning: true }] },
} }));
await writeFile(join(agentDir, "settings.json"), JSON.stringify({
  retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off",
}));
const missing = async (path: string) => {
  try { await access(path); return false; } catch { return true; }
};
const bash = (path: string) => ({ name: "bash", arguments: { command: `printf approved > '${path}'` } });
const confirms = (events: any[]) => events.filter(event => event.type === "extension_ui_request" && event.method === "confirm");
const nestedExtension = join(temp, "nested.ts");
await writeFile(nestedExtension, `
import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "nested", label: "Nested", description: "Nested E2E tool",
    parameters: Type.Object({ command: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) {
      const result = await ctx.executeTool("bash", { command: params.command });
      return { content: result.content, details: undefined };
    },
  });
}
`);
let pi = startPi(workspace, agentDir, ["-e", nestedExtension]);
const latestToolResultText = async () => {
  const messages = (await pi.request("get_messages")).data.messages;
  const result = messages.filter((message: any) => message.role === "toolResult").at(-1);
  assert(result, "expected a tool result");
  return result.content.map((block: any) => block.text ?? "").join("\n");
};
try {
  await pi.request("get_state");
  assert((await pi.request("get_commands")).data.commands.some((command: any) => command.name === "permissions"));
  const file = join(workspace, "normal.txt");
  const ordinary = await pi.run([{ name: "write", arguments: { path: file, content: "ordinary" } }]);
  assert.equal(await readFile(file, "utf8"), "ordinary");
  assert.equal(confirms(ordinary).length, 0);

  pi.confirm(false);
  const blocked = join(workspace, "blocked");
  assert.equal(confirms(await pi.run([bash(blocked)])).length, 1);
  assert(await missing(blocked));
  pi.confirm(true);
  const allowed = join(workspace, "allowed");
  assert.equal(confirms(await pi.run([bash(allowed)])).length, 1);
  assert.equal(await readFile(allowed, "utf8"), "approved");

  const hardlinkContent = "PI_APPROVE_HARDLINK_FIXTURE_MUST_NOT_REACH_MODEL_61c32e";
  const externalHardlink = join(outside, "hardlink-fixture.txt");
  const workspaceHardlink = join(workspace, "ordinary-alias.txt");
  await writeFile(externalHardlink, hardlinkContent);
  await link(externalHardlink, workspaceHardlink);

  pi.confirm(false);
  const ordinaryRead = await pi.run([{ name: "read", arguments: { path: file } }]);
  assert.equal(confirms(ordinaryRead).length, 0);
  assert((await latestToolResultText()).includes("ordinary"));

  const askHardlinkRead = await pi.run([{ name: "read", arguments: { path: workspaceHardlink } }]);
  assert.equal(confirms(askHardlinkRead).length, 1);
  const askHardlinkResult = await latestToolResultText();
  assert(askHardlinkResult.length > 0);
  assert(!askHardlinkResult.includes(hardlinkContent));
  assert(!JSON.stringify((await pi.request("get_messages")).data.messages).includes(hardlinkContent));
  assert(!JSON.stringify(mock.requests).includes(hardlinkContent));

  const external = join(outside, "external.txt");
  const externalRun = await pi.run([{ name: "write", arguments: { path: external, content: "external" } }]);
  assert.equal(confirms(externalRun).length, 1);
  assert(await missing(external));
  await symlink(outside, join(workspace, "linked"));
  const linkedRun = await pi.run([{ name: "write", arguments: { path: join(workspace, "linked", "external.txt"), content: "linked" } }]);
  assert.equal(confirms(linkedRun).length, 1);
  assert(await missing(external));
  const secret = join(workspace, ".env");
  assert.equal(confirms(await pi.run([{ name: "write", arguments: { path: secret, content: "placeholder" } }])).length, 1);
  assert(await missing(secret));

  pi.select("Approve for me");
  pi.input(undefined);
  const beforeMissing = mock.reviews.length;
  await pi.command("/permissions");
  const stillAsk = await pi.run([bash(join(workspace, "missing-reviewer"))]);
  assert.equal(confirms(stillAsk).length, 1);
  assert.equal(mock.reviews.length, beforeMissing);

  pi.input("e2e/reviewer");
  await pi.command("/permissions auto");
  const config = JSON.parse(await readFile(join(agentDir, "approval.json"), "utf8"));
  assert.equal(config.reviewers.e2e, "e2e/reviewer");
  const autoFile = join(workspace, "auto");
  const autoRun = await pi.run([bash(autoFile)]);
  assert.equal(confirms(autoRun).length, 0);
  assert.equal(await readFile(autoFile, "utf8"), "approved");
  assert.equal(mock.reviews.at(-1)?.model, "reviewer");
  assert.equal(mock.reviews.at(-1)?.body.tools?.length ?? 0, 0);
  const toolMessages = (await pi.request("get_messages")).data.messages.filter((message: any) => message.role === "toolResult");
  assert.equal(toolMessages.at(-1).usage.totalTokens, 20);
  const entries = (await pi.request("get_entries")).data.entries;
  assert(entries.some((entry: any) => entry.customType === "pi-approve:review" && entry.data.decision === "allow"));

  mock.setBehavior("allow");
  mock.denyTool("read");
  const beforeHardlinkReview = mock.reviews.length;
  const autoHardlinkRead = await pi.run([{ name: "read", arguments: { path: workspaceHardlink } }]);
  assert.equal(confirms(autoHardlinkRead).length, 0);
  assert.equal(mock.reviews.length, beforeHardlinkReview + 1);
  const reviewerMessage = mock.reviews.at(-1)!.body.messages.at(-1);
  const reviewerText = typeof reviewerMessage.content === "string" ? reviewerMessage.content :
    reviewerMessage.content.map((block: any) => block.text ?? "").join("\n");
  assert.equal(JSON.parse(reviewerText).proposedAction.tool, "read");
  const autoHardlinkResult = await latestToolResultText();
  assert(autoHardlinkResult.includes("mock reviewer decision"));
  assert(!autoHardlinkResult.includes(hardlinkContent));
  assert(!JSON.stringify((await pi.request("get_messages")).data.messages).includes(hardlinkContent));
  assert(!JSON.stringify(mock.requests).includes(hardlinkContent));
  mock.setBehavior("allow");
  mock.denyTool(undefined);

  mock.denyTool("bash");
  const nestedFile = join(workspace, "nested-denied");
  const beforeNested = mock.reviews.length;
  await pi.run([{ name: "nested", arguments: { command: bash(nestedFile).arguments.command } }]);
  assert.equal(mock.reviews.length - beforeNested, 2);
  assert(await missing(nestedFile));
  mock.denyTool(undefined);

  mock.setBehavior("timeout");
  const cancelledFile = join(workspace, "cancelled-review");
  const beforeCancelled = mock.reviews.length;
  const running = pi.run([bash(cancelledFile)]);
  for (let i = 0; i < 250 && mock.reviews.length === beforeCancelled; i++) await delay(20);
  assert(mock.reviews.length > beforeCancelled);
  await pi.command("/permissions ask");
  await running;
  assert(await missing(cancelledFile));
  await pi.command("/permissions auto");

  mock.setBehavior("deny");
  const denied = join(workspace, "auto-denied");
  await pi.run([bash(denied)]);
  assert(await missing(denied));
  const beforeBreaker = mock.reviews.length;
  await pi.run([bash(denied)], true);
  assert.equal(mock.reviews.length - beforeBreaker, 3);
  assert(await missing(denied));

  mock.setBehavior("malformed");
  const malformed = join(workspace, "malformed");
  await pi.run([bash(malformed)]);
  assert(await missing(malformed));
  mock.setBehavior("tool-call");
  await pi.run([bash(malformed)]);
  assert(await missing(malformed));

  pi.confirm(false);
  await pi.command("/permissions full");
  const fullDenied = join(workspace, "full-denied");
  const beforeFullDenied = mock.reviews.length;
  await pi.run([bash(fullDenied)]);
  assert(mock.reviews.length > beforeFullDenied);
  assert(await missing(fullDenied));
  pi.confirm(true);
  await pi.command("/permissions full");
  const full = join(workspace, "full");
  const beforeFull = mock.reviews.length;
  assert.equal(confirms(await pi.run([bash(full)])).length, 0);
  assert.equal(mock.reviews.length, beforeFull);
  assert.equal(await readFile(full, "utf8"), "approved");

  await pi.request("new_session");
  pi.confirm(false);
  const fresh = join(workspace, "fresh-session");
  assert.equal(confirms(await pi.run([bash(fresh)])).length, 1);
  assert(await missing(fresh));
  pi.confirm(true);
  mock.setBehavior("allow");
  await pi.command("/permissions auto");
  await pi.request("set_model", { provider: "openai-codex", modelId: "gpt-5.4" });
  const codex = join(workspace, "codex");
  await pi.run([bash(codex)]);
  assert.equal(mock.reviews.at(-1)?.model, "codex-auto-review");
  assert.equal(await readFile(codex, "utf8"), "approved");
  assert.equal(mock.reviews.at(-1)?.body.tools?.length ?? 0, 0);

  await pi.stop();
  config.timeoutMs = 1000;
  await writeFile(join(agentDir, "approval.json"), JSON.stringify(config));
  pi = startPi(workspace, agentDir, ["--approval-mode", "auto"]);
  mock.setBehavior("timeout");
  await pi.request("get_state");
  const timeout = join(workspace, "timeout");
  const timeoutRun = await pi.run([bash(timeout)]);
  assert(await missing(timeout));
  assert(timeoutRun.some(event => event.method === "notify" && event.message.includes("审批超时")));

  mock.setBehavior("allow");
  pi = await (async () => {
    await pi.stop();
    return startPi(workspace, agentDir, ["--approval-mode", "full"]);
  })();
  await pi.request("get_state");
  const flagFull = join(workspace, "flag-full");
  const flagBefore = mock.reviews.length;
  await pi.run([bash(flagFull)]);
  assert.equal(await readFile(flagFull, "utf8"), "approved");
  assert.equal(mock.reviews.length, flagBefore);

  await pi.stop();
  const printFile = join(workspace, "no-ui");
  await new Promise<void>((resolve, reject) => {
    const child = execFile("pi", [
    "--print", "--offline", "--no-extensions", "--no-skills", "--no-context-files",
    "--no-prompt-templates", "--no-themes", "--no-session", "--model", "e2e/main",
    "-e", fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    JSON.stringify({ calls: [bash(printFile)] }),
    ], { cwd: workspace, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" }, timeout: 15000 },
    error => error ? reject(error) : resolve());
    child.stdin?.end();
  });
  assert(await missing(printFile));
  await writeFile(join(agentDir, "approval.json"), "invalid JSON");
  pi = startPi(workspace, agentDir);
  await pi.request("get_state");
  const broken = join(workspace, "broken-config");
  await pi.run([{ name: "write", arguments: { path: broken, content: "must not execute" } }]);
  assert(await missing(broken));
  console.log("E2E passed: manual/auto/full, configuration, protected paths, symlinks, strict output, nested calls, usage, cancellation, new sessions, circuit breaker, timeout, Codex dedicated reviewer, headless mode and fail-closed startup.");
} finally {
  await pi.stop();
  await mock.close();
  await rm(temp, { recursive: true, force: true });
}

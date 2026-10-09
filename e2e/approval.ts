import assert from "node:assert/strict";
import { access, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startMock } from "./mock-server.ts";
import { piEnvironment, startPi } from "./rpc-client.ts";

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
const statuses = (events: any[]) => events.filter(event => event.type === "extension_ui_request" &&
  event.method === "setStatus" && event.statusKey === "pi-approve").map(event => event.statusText);
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
  assert(await missing(join(agentDir, "approval.json")));

  pi.input("e2e/reviewer");
  await pi.command("/permissions auto");
  const config = JSON.parse(await readFile(join(agentDir, "approval.json"), "utf8"));
  assert.equal(config.reviewers.e2e, "e2e/reviewer");
  assert.equal(config.mode, "auto");
  const autoFile = join(workspace, "auto");
  const autoRun = await pi.run([bash(autoFile)]);
  assert.equal(confirms(autoRun).length, 0);
  assert.deepEqual(statuses(autoRun), ["⠋ Approve for me", "Approve for me"]);
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
  assert.equal(confirms(autoHardlinkRead).length, 1);
  assert(confirms(autoHardlinkRead)[0].message.includes("mock reviewer decision"));
  assert(confirms(autoHardlinkRead)[0].message.includes(workspaceHardlink));
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
  const cancelledRun = await running;
  assert.equal(statuses(cancelledRun)[0], "⠋ Approve for me");
  assert.equal(statuses(cancelledRun).at(-1), "Ask for approval");
  assert(await missing(cancelledFile));
  await pi.command("/permissions auto");

  mock.setBehavior("deny");
  const denied = join(workspace, "auto-denied");
  assert.equal(confirms(await pi.run([bash(denied)])).length, 1);
  assert(await missing(denied));
  const deniedRecord = (await pi.request("get_entries")).data.entries
    .filter((entry: any) => entry.customType === "pi-approve:review").at(-1).data;
  assert.equal(deniedRecord.decision, "deny");
  assert.equal(deniedRecord.reviewerDecision, "deny");
  assert.equal(deniedRecord.humanDecision, "deny");

  pi.confirm(true);
  const overridden = join(workspace, "human-overridden");
  const beforeOverride = mock.reviews.length;
  const overrideRun = await pi.run([bash(overridden)]);
  assert.equal(confirms(overrideRun).length, 1);
  assert.equal(mock.reviews.length, beforeOverride + 1);
  assert(confirms(overrideRun)[0].message.includes(bash(overridden).arguments.command));
  assert(confirms(overrideRun)[0].message.includes(workspace));
  assert.equal(await readFile(overridden, "utf8"), "approved");
  const overrideRecord = (await pi.request("get_entries")).data.entries
    .filter((entry: any) => entry.customType === "pi-approve:review").at(-1).data;
  assert.equal(overrideRecord.decision, "allow");
  assert.equal(overrideRecord.reviewerDecision, "deny");
  assert.equal(overrideRecord.humanDecision, "allow");
  assert.equal(overrideRecord.reviewer, "e2e/reviewer");
  assert(overrideRecord.reason.includes("mock reviewer decision"));
  const overrideMessages = (await pi.request("get_messages")).data.messages;
  assert.equal(overrideMessages.filter((message: any) => message.role === "toolResult").at(-1).usage.totalTokens, 20);
  assert.equal(JSON.parse(await readFile(join(agentDir, "approval.json"), "utf8")).mode, "auto");

  pi.confirm(undefined);
  const cancelledOverride = join(workspace, "cancelled-human-override");
  const beforeHumanConfirm = confirms(pi.events).length;
  const waitingForHuman = pi.run([bash(cancelledOverride)]);
  for (let i = 0; i < 250 && confirms(pi.events).length === beforeHumanConfirm; i++) await delay(20);
  assert.equal(confirms(pi.events).length, beforeHumanConfirm + 1);
  await pi.command("/permissions ask");
  await waitingForHuman;
  assert(await missing(cancelledOverride));
  pi.confirm(false);
  await pi.command("/permissions auto");

  const beforeBreaker = mock.reviews.length;
  await pi.run([bash(denied)], true);
  assert.equal(mock.reviews.length - beforeBreaker, 3);
  assert(await missing(denied));

  mock.setBehavior("malformed");
  const malformed = join(workspace, "malformed");
  assert.equal(confirms(await pi.run([bash(malformed)])).length, 0);
  assert(await missing(malformed));
  mock.setBehavior("tool-call");
  assert.equal(confirms(await pi.run([bash(malformed)])).length, 0);
  assert(await missing(malformed));

  pi.confirm(false);
  await pi.command("/permissions full");
  assert.equal(JSON.parse(await readFile(join(agentDir, "approval.json"), "utf8")).mode, "auto");
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

  mock.setBehavior("allow");
  for (const mode of ["full", "ask", "auto"] as const) {
    await pi.command(`/permissions ${mode}`);
    const saved = JSON.parse(await readFile(join(agentDir, "approval.json"), "utf8"));
    assert.equal(saved.mode, mode);
    assert.equal(saved.reviewers.e2e, "e2e/reviewer");
    assert.equal(saved.timeoutMs, 90_000);
    for (const restart of [false, true]) {
      if (restart) {
        await pi.stop();
        pi = startPi(workspace, agentDir);
        await pi.request("get_state");
        assert.equal(confirms(pi.events).length, 0);
      } else {
        await pi.request("new_session");
      }
      pi.confirm(false);
      const fresh = join(workspace, `${mode}-${restart ? "restart" : "new-session"}`);
      const beforeFresh = mock.reviews.length;
      assert.equal(confirms(await pi.run([bash(fresh)])).length, mode === "ask" ? 1 : 0);
      assert.equal(mock.reviews.length - beforeFresh, mode === "auto" ? 1 : 0);
      if (mode === "ask") assert(await missing(fresh));
      else assert.equal(await readFile(fresh, "utf8"), "approved");
    }
  }
  pi.confirm(true);
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
  assert.equal(confirms(timeoutRun).length, 0);
  assert.deepEqual(statuses(timeoutRun), ["⠋ Approve for me", "Approve for me"]);

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
  const configPath = join(agentDir, "approval.json");
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).mode, "auto");

  pi.confirm(false);
  let beforeFullConfirm = confirms(pi.events).length;
  await pi.command("/permissions full");
  assert.equal(confirms(pi.events).length, beforeFullConfirm + 1);
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).mode, "auto");

  pi.confirm(true);
  beforeFullConfirm = confirms(pi.events).length;
  await pi.command("/permissions full");
  assert.equal(confirms(pi.events).length, beforeFullConfirm + 1);
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).mode, "full");

  pi.confirm(false);
  beforeFullConfirm = confirms(pi.events).length;
  await pi.command("/permissions full");
  assert.equal(confirms(pi.events).length, beforeFullConfirm, "saved full mode is a no-op and does not ask again");
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).mode, "full");

  await pi.command("/permissions ask");
  assert.equal(JSON.parse(await readFile(join(agentDir, "approval.json"), "utf8")).mode, "ask");

  await pi.stop();
  mock.setBehavior("deny");
  for (const mode of ["ask", "auto"]) {
    const printFile = join(workspace, `no-ui-${mode}`);
    const beforePrint = mock.reviews.length;
    await new Promise<void>((resolve, reject) => {
      const child = execFile("pi", [
        "--print", "--offline", "--no-extensions", "--no-skills", "--no-context-files",
        "--no-prompt-templates", "--no-themes", "--no-session", "--model", "e2e/main",
        "-e", fileURLToPath(new URL("../src/index.ts", import.meta.url)), "--approval-mode", mode,
        JSON.stringify({ calls: [bash(printFile)] }),
      ], { cwd: workspace, env: piEnvironment(agentDir), timeout: 15000 },
      error => error ? reject(error) : resolve());
      child.stdin?.end();
    });
    assert(await missing(printFile));
    assert.equal(mock.reviews.length - beforePrint, mode === "auto" ? 1 : 0);
  }
  await writeFile(join(agentDir, "approval.json"), "invalid JSON");
  pi = startPi(workspace, agentDir);
  await pi.request("get_state");
  const broken = join(workspace, "broken-config");
  await pi.run([{ name: "write", arguments: { path: broken, content: "must not execute" } }]);
  assert(await missing(broken));
  console.log("E2E passed: manual/auto/full, configuration, protected paths, symlinks, strict output, nested calls, usage, cancellation, human denial override, persisted permissions, new sessions, restarts, circuit breaker, timeout, Codex dedicated reviewer, headless mode and fail-closed startup.");
} finally {
  await pi.stop();
  await mock.close();
  await rm(temp, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { APPROVAL_INHERITANCE_ENV, SUBAGENT_CHILD_ENV } from "../src/inheritance.ts";
import { startMock } from "./mock-server.ts";
import { piEnvironment, startPi } from "./rpc-client.ts";

const temp = await mkdtemp(join(tmpdir(), "pi-approve-inheritance-e2e-"));
const workspace = join(temp, "workspace");
const agentDir = join(temp, "agent");
await Promise.all([workspace, agentDir].map(path => mkdir(path)));
const mock = await startMock();
const permissionExtension = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const probeExtension = join(temp, "inheritance-probe.ts");
const dummyToken = ["e30", Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "inheritance-e2e" },
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
await writeFile(probeExtension, `
import { spawnSync } from "node:child_process";
import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "inheritance-probe", label: "Inheritance probe", description: "Launch a nested Pi process for approval inheritance E2E.",
    parameters: Type.Object({ depth: Type.Number(), path: Type.String() }),
    async execute(_id, params) {
      const nextCall = params.depth > 0
        ? { name: "inheritance-probe", arguments: { depth: params.depth - 1, path: params.path } }
        : { name: "bash", arguments: { command: ${JSON.stringify("printf inherited > '")} + params.path + ${JSON.stringify("'")} } };
      const child = spawnSync("pi", [
        "--print", "--offline", "--no-extensions", "--no-skills", "--no-context-files",
        "--no-prompt-templates", "--no-themes", "--no-session", "--model", "e2e/main",
        "-e", ${JSON.stringify(permissionExtension)}, "-e", ${JSON.stringify(probeExtension)},
        JSON.stringify({ calls: [nextCall] }),
      ], {
        cwd: ${JSON.stringify(workspace)}, encoding: "utf8", timeout: 20000,
        env: { ...process.env, ${JSON.stringify(SUBAGENT_CHILD_ENV)}: "1",
          PI_CODING_AGENT_DIR: ${JSON.stringify(agentDir)}, PI_OFFLINE: "1" },
      });
      return {
        content: [{ type: "text", text: JSON.stringify({
          status: child.status, signal: child.signal, error: child.error?.message, stderr: child.stderr,
        }) }],
        details: undefined,
      };
    },
  });
}
`);

const missing = async (path: string) => {
  try { await access(path); return false; } catch { return true; }
};
const configPath = join(agentDir, "approval.json");
const configText = (mode: string, withReviewer = true) => JSON.stringify({
  mode,
  reviewers: withReviewer ? { e2e: "e2e/reviewer" } : {},
  timeoutMs: 90_000,
}, null, 2);
const bash = (path: string) => ({ name: "bash", arguments: { command: `printf inherited > '${path}'` } });
const latestToolText = async (pi: ReturnType<typeof startPi>) => {
  const messages = (await pi.request("get_messages")).data.messages;
  const result = messages.filter((message: any) => message.role === "toolResult").at(-1);
  assert(result, "expected a tool result");
  return result.content.map((block: any) => block.text ?? "").join("\n");
};
let pi: ReturnType<typeof startPi> | undefined;
try {
  const cases = [
    { label: "saved-ask", saved: "ask", flags: [], effective: "ask", reviewer: true },
    { label: "saved-auto", saved: "auto", flags: [], effective: "auto", reviewer: true },
    { label: "saved-full", saved: "full", flags: [], effective: "full", reviewer: true },
    { label: "cli-ask", saved: "full", flags: ["--approval-mode", "ask"], effective: "ask", reviewer: true },
    { label: "cli-auto-reviewer", saved: "ask", flags: ["--approval-mode", "auto", "--approval-reviewer", "e2e/reviewer"], effective: "auto", reviewer: false },
    { label: "cli-full", saved: "auto", flags: ["--approval-mode", "full"], effective: "full", reviewer: true },
  ] as const;

  for (const scenario of cases) {
    await writeFile(configPath, configText(scenario.saved, scenario.reviewer));
    const beforeConfig = await readFile(configPath, "utf8");
    const target = join(workspace, scenario.label);
    pi = startPi(workspace, agentDir, ["-e", probeExtension, ...scenario.flags]);
    await pi.request("get_state");
    const beforeReviews = mock.reviews.length;
    const run = await pi.run([{ name: "inheritance-probe", arguments: { depth: 0, path: target } }]);
    const text = await latestToolText(pi);
    const probeResult = JSON.parse(text);
    assert.equal(probeResult.status, 0, `${scenario.label}: child Pi should exit successfully: ${text}`);
    assert.equal(await missing(target), scenario.effective === "ask", `${scenario.label}: child must enforce ${scenario.effective}`);
    assert.equal(mock.reviews.length - beforeReviews, scenario.effective === "auto" ? 2 : 0,
      `${scenario.label}: root probe and child action should both use the reviewer only in auto mode`);
    assert.equal(run.filter(event => event.type === "extension_ui_request" && event.method === "confirm").length,
      scenario.effective === "ask" ? 1 : 0, `${scenario.label}: only the root ask-mode tool needs a UI confirmation`);
    assert.equal(await readFile(configPath, "utf8"), beforeConfig, `${scenario.label}: child must not write inherited mode to shared config`);
    await pi.stop();
    pi = undefined;
  }

  await writeFile(configPath, configText("ask"));
  pi = startPi(workspace, agentDir, ["-e", probeExtension]);
  await pi.request("get_state");
  await pi.command("/permissions full");
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).mode, "full");
  await writeFile(configPath, configText("ask"));
  const beforeModeChangeChild = await readFile(configPath, "utf8");
  const modeChangeTarget = join(workspace, "mode-change-snapshot");
  await pi.run([{ name: "inheritance-probe", arguments: { depth: 0, path: modeChangeTarget } }]);
  assert.equal(await readFile(modeChangeTarget, "utf8"), "inherited", "a successful parent mode change must publish its new snapshot");
  assert.equal(await readFile(configPath, "utf8"), beforeModeChangeChild, "child startup must not persist the published mode");
  await pi.stop();
  pi = undefined;

  await writeFile(configPath, configText("ask"));
  const straySnapshot = JSON.stringify({
    version: 1, mode: "full", publisher: "00000000-0000-4000-8000-000000000001",
  });
  pi = startPi(workspace, agentDir, [], { [APPROVAL_INHERITANCE_ENV]: straySnapshot });
  await pi.request("get_state");
  const ordinaryRootFile = join(workspace, "ordinary-root-ignores-snapshot");
  const ordinaryRoot = await pi.run([bash(ordinaryRootFile)]);
  assert.equal(ordinaryRoot.filter(event => event.type === "extension_ui_request" && event.method === "confirm").length, 1);
  assert.equal(await readFile(ordinaryRootFile, "utf8"), "inherited");
  await pi.stop();
  pi = undefined;

  for (const [label, snapshot] of [["invalid", "not-json"], ["missing", undefined]] as const) {
    await writeFile(configPath, configText("full"));
    const beforeConfig = await readFile(configPath, "utf8");
    const env: NodeJS.ProcessEnv = { [SUBAGENT_CHILD_ENV]: "1" };
    if (snapshot !== undefined) env[APPROVAL_INHERITANCE_ENV] = snapshot;
    pi = startPi(workspace, agentDir, [], env);
    await pi.request("get_state");
    const target = join(workspace, `invalid-inherited-${label}`);
    await pi.run([{ name: "write", arguments: { path: target, content: "must be blocked" } }]);
    assert(await missing(target), `${label} inherited snapshot must fail closed rather than use saved full mode`);
    assert.equal(await readFile(configPath, "utf8"), beforeConfig, `${label} child must not mutate shared config`);
    await pi.stop();
    pi = undefined;
  }

  await writeFile(configPath, configText("ask"));
  const beforeDescendantConfig = await readFile(configPath, "utf8");
  pi = startPi(workspace, agentDir, ["-e", probeExtension, "--approval-mode", "full"]);
  await pi.request("get_state");
  const descendantTarget = join(workspace, "grandchild-inherited-full");
  const beforeDescendantReviews = mock.reviews.length;
  await pi.run([{ name: "inheritance-probe", arguments: { depth: 2, path: descendantTarget } }]);
  assert.equal(await readFile(descendantTarget, "utf8"), "inherited", "grandchild Pi process should inherit the root CLI mode through its child");
  assert.equal(mock.reviews.length, beforeDescendantReviews, "full-mode descendants must not invoke the reviewer");
  assert.equal(await readFile(configPath, "utf8"), beforeDescendantConfig, "descendants must not persist inherited mode");

  console.log("E2E passed: saved and CLI approval inheritance, reviewer override, root isolation, fail-closed child snapshots, shared-config preservation and descendant subprocesses.");
} finally {
  await pi?.stop();
  await mock.close();
  await rm(temp, { recursive: true, force: true });
}

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export function startPi(cwd: string, agentDir: string, flags: string[] = []) {
  const child = spawn("pi", [
    "--mode", "rpc", "--offline", "--no-extensions", "--no-skills", "--no-context-files",
    "--no-prompt-templates", "--no-themes", "--no-session",
    "-e", fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    "--model", "e2e/main", "--thinking", "off", ...flags,
  ], { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
    stdio: ["pipe", "pipe", "pipe"] });
  const events: any[] = [];
  let stderr = "";
  let confirm = true;
  let input: string | undefined;
  let selection: string | undefined;
  const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  let counter = 0;
  const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + "\n");
  child.stderr.on("data", data => { stderr += data; });
  createInterface({ input: child.stdout }).on("line", line => {
    let event: any;
    try { event = JSON.parse(line); } catch { return; }
    events.push(event);
    if (event.type === "response") {
      const waiter = pending.get(event.id);
      if (waiter) {
        pending.delete(event.id);
        clearTimeout(waiter.timer);
        if (event.success) waiter.resolve(event);
        else waiter.reject(new Error(JSON.stringify(event)));
      }
    }
    if (event.type === "extension_ui_request") {
      if (event.method === "confirm") send({ type: "extension_ui_response", id: event.id, confirmed: confirm });
      if (event.method === "select") send({ type: "extension_ui_response", id: event.id,
        ...(selection ? { value: event.options.find((item: string) => item.includes(selection!)) } : { cancelled: true }) });
      if (event.method === "input") send({ type: "extension_ui_response", id: event.id,
        ...(input ? { value: input } : { cancelled: true }) });
    }
  });
  child.on("exit", code => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`Pi exited ${code}: ${stderr}`));
    }
    pending.clear();
  });
  async function request(type: string, values: Record<string, unknown> = {}) {
    const id = `req_${++counter}`;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`RPC timeout: ${type}, ${stderr}, ${JSON.stringify(events.slice(-5))}`));
      }, 15_000);
      pending.set(id, { resolve, reject, timer });
      send({ id, type, ...values });
    });
  }
  async function run(calls: unknown[], repeat = false) {
    const start = events.length;
    await request("prompt", { message: JSON.stringify({ calls, repeat }) });
    const until = Date.now() + 15_000;
    while (Date.now() < until) {
      const state = await request("get_state");
      if (!state.data.isStreaming) return events.slice(start);
      await delay(20);
    }
    throw new Error("Agent did not settle: " + JSON.stringify(events.slice(-5)));
  }
  return {
    events, request, run,
    confirm(value: boolean) { confirm = value; },
    input(value: string | undefined) { input = value; },
    select(value: string | undefined) { selection = value; },
    command(message: string) { return request("prompt", { message }); },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill("SIGTERM"); });
    },
  };
}

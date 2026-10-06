import { createServer, type ServerResponse } from "node:http";
import { zstdDecompressSync, gunzipSync } from "node:zlib";

export type ReviewBehavior = "allow" | "deny" | "malformed" | "timeout" | "tool-call";
export interface PlannedCall { name: string; arguments: Record<string, unknown> }

export async function startMock() {
  let behavior: ReviewBehavior = "allow";
  let denyTool: string | undefined;
  const reviews: Array<{ model: string; body: any }> = [];
  const requests: any[] = [];
  const emit = (res: ServerResponse, body: unknown) => res.write(`data: ${JSON.stringify(body)}\n\n`);
  function respondChat(res: ServerResponse, text: string, calls?: PlannedCall[]) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const delta: any = { role: "assistant", content: text };
    if (calls) delta.tool_calls = calls.map((call, index) => ({
      index, id: `call_${requests.length}_${index}`, type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    }));
    emit(res, { id: "mock", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] });
    emit(res, { id: "mock", object: "chat.completion.chunk", choices: [{
      index: 0, delta: {}, finish_reason: calls ? "tool_calls" : "stop",
    }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
    res.end("data: [DONE]\n\n");
  }
  function respondResponses(res: ServerResponse, text: string, calls?: PlannedCall[]) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    emit(res, { type: "response.created", response: { id: "resp_mock", status: "in_progress", output: [] } });
    const output: any[] = [];
    if (calls) calls.forEach((call, index) => {
      const item = { id: `fc_${index}`, type: "function_call", call_id: `call_${requests.length}_${index}`,
        name: call.name, arguments: "", status: "in_progress" };
      emit(res, { type: "response.output_item.added", output_index: index, item });
      const args = JSON.stringify(call.arguments);
      emit(res, { type: "response.function_call_arguments.delta", item_id: item.id, output_index: index, delta: args });
      const done = { ...item, arguments: args, status: "completed" };
      emit(res, { type: "response.output_item.done", output_index: index, item: done });
      output.push(done);
    });
    else {
      const item = { id: "msg_mock", type: "message", role: "assistant", status: "in_progress", content: [] };
      emit(res, { type: "response.output_item.added", output_index: 0, item });
      emit(res, { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0,
        part: { type: "output_text", text: "", annotations: [] } });
      emit(res, { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text });
      const done = { ...item, status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
      emit(res, { type: "response.output_item.done", output_index: 0, item: done });
      output.push(done);
    }
    emit(res, { type: "response.completed", response: { id: "resp_mock", status: "completed", output,
      usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } });
    res.end();
  }
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    let data: Buffer = Buffer.concat(chunks);
    if (!data.length) { res.writeHead(404); res.end(); return; }
    if (req.headers["content-encoding"] === "zstd") data = zstdDecompressSync(data);
    if (req.headers["content-encoding"] === "gzip") data = gunzipSync(data);
    const body = JSON.parse(data.toString());
    requests.push(body);
    const isResponses = !body.messages;
    const messages = body.messages ?? body.input;
    const render = (content: any) => typeof content === "string" ? content :
      (content ?? []).map((block: any) => block.text ?? "").join("\n");
    const users = messages.filter((message: any) => message.role === "user");
    const lastUser = users.at(-1);
    const userText = render(lastUser?.content);
    const isReview = body.model === "reviewer" || body.model === "codex-auto-review";
    if (isReview) {
      reviews.push({ model: body.model, body });
      if (behavior === "timeout") return;
      const text = behavior === "malformed" ? "not JSON" :
        JSON.stringify({ decision: behavior === "deny" || JSON.parse(userText).proposedAction?.tool === denyTool
          ? "deny" : "allow", reason: "mock reviewer decision" });
      const calls = behavior === "tool-call" ? [{ name: "bash", arguments: { command: "exit 0" } }] : undefined;
      (isResponses ? respondResponses : respondChat)(res, text, calls);
      return;
    }
    const fixture = JSON.parse(userText);
    const index = messages.indexOf(lastUser);
    const toolResults = messages.slice(index + 1).filter((message: any) =>
      message.role === "tool" || message.type === "function_call_output");
    const calls = fixture.repeat || toolResults.length === 0 ? fixture.calls : undefined;
    (isResponses ? respondResponses : respondChat)(res, calls ? "" : "done", calls);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing listen address");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    reviews, requests,
    setBehavior(value: ReviewBehavior) { behavior = value; },
    denyTool(value: string | undefined) { denyTool = value; },
    close() { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

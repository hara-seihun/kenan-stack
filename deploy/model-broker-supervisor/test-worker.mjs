// One broker generation for restart.test.mjs: the real broker (BROKER_DIST) with its upstream
// replaced by a stub that streams an Anthropic message over STREAM_MS.
import { readFileSync } from "node:fs";
import cluster from "node:cluster";
const dist = process.env.BROKER_DIST;
const { createModelBroker } = await import(`${dist}/model-broker.js`);
const { ModelAvailabilityStore } = await import(`${dist}/threads/model-availability.js`);

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const streamMs = Number(process.env.STREAM_MS);
const generation = `${process.env.BROKER_TAG ?? ""}${process.env.KENAN_BROKER_GENERATION}`;
const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

const transport = async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(sse("message_start", { message: { id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], usage: { input_tokens: 1, output_tokens: 0 } } })));
      for (let i = 0; i < 5; i++) {
        await new Promise(resolve => setTimeout(resolve, streamMs / 5));
        controller.enqueue(encoder.encode(sse("ping", {})));
      }
      controller.enqueue(encoder.encode(sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 }, generation })));
      controller.enqueue(encoder.encode(sse("message_stop", {})));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
};

const broker = createModelBroker(config, new ModelAvailabilityStore(process.env.AVAILABILITY_PATH), transport);
await broker.listen();
process.once("SIGTERM", async () => { await broker.close(); cluster.worker.disconnect(); });

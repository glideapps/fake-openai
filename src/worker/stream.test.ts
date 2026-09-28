import { expect, it, vi } from "vitest";

const append = vi.hoisted(() => vi.fn());
vi.mock("./store.js", () => ({ appendRequestEvent: append }));
import { buildEventStream } from "./stream.js";

it("finishes a valid model stream when diagnostic event logging fails", async () => {
  const logged: string[] = [];
  append.mockReset().mockImplementation(async (_id: number, _seq: number, data: { type: string }) => {
    if (data.type === "response.output_item.added") throw new Error("D1 insert failed");
    logged.push(data.type);
  });
  const onFinalize = vi.fn(async () => {});
  const body = await new Response(buildEventStream(
    [
      { data: { type: "response.created" } },
      { data: { type: "response.output_item.added" } },
      { data: { type: "response.completed" } },
    ],
    { logId: 1, onFinalize },
  )).text();
  expect(body).toContain('"type":"response.completed"');
  expect(logged).toEqual(["response.created"]);
  expect(onFinalize).toHaveBeenCalledWith(false, "event_log_failed");
});

it("does not turn failed finalization into a stream failure", async () => {
  append.mockReset().mockResolvedValue(undefined);
  const onFinalize = vi.fn(async () => { throw new Error("D1 unavailable"); });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const body = await new Response(buildEventStream(
    [{ data: { type: "response.created" } }, { data: { type: "response.completed" } }],
    { logId: 3, onFinalize },
  )).text();
  expect(body).toContain('"type":"response.completed"');
  expect(onFinalize).toHaveBeenCalledTimes(1);
  expect(error).toHaveBeenCalledWith("Failed to finalize request log 3");
  error.mockRestore();
});

it("keeps request cancellation distinct from failed diagnostic writes", async () => {
  const abort = new AbortController();
  append.mockReset().mockImplementationOnce(async () => abort.abort());
  const onFinalize = vi.fn(async () => {});
  const body = await new Response(buildEventStream(
    [{ data: { type: "response.created" } }, { data: { type: "response.completed" } }],
    { logId: 2, signal: abort.signal, onFinalize },
  )).text();
  expect(body).not.toContain('"type":"response.completed"');
  expect(onFinalize).toHaveBeenCalledWith(true, undefined);
});

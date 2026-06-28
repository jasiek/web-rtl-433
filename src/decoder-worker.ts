/// <reference lib="webworker" />
// Decoder worker: runs rtl_433 (compiled to WebAssembly) and feeds it a
// continuous CU8 IQ stream pulled from the shared ring buffer. rtl_433 reads
// "stdin" (-r -), which we back with a custom blocking Emscripten device that
// reads from the ring buffer. Decoded JSON events are posted back to the page.

import { RingConsumer } from "./ring-buffer";

export type WorkerInbound = { type: "start"; sab: SharedArrayBuffer; sampleRate: number };
export type WorkerOutbound =
  | { type: "ready" }
  | { type: "event"; payload: Record<string, unknown> }
  | { type: "log"; line: string }
  | { type: "fatal"; message: string };

const post = (m: WorkerOutbound) => (self as DedicatedWorkerGlobalScope).postMessage(m);

async function start(sab: SharedArrayBuffer, sampleRate: number) {
  const ring = new RingConsumer(sab);

  // The Emscripten build lives in /public and is served at the site root.
  // Built as a non-literal so the bundler treats it as a runtime asset.
  const wasmGlueUrl = new URL("/rtl_433.js", self.location.origin).href;
  const createRtl433 = (await import(/* @vite-ignore */ wasmGlueUrl)).default as (
    opts: Record<string, unknown>,
  ) => Promise<any>;

  const mod = await createRtl433({
    noInitialRun: true,
    print: (line: string) => {
      const s = line.trim();
      if (!s) return;
      try {
        post({ type: "event", payload: JSON.parse(s) });
      } catch {
        post({ type: "log", line: s });
      }
    },
    printErr: (line: string) => post({ type: "log", line }),
  });

  const FS = mod.FS;

  // Install a custom character device whose read() blocks on the ring buffer,
  // then point fd 0 (stdin) at it so rtl_433's `-r -` reads our live stream.
  const dev = FS.makedev(64, 200);
  FS.registerDevice(dev, {
    open() {},
    close() {},
    read(_stream: unknown, buffer: Int8Array, offset: number, length: number) {
      return ring.readBlocking(buffer, offset, length);
    },
  });
  FS.mkdev("/dev/sdrin", dev);
  if (FS.streams[0]) FS.close(FS.streams[0]);
  FS.open("/dev/sdrin", 0 /* O_RDONLY */);

  post({ type: "ready" });

  // Blocks forever, decoding the stream. Runs on the worker thread so blocking
  // is fine. JSON events surface asynchronously through the print handler above.
  try {
    mod.callMain(["-r", "-", "-s", String(sampleRate), "-F", "json"]);
  } catch (e: any) {
    // callMain only returns on stream EOF, which never happens for us.
    post({ type: "fatal", message: `rtl_433 exited: ${e?.message ?? e}` });
  }
}

self.onmessage = (ev: MessageEvent<WorkerInbound>) => {
  if (ev.data.type === "start") {
    start(ev.data.sab, ev.data.sampleRate).catch((e) =>
      post({ type: "fatal", message: String(e?.stack ?? e) }),
    );
  }
};

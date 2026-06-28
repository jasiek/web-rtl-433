/// <reference lib="webworker" />
// Decoder worker: runs rtl_433 (compiled to WebAssembly) and feeds it a
// continuous CU8 IQ stream pulled from the shared ring buffer. rtl_433 reads
// "stdin" (-r -), which we back with a custom blocking Emscripten device that
// reads from the ring buffer. Decoded JSON events are posted back to the page.
//
// Important constraint: rtl_433's main loop never returns, so this worker thread
// is permanently inside callMain(). Timers and incoming messages never run --
// the ONLY JS that executes is the synchronous callbacks wasm invokes (print,
// and the device read). So we batch decoded events and flush them from the read
// callback, which fires constantly as samples are consumed. This keeps the
// per-event postMessage cost from throttling the consumer below the sample rate
// (which would back up the ring buffer and drop samples, breaking demod).

import { RingConsumer } from "./ring-buffer";

export type WorkerInbound = {
  type: "start";
  sab: SharedArrayBuffer;
  sampleRate: number;
  verbose?: boolean;
};
export type WorkerOutbound =
  | { type: "ready" }
  | { type: "events"; payload: Record<string, unknown>[] }
  | { type: "log"; lines: string[] }
  | { type: "fatal"; message: string };

const post = (m: WorkerOutbound) => (self as DedicatedWorkerGlobalScope).postMessage(m);

async function start(sab: SharedArrayBuffer, sampleRate: number, verbose: boolean) {
  const ring = new RingConsumer(sab);

  // Batches flushed from the read callback (see file header).
  let pendingEvents: Record<string, unknown>[] = [];
  let pendingLogs: string[] = [];
  function flush() {
    if (pendingEvents.length) {
      post({ type: "events", payload: pendingEvents });
      pendingEvents = [];
    }
    if (pendingLogs.length) {
      post({ type: "log", lines: pendingLogs });
      pendingLogs = [];
    }
  }

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
        pendingEvents.push(JSON.parse(s));
      } catch {
        pendingLogs.push(s);
      }
    },
    printErr: (line: string) => pendingLogs.push(line),
  });

  const FS = mod.FS;

  // Install a custom character device whose read() blocks on the ring buffer,
  // then point fd 0 (stdin) at it so rtl_433's `-r -` reads our live stream.
  const dev = FS.makedev(64, 200);
  FS.registerDevice(dev, {
    open() {},
    close() {},
    read(_stream: unknown, buffer: Int8Array, offset: number, length: number) {
      // Flush any decoded events/logs accumulated since the last read before we
      // (potentially) block waiting for more samples.
      flush();
      return ring.readBlocking(buffer, offset, length);
    },
  });
  FS.mkdev("/dev/sdrin", dev);
  if (FS.streams[0]) FS.close(FS.streams[0]);
  FS.open("/dev/sdrin", 0 /* O_RDONLY */);

  post({ type: "ready" });

  // Base args: read CU8 from our stdin device, emit JSON. Verbose mode adds the
  // pulse analyzer and periodic noise reports to diagnose whether signal is
  // actually reaching the decoder.
  const args = ["-r", "-", "-s", String(sampleRate), "-F", "json"];
  if (verbose) args.push("-A", "-M", "level", "-M", "noise:5");

  try {
    mod.callMain(args);
  } catch (e: any) {
    // callMain only returns on stream EOF, which never happens for us.
    flush();
    post({ type: "fatal", message: `rtl_433 exited: ${e?.message ?? e}` });
  }
}

self.onmessage = (ev: MessageEvent<WorkerInbound>) => {
  if (ev.data.type === "start") {
    start(ev.data.sab, ev.data.sampleRate, ev.data.verbose ?? false).catch((e) =>
      post({ type: "fatal", message: String(e?.stack ?? e) }),
    );
  }
};

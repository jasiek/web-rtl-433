// Runs rtl_433 (compiled to WebAssembly with JSPI) directly on the main thread,
// feeding it a continuous CU8 IQ stream pulled from the in-thread sample queue.
//
// rtl_433 reads "stdin" (-r -); the wasm build replaces that blocking fread with
// a suspending host read (EM_ASYNC_JS -> Module.rtl433ReadStdin, see
// wasm/stdin-async.patch). Because JSPI suspends the wasm stack on each empty
// read and yields back to the event loop, the SDR pump and the UI keep running
// even though rtl_433's main loop "never returns" -- no Web Worker, no
// SharedArrayBuffer, no Atomics required.
//
// Decoded JSON events are batched and flushed around each read (the natural
// suspend point) so the table updates smoothly without a callback per event.

import type { SampleQueue } from "./sample-queue";

export interface DecoderCallbacks {
  onEvents: (events: Record<string, unknown>[]) => void;
  onLog: (lines: string[]) => void;
  onReady: () => void;
  onExit: (message: string) => void;
}

export interface DecoderHandle {
  /** Resolves when rtl_433's main loop exits (after the queue is closed). */
  done: Promise<void>;
}

export async function runDecoder(
  queue: SampleQueue,
  sampleRate: number,
  verbose: boolean,
  cb: DecoderCallbacks,
): Promise<DecoderHandle> {
  let pendingEvents: Record<string, unknown>[] = [];
  let pendingLogs: string[] = [];
  function flush() {
    if (pendingEvents.length) {
      cb.onEvents(pendingEvents);
      pendingEvents = [];
    }
    if (pendingLogs.length) {
      cb.onLog(pendingLogs);
      pendingLogs = [];
    }
  }

  // The Emscripten build lives in /public and is served at the site root. Built
  // as a non-literal URL so the bundler treats it as a runtime asset.
  const wasmGlueUrl = new URL("/rtl_433.js", location.origin).href;
  const createRtl433 = (await import(/* @vite-ignore */ wasmGlueUrl)).default as (
    opts: Record<string, unknown>,
  ) => Promise<any>;

  const mod = await createRtl433({
    noInitialRun: true,
    // Invoked from wasm (EM_ASYNC_JS) for each input block. Flush decoded events
    // to the UI before we (potentially) suspend waiting for the next samples.
    rtl433ReadStdin: (len: number) => {
      flush();
      return queue.read(len);
    },
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

  cb.onReady();

  // Read CU8 from our stdin stream, emit JSON. Verbose adds the pulse analyzer
  // and periodic noise reports to confirm signal is reaching the decoder.
  const args = ["-r", "-", "-s", String(sampleRate), "-F", "json"];
  if (verbose) args.push("-A", "-M", "level", "-M", "noise:5");

  // Under JSPI, callMain returns a Promise that resolves when main() returns,
  // which for us happens only once the queue is closed (read -> EOF).
  const done = Promise.resolve(mod.callMain(args))
    .then((code: number) => {
      flush();
      cb.onExit(code ? `rtl_433 exited with code ${code}` : "stopped");
    })
    .catch((e: any) => {
      flush();
      cb.onExit(`rtl_433 error: ${e?.message ?? e}`);
    });

  return { done };
}

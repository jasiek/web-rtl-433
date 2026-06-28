// Page controller: wires the Connect button to the SDR sample pump and the
// decoder worker, and renders decoded events into the table.
import { Sdr } from "./sdr";
import { createRingSAB, RingProducer } from "./ring-buffer";
import type { WorkerInbound, WorkerOutbound } from "./decoder-worker";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  freq: $<HTMLInputElement>("freq"),
  rate: $<HTMLInputElement>("rate"),
  gain: $<HTMLSelectElement>("gain"),
  verbose: $<HTMLInputElement>("verbose"),
  connect: $<HTMLButtonElement>("connect"),
  stop: $<HTMLButtonElement>("stop"),
  record: $<HTMLButtonElement>("record"),
  dot: $<HTMLSpanElement>("dot"),
  statusText: $<HTMLSpanElement>("statusText"),
  count: $<HTMLElement>("count"),
  devices: $<HTMLElement>("devices"),
  overflow: $<HTMLElement>("overflow"),
  rows: $<HTMLTableSectionElement>("rows"),
  log: $<HTMLElement>("log"),
  unsupported: $<HTMLElement>("unsupported"),
};

const RING_CAPACITY = 1 << 23; // 8 MiB: absorbs transient stalls so we never drop samples

const sdr = new Sdr();
let worker: Worker | null = null;
let eventCount = 0;
const seenDevices = new Set<string>();
let active: { centerFrequency: number; sampleRate: number } | null = null;

// --- environment checks ------------------------------------------------------
function checkSupport(): string | null {
  if (typeof SharedArrayBuffer === "undefined" || !self.crossOriginIsolated) {
    return "This page is not cross-origin isolated, so SharedArrayBuffer is unavailable. Serve it with COOP/COEP headers (the dev server already does).";
  }
  if (!("usb" in navigator)) {
    return "WebUSB is not available in this browser. Use a Chromium-based browser (Chrome, Edge) over HTTPS or localhost.";
  }
  return null;
}

// --- status helpers ----------------------------------------------------------
function setStatus(text: string, state: "idle" | "on" | "err") {
  els.statusText.textContent = text;
  els.dot.className = "dot" + (state === "on" ? " on" : state === "err" ? " err" : "");
}

function logLines(lines: string[]) {
  if (!lines.length) return;
  els.log.textContent = (els.log.textContent + "\n" + lines.join("\n"))
    .split("\n")
    .slice(-200)
    .join("\n");
  els.log.scrollTop = els.log.scrollHeight;
}
const logLine = (line: string) => logLines([line]);

// --- rendering ---------------------------------------------------------------
// Keys we never want to show as "readings" (they're shown in dedicated columns
// or are internal/noise).
const HIDDEN_KEYS = new Set(["model", "id", "time", "mic", "subtype", "channel_0"]);

function renderReadings(ev: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(ev)) {
    if (HIDDEN_KEYS.has(k) || v == null) continue;
    let val = typeof v === "number" ? +v.toFixed(2) : String(v);
    parts.push(`${k}=<span>${val}</span>`);
  }
  return parts.join("  ");
}

function addEvents(events: Record<string, unknown>[]) {
  if (!events.length) return;
  if (els.rows.querySelector(".empty")) els.rows.innerHTML = "";

  const now = new Date().toLocaleTimeString();
  const frag = document.createDocumentFragment();
  for (const ev of events) {
    const model = String(ev.model ?? "?");
    const id = ev.id != null ? String(ev.id) : "";
    if (id || model) seenDevices.add(`${model}#${id}`);

    const tr = document.createElement("tr");
    tr.className = "flash";
    tr.innerHTML =
      `<td>${now}</td>` +
      `<td class="model">${model}</td>` +
      `<td>${id}</td>` +
      `<td class="fields">${renderReadings(ev)}</td>`;
    // Newest first: prepend each so the last event in the batch ends up on top.
    frag.insertBefore(tr, frag.firstChild);
  }
  els.rows.prepend(frag);
  while (els.rows.children.length > 200) els.rows.lastElementChild?.remove();

  eventCount += events.length;
  els.count.textContent = String(eventCount);
  els.devices.textContent = String(seenDevices.size);
}

// --- lifecycle ---------------------------------------------------------------
async function connect() {
  const support = checkSupport();
  if (support) {
    setStatus("Unsupported", "err");
    return;
  }

  const centerFrequency = Math.round(parseFloat(els.freq.value) * 1e6);
  const sampleRate = Math.round(parseFloat(els.rate.value) * 1e3);
  // "auto" -> omit gain so the tuner runs its hardware AGC; otherwise fixed dB.
  const gain = els.gain.value === "auto" ? undefined : parseFloat(els.gain.value);

  els.connect.disabled = true;
  setStatus("Requesting device…", "idle");

  let actual: { sampleRate: number; centerFrequency: number };
  try {
    actual = await sdr.connect({ centerFrequency, sampleRate, gain });
  } catch (e: any) {
    setStatus("Connect failed", "err");
    logLine(`connect error: ${e?.message ?? e}`);
    els.connect.disabled = false;
    return;
  }

  // Shared ring buffer + decoder worker.
  const sab = createRingSAB(RING_CAPACITY);
  const producer = new RingProducer(sab);

  worker = new Worker(new URL("./decoder-worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (ev: MessageEvent<WorkerOutbound>) => {
    const m = ev.data;
    if (m.type === "events") addEvents(m.payload);
    else if (m.type === "log") logLines(m.lines);
    else if (m.type === "ready") {
      setStatus(`Listening @ ${(actual.centerFrequency / 1e6).toFixed(3)} MHz`, "on");
      active = actual;
      els.record.disabled = false;
      // Only start pumping once the decoder is actually draining the ring buffer,
      // and flush any samples the dongle buffered during wasm load.
      startPump(producer);
    } else if (m.type === "fatal") {
      setStatus("Decoder error", "err");
      logLine(m.message);
    }
  };
  const startMsg: WorkerInbound = {
    type: "start",
    sab,
    sampleRate: actual.sampleRate,
    verbose: els.verbose.checked,
  };
  worker.postMessage(startMsg);

  els.stop.disabled = false;
  logLine(
    `connected: ${(actual.centerFrequency / 1e6).toFixed(3)} MHz @ ${(actual.sampleRate / 1e3).toFixed(0)} kHz, ` +
      `gain ${gain == null ? "auto (AGC)" : gain.toFixed(1) + " dB"}` +
      (els.verbose.checked ? " [verbose]" : ""),
  );
}

// Started only once the worker reports it's draining the ring (see onmessage).
async function startPump(producer: RingProducer) {
  // Discard samples the dongle buffered while the wasm was loading.
  await sdr.resetBuffer().catch(() => {});
  sdr
    .pump(
      producer,
      (n) => {
        els.overflow.textContent = String(n);
      },
      (warning) => logLine(warning),
    )
    .catch((e) => {
      setStatus("USB read failed", "err");
      logLine(`pump stopped: ${e?.message ?? e}`);
    });
}

async function stop() {
  els.stop.disabled = true;
  els.record.disabled = true;
  await sdr.stop();
  worker?.terminate();
  worker = null;
  active = null;
  setStatus("Stopped", "idle");
  els.connect.disabled = false;
}

// Capture ~6 s of the raw CU8 stream (exactly what the live pipeline feeds the
// decoder) and download it as a .cu8 for offline analysis. The filename encodes
// frequency and rate so rtl_433 auto-detects them on replay.
const RECORD_SECONDS = 6;
async function record() {
  if (!active) return;
  const chunks: Uint8Array[] = [];
  els.record.disabled = true;
  sdr.onSamples = (b) => chunks.push(b.slice()); // copy: the source buffer is reused

  for (let s = RECORD_SECONDS; s > 0; s--) {
    setStatus(`Recording… ${s}s (transmit now)`, "on");
    await new Promise((r) => setTimeout(r, 1000));
  }
  sdr.onSamples = undefined;

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const fMHz = (active.centerFrequency / 1e6).toFixed(2);
  const kHz = Math.round(active.sampleRate / 1e3);
  const name = `capture_${fMHz}M_${kHz}k.cu8`;
  const blob = new Blob(chunks as unknown as BlobPart[], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);

  logLine(`recorded ${(total / 1e6).toFixed(2)} MB -> ${name}`);
  setStatus(`Listening @ ${fMHz} MHz`, "on");
  els.record.disabled = false;
}

// --- init --------------------------------------------------------------------
const support = checkSupport();
if (support) {
  els.unsupported.hidden = false;
  els.unsupported.textContent = support;
  if (!("usb" in navigator)) els.connect.disabled = true;
}
els.connect.addEventListener("click", connect);
els.stop.addEventListener("click", stop);
els.record.addEventListener("click", record);

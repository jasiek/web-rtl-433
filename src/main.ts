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
  connect: $<HTMLButtonElement>("connect"),
  stop: $<HTMLButtonElement>("stop"),
  dot: $<HTMLSpanElement>("dot"),
  statusText: $<HTMLSpanElement>("statusText"),
  count: $<HTMLElement>("count"),
  devices: $<HTMLElement>("devices"),
  overflow: $<HTMLElement>("overflow"),
  rows: $<HTMLTableSectionElement>("rows"),
  log: $<HTMLElement>("log"),
  unsupported: $<HTMLElement>("unsupported"),
};

const RING_CAPACITY = 1 << 20; // 1 MiB: comfortably > rtl_433's 256 KiB read block

const sdr = new Sdr();
let worker: Worker | null = null;
let eventCount = 0;
const seenDevices = new Set<string>();

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

function logLine(line: string) {
  els.log.textContent = (els.log.textContent + "\n" + line).split("\n").slice(-200).join("\n");
  els.log.scrollTop = els.log.scrollHeight;
}

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

function addEvent(ev: Record<string, unknown>) {
  if (els.rows.querySelector(".empty")) els.rows.innerHTML = "";

  const model = String(ev.model ?? "?");
  const id = ev.id != null ? String(ev.id) : "";
  if (id || model) seenDevices.add(`${model}#${id}`);

  const tr = document.createElement("tr");
  tr.className = "flash";
  const now = new Date().toLocaleTimeString();
  tr.innerHTML =
    `<td>${now}</td>` +
    `<td class="model">${model}</td>` +
    `<td>${id}</td>` +
    `<td class="fields">${renderReadings(ev)}</td>`;
  els.rows.prepend(tr);
  while (els.rows.children.length > 200) els.rows.lastElementChild?.remove();

  eventCount++;
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
    if (m.type === "event") addEvent(m.payload);
    else if (m.type === "log") logLine(m.line);
    else if (m.type === "ready") {
      setStatus(`Listening @ ${(actual.centerFrequency / 1e6).toFixed(3)} MHz`, "on");
    } else if (m.type === "fatal") {
      setStatus("Decoder error", "err");
      logLine(m.message);
    }
  };
  const startMsg: WorkerInbound = { type: "start", sab, sampleRate: actual.sampleRate };
  worker.postMessage(startMsg);

  els.stop.disabled = false;
  logLine(
    `connected: ${(actual.centerFrequency / 1e6).toFixed(3)} MHz @ ${(actual.sampleRate / 1e3).toFixed(0)} kHz, ` +
      `gain ${gain == null ? "auto (AGC)" : gain.toFixed(1) + " dB"}`,
  );

  // Pump samples from the SDR into the ring buffer until stopped.
  sdr
    .pump(producer, (n) => {
      els.overflow.textContent = String(n);
    })
    .catch((e) => logLine(`pump stopped: ${e?.message ?? e}`));
}

async function stop() {
  els.stop.disabled = true;
  await sdr.stop();
  worker?.terminate();
  worker = null;
  setStatus("Stopped", "idle");
  els.connect.disabled = false;
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

// Thin wrapper around rtlsdrjs: request an RTL-SDR over WebUSB, tune it, and
// pump raw CU8 IQ samples into the sample queue for the in-thread decoder.
import RtlSdr from "rtlsdrjs";
import type { RtlSdrDevice } from "rtlsdrjs";

/** Where pumped samples go: satisfied by SampleQueue. */
export interface SampleSink {
  push(bytes: Uint8Array): void;
  overflows(): number;
}

export interface SdrOptions {
  centerFrequency: number; // Hz
  sampleRate: number; // Hz
  gain?: number; // dB; omit for auto gain
  ppm?: number;
}

// Samples requested per WebUSB bulk read. 16384 IQ pairs == 32 KiB, a good
// balance between USB overhead and latency at 250 kHz.
const SAMPLES_PER_READ = 16 * 1024;

// How many back-to-back USB read failures to tolerate before giving up. A
// handful of transient transferIn errors is normal; sustained failure is not.
const MAX_CONSECUTIVE_USB_ERRORS = 10;

export class Sdr {
  private device: RtlSdrDevice | null = null;
  private running = false;

  /** Optional tap on the raw CU8 stream, used for diagnostic recording. */
  onSamples: ((bytes: Uint8Array) => void) | undefined;

  /** Must be called from a user gesture (WebUSB requires transient activation). */
  async connect(opts: SdrOptions): Promise<{ sampleRate: number; centerFrequency: number }> {
    const device = await RtlSdr.requestDevice();
    await device.open({ ppm: opts.ppm ?? 0, ...(opts.gain != null ? { gain: opts.gain } : {}) });
    const sampleRate = await device.setSampleRate(opts.sampleRate);
    const centerFrequency = await device.setCenterFrequency(opts.centerFrequency);
    await device.resetBuffer();
    this.device = device;
    return { sampleRate, centerFrequency };
  }

  /** Continuously read samples and feed them to the ring buffer until stopped. */
  async pump(
    sink: SampleSink,
    onOverflow?: (count: number) => void,
    onWarn?: (message: string) => void,
  ): Promise<void> {
    if (!this.device) throw new Error("SDR not connected");
    this.running = true;
    let lastOverflow = 0;
    let consecutiveErrors = 0;
    while (this.running) {
      let buf: ArrayBuffer;
      try {
        buf = await this.device.readSamples(SAMPLES_PER_READ);
        consecutiveErrors = 0;
      } catch (e: any) {
        if (!this.running) break;
        // transferIn errors are usually transient USB hiccups. Recover by
        // resetting the device buffer and retrying; only give up if they
        // persist, which points at a real problem (unplugged, contention).
        consecutiveErrors++;
        if (consecutiveErrors > MAX_CONSECUTIVE_USB_ERRORS) throw e;
        onWarn?.(`USB read error (retry ${consecutiveErrors}): ${e?.message ?? e}`);
        await this.device.resetBuffer().catch(() => {});
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      if (!this.running) break;
      const bytes = new Uint8Array(buf);
      sink.push(bytes);
      this.onSamples?.(bytes);
      const o = sink.overflows();
      if (o !== lastOverflow) {
        lastOverflow = o;
        onOverflow?.(o);
      }
    }
  }

  async setCenterFrequency(freq: number): Promise<number> {
    if (!this.device) throw new Error("SDR not connected");
    return this.device.setCenterFrequency(freq);
  }

  async resetBuffer(): Promise<void> {
    if (!this.device) throw new Error("SDR not connected");
    return this.device.resetBuffer();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.device) {
      await this.device.close().catch(() => {});
      this.device = null;
    }
  }

  get connected(): boolean {
    return this.device !== null;
  }
}

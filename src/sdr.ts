// Thin wrapper around rtlsdrjs: request an RTL-SDR over WebUSB, tune it, and
// pump raw CU8 IQ samples into the shared ring buffer for the decoder worker.
import RtlSdr from "rtlsdrjs";
import type { RtlSdrDevice } from "rtlsdrjs";
import { RingProducer } from "./ring-buffer";

export interface SdrOptions {
  centerFrequency: number; // Hz
  sampleRate: number; // Hz
  gain?: number; // dB; omit for auto gain
  ppm?: number;
}

// Samples requested per WebUSB bulk read. 16384 IQ pairs == 32 KiB, a good
// balance between USB overhead and latency at 250 kHz.
const SAMPLES_PER_READ = 16 * 1024;

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
  async pump(producer: RingProducer, onOverflow?: (count: number) => void): Promise<void> {
    if (!this.device) throw new Error("SDR not connected");
    this.running = true;
    let lastOverflow = 0;
    while (this.running) {
      const buf = await this.device.readSamples(SAMPLES_PER_READ);
      if (!this.running) break;
      const bytes = new Uint8Array(buf);
      producer.push(bytes);
      this.onSamples?.(bytes);
      const o = producer.overflows();
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

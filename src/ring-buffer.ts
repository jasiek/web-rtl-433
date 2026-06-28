// A single-producer / single-consumer byte ring buffer backed by a
// SharedArrayBuffer, so the main thread (SDR sample pump) can hand raw CU8 IQ
// samples to the decoder Web Worker without copying through postMessage.
//
// The producer (main thread) never blocks: if the consumer falls behind and the
// buffer fills, the incoming chunk is dropped and an overflow counter bumped.
// The consumer (worker) blocks via Atomics.wait until bytes are available, which
// is exactly what rtl_433's blocking fread() on stdin needs.

const CTRL_LEN = 4; // Int32 slots
const WRITE = 0; // total bytes written (monotonic, wraps via modulo into data)
const READ = 1; // total bytes read (monotonic)
const OVERFLOW = 2; // count of dropped chunks
const CTRL_BYTES = CTRL_LEN * 4;

export function createRingSAB(capacity: number): SharedArrayBuffer {
  return new SharedArrayBuffer(CTRL_BYTES + capacity);
}

abstract class Ring {
  protected ctrl: Int32Array;
  protected data: Uint8Array;
  protected capacity: number;

  constructor(sab: SharedArrayBuffer) {
    this.ctrl = new Int32Array(sab, 0, CTRL_LEN);
    this.data = new Uint8Array(sab, CTRL_BYTES);
    this.capacity = this.data.length;
  }
}

export class RingProducer extends Ring {
  /** Push bytes; returns false (and counts an overflow) if they don't fit. */
  push(bytes: Uint8Array): boolean {
    const w = Atomics.load(this.ctrl, WRITE);
    const r = Atomics.load(this.ctrl, READ);
    const free = this.capacity - (w - r);
    if (bytes.length > free) {
      Atomics.add(this.ctrl, OVERFLOW, 1);
      return false;
    }
    const off = w % this.capacity;
    const first = Math.min(bytes.length, this.capacity - off);
    this.data.set(bytes.subarray(0, first), off);
    if (first < bytes.length) this.data.set(bytes.subarray(first), 0);
    Atomics.add(this.ctrl, WRITE, bytes.length);
    Atomics.notify(this.ctrl, WRITE);
    return true;
  }

  overflows(): number {
    return Atomics.load(this.ctrl, OVERFLOW);
  }
}

export class RingConsumer extends Ring {
  /**
   * Copy up to `length` bytes into `dst` at `dstOffset`, blocking until at least
   * one byte is available. Returns the number of bytes copied (always > 0).
   * `dst` is the live wasm heap view passed by Emscripten's device read op.
   */
  readBlocking(dst: Uint8Array | Int8Array, dstOffset: number, length: number): number {
    for (;;) {
      const w = Atomics.load(this.ctrl, WRITE);
      const r = Atomics.load(this.ctrl, READ);
      const avail = w - r;
      if (avail > 0) {
        const n = Math.min(avail, length);
        const off = r % this.capacity;
        const first = Math.min(n, this.capacity - off);
        // Copy with wraparound. Int8Array.set coerces but preserves the byte.
        (dst as Uint8Array).set(this.data.subarray(off, off + first), dstOffset);
        if (first < n) {
          (dst as Uint8Array).set(this.data.subarray(0, n - first), dstOffset + first);
        }
        Atomics.add(this.ctrl, READ, n);
        return n;
      }
      // Nothing buffered: wait until the producer advances WRITE.
      Atomics.wait(this.ctrl, WRITE, w);
    }
  }
}

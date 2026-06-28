# web-rtl-433

Decode 433.92 MHz ISM-band devices (weather stations, TPMS, remotes, sensors…)
straight from an [RTL-SDR](https://www.rtl-sdr.com/) USB dongle **in your
browser** — no native install. It connects to the dongle over **WebUSB** and runs
the real [`rtl_433`](https://github.com/merbanan/rtl_433) decoder, compiled to
**WebAssembly**, so you get parity with all ~250 upstream device protocols.

## How it works

```
 ┌─────────────┐  WebUSB   ┌────────────────────┐  SharedArrayBuffer  ┌──────────────────────┐
 │  RTL-SDR    │ ────────▶ │  main thread        │  ring buffer (CU8)  │  Web Worker          │
 │  (RTL2832U) │  CU8 IQ   │  rtlsdrjs sample    │ ──────────────────▶ │  rtl_433.wasm        │
 └─────────────┘           │  pump @ 433.92 MHz  │                     │  reads "stdin" (-r -)│
                           └────────────────────┘                     │  emits JSON events   │
                                      ▲                                └──────────┬───────────┘
                                      │            decoded events (postMessage)   │
                                      └───────────────────────────────────────────┘
```

- **WebUSB → samples:** [`rtlsdrjs`](https://github.com/sandeepmistry/rtlsdrjs)
  (vendored) programs the RTL2832U and reads raw 8-bit IQ samples (CU8) — exactly
  the format `rtl_433` wants, no conversion.
- **Transport:** a `SharedArrayBuffer` ring buffer hands samples to the worker.
  The producer (main thread) never blocks; the consumer (worker) blocks on
  `Atomics.wait`, which is what `rtl_433`'s blocking `fread()` needs.
- **Decode:** upstream `rtl_433` is built with Emscripten (`-DENABLE_RTLSDR=OFF
  -DENABLE_SOAPYSDR=OFF`, file-input only). A custom Emscripten character device
  feeds the ring buffer to `rtl_433 -r - -F json`; decoded events come back as
  JSON on stdout and are posted to the page.

## Requirements

- A **Chromium-based browser** (Chrome / Edge) — WebUSB is not in Firefox/Safari.
- An RTL-SDR (RTL2832U) dongle, e.g. RTL-SDR Blog v3/v4.
- On Linux you may need a udev rule / to detach the `dvb_usb_rtl28xxu` kernel
  module so the browser can claim the device.

## Setup

```bash
git clone --recurse-submodules <this repo>
cd web-rtl-433
npm install

# Build rtl_433 -> WebAssembly (needs the Emscripten SDK; either have `emcc` on
# PATH or set EMSDK to your emsdk checkout):
npm run build:wasm

npm run dev          # open the printed localhost URL
```

Click **Connect SDR**, pick your dongle in the browser prompt, and decoded
devices stream into the table. Tune to other ISM bands (315/868/915 MHz) by
changing the frequency field.

> The dev/preview servers send `Cross-Origin-Opener-Policy` and
> `Cross-Origin-Embedder-Policy` headers so `SharedArrayBuffer` works. Any host
> you deploy to must send the same headers.

## Layout

| Path                    | What                                                          |
| ----------------------- | ------------------------------------------------------------ |
| `wasm/build.sh`         | Compiles `vendor/rtl_433` to `public/rtl_433.{js,wasm}`       |
| `src/sdr.ts`            | WebUSB sample pump (wraps `rtlsdrjs`)                         |
| `src/ring-buffer.ts`    | SharedArrayBuffer SPSC ring buffer                           |
| `src/decoder-worker.ts` | Loads the wasm, feeds it the stream, surfaces JSON events    |
| `src/main.ts`           | UI + lifecycle                                                |
| `vendor/rtl_433`        | upstream decoder (submodule)                                  |
| `vendor/rtlsdrjs`       | WebUSB RTL2832U driver (submodule)                            |

## Credits

Built on [`rtl_433`](https://github.com/merbanan/rtl_433) by Benjamin Larsson &
contributors, and [`rtlsdrjs`](https://github.com/sandeepmistry/rtlsdrjs) by
Sandeep Mistry.

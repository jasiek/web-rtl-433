# web-rtl-433

Decode 433.92 MHz ISM-band devices (weather stations, TPMS, remotes, sensors…)
straight from an [RTL-SDR](https://www.rtl-sdr.com/) USB dongle **in your
browser** — no native install. It connects to the dongle over **WebUSB** and runs
the real [`rtl_433`](https://github.com/merbanan/rtl_433) decoder, compiled to
**WebAssembly**, so you get parity with all ~250 upstream device protocols.

## How it works

```
 ┌─────────────┐  WebUSB   ┌─────────────────────────────────────────────────────┐
 │  RTL-SDR    │ ────────▶ │  main thread                                        │
 │  (RTL2832U) │  CU8 IQ   │  rtlsdrjs pump ─push─▶ SampleQueue ─read─▶ rtl_433.wasm
 └─────────────┘           │  @ 433.92 MHz          (in-thread)    (JSPI suspend) │
                           │                                        emits JSON ───┘
                           └─────────────────────────────────────────────────────┘
```

Everything runs on the **main thread** — no Web Worker, no `SharedArrayBuffer`,
no cross-origin isolation.

- **WebUSB → samples:** [`rtlsdrjs`](https://github.com/sandeepmistry/rtlsdrjs)
  (vendored) programs the RTL2832U and reads raw 8-bit IQ samples (CU8) — exactly
  the format `rtl_433` wants, no conversion.
- **Transport:** a plain in-thread async byte queue (`src/sample-queue.ts`) hands
  samples to the decoder. The pump never blocks; the decoder's `read()` resolves
  synchronously when bytes are buffered, or returns a Promise when the queue is
  empty.
- **Decode:** upstream `rtl_433` is built with Emscripten (`-DENABLE_RTLSDR=OFF
  -DENABLE_SOAPYSDR=OFF`, file-input only) **plus JSPI** (`-sJSPI`). A small patch
  (`wasm/stdin-async.patch`) replaces the blocking `fread()` on stdin with a
  suspending host read: when the queue is empty the wasm stack suspends and yields
  to the event loop (so the USB pump and UI keep running), then resumes when the
  next samples arrive. `rtl_433`'s main loop "never returns" yet nothing blocks.
  Decoded events come back as JSON on stdout and render straight into the table.

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

> No special hosting headers are required — the decoder uses JSPI on the main
> thread, so there's no `SharedArrayBuffer` and no need for `COOP`/`COEP` or
> cross-origin isolation. The browser must support WebAssembly **JSPI** (stack
> switching), which ships in current Chromium (Chrome/Edge 137+).

## Deploy to GitHub Pages

The repo ships a workflow (`.github/workflows/deploy.yml`) that builds the wasm
with Emscripten in CI and publishes `dist/` to Pages. To wire it up:

1. **Push the repo to GitHub.**
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. **Custom domain:** the site is configured for `web-rtl-433.jasiek.me` via
   `public/CNAME`. Add a DNS record in the `jasiek.me` zone:
   ```
   CNAME   web-rtl-433   <your-github-username>.github.io
   ```
   Then in Settings → Pages set the custom domain and enable **Enforce HTTPS**
   (WebUSB requires HTTPS; the custom domain gets a free certificate).
4. Push to `main`/`master` — the Action builds and deploys automatically.

**No special headers needed:** because there's no `SharedArrayBuffer`, the site
needs no `COOP`/`COEP` headers or cross-origin isolation, so it works on GitHub
Pages (or any static host) as-is — just serve over HTTPS for WebUSB.

## Layout

| Path                    | What                                                          |
| ----------------------- | ------------------------------------------------------------ |
| `wasm/build.sh`          | Compiles `vendor/rtl_433` to `public/rtl_433.{js,wasm}` (JSPI) |
| `wasm/stdin-async.patch` | Makes rtl_433's stdin read suspend instead of blocking        |
| `src/sdr.ts`             | WebUSB sample pump (wraps `rtlsdrjs`)                          |
| `src/sample-queue.ts`    | In-thread async byte queue (SDR → decoder)                    |
| `src/decoder.ts`         | Loads the wasm, feeds it the stream, surfaces JSON events     |
| `src/main.ts`            | UI + lifecycle                                                 |
| `vendor/rtl_433`         | upstream decoder (submodule)                                   |
| `vendor/rtlsdrjs`        | WebUSB RTL2832U driver (submodule)                            |

## Credits

Built on [`rtl_433`](https://github.com/merbanan/rtl_433) by Benjamin Larsson &
contributors, and [`rtlsdrjs`](https://github.com/sandeepmistry/rtlsdrjs) by
Sandeep Mistry.

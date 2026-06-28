#!/usr/bin/env bash
# Compile upstream rtl_433 (vendor/rtl_433) to WebAssembly.
#
# Output: public/rtl_433.js + public/rtl_433.wasm  (Emscripten module, no auto-run)
#
# Requires the Emscripten SDK. Either have `emcc` on PATH, or set EMSDK to the
# emsdk checkout (this script will source emsdk_env.sh for you).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/vendor/rtl_433"
BUILD="$ROOT/wasm/build"
OUT="$ROOT/public"

# --- locate Emscripten -------------------------------------------------------
if ! command -v emcc >/dev/null 2>&1; then
  if [[ -n "${EMSDK:-}" && -f "$EMSDK/emsdk_env.sh" ]]; then
    # shellcheck disable=SC1091
    source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1
  fi
fi
command -v emcc >/dev/null 2>&1 || { echo "error: emcc not found. Install emsdk and/or set EMSDK." >&2; exit 1; }
echo "Using $(emcc --version | head -1)"

mkdir -p "$OUT"

# --- linker flags ------------------------------------------------------------
# We drive main() ourselves from the worker via callMain(), so don't auto-run.
# A custom stdin stream (ring buffer) feeds CU8 samples; stdout carries JSON.
EM_LDFLAGS=(
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sEXPORT_NAME=createRtl433
  -sINVOKE_RUN=0          # don't run main() on load
  -sEXIT_RUNTIME=0        # keep runtime alive after callMain returns
  -sALLOW_MEMORY_GROWTH=1
  -sFORCE_FILESYSTEM=1    # we install a custom stdin device at runtime
  -sEXPORTED_RUNTIME_METHODS=callMain,FS,stringToNewUTF8,getValue,setValue,HEAPU8
  -sENVIRONMENT=web,worker
  -O2
)

# --- configure & build -------------------------------------------------------
emcmake cmake -S "$SRC" -B "$BUILD" \
  -DCMAKE_BUILD_TYPE=Release \
  -DENABLE_RTLSDR=OFF \
  -DENABLE_SOAPYSDR=OFF \
  -DENABLE_OPENSSL=OFF \
  -DENABLE_THREADS=OFF \
  -DBUILD_TESTING_EXAMPLES=OFF \
  -DCMAKE_EXECUTABLE_SUFFIX=".js" \
  -DCMAKE_EXE_LINKER_FLAGS="${EM_LDFLAGS[*]}"

emmake make -C "$BUILD" rtl_433 -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

# rtl_433 target emits rtl_433.js + rtl_433.wasm into the build's src dir
cp "$BUILD"/src/rtl_433.js "$OUT/rtl_433.js"
cp "$BUILD"/src/rtl_433.wasm "$OUT/rtl_433.wasm"
echo "wrote $OUT/rtl_433.js and $OUT/rtl_433.wasm"

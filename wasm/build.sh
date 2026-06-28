#!/usr/bin/env bash
# Compile upstream rtl_433 (vendor/rtl_433) to WebAssembly.
#
# Output: public/rtl_433.js + public/rtl_433.wasm  (Emscripten module, no auto-run)
#
# Requires the Emscripten SDK, pinned in .tool-versions and managed by asdf
# (`asdf install emsdk`). The script sources the SDK's emsdk_env.sh for you. If
# emcc is already on PATH it's used as-is; a manual checkout works via $EMSDK.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/vendor/rtl_433"
BUILD="$ROOT/wasm/build"
OUT="$ROOT/public"

# --- locate Emscripten -------------------------------------------------------
# Resolve the emsdk install (asdf-managed by default, else a manual $EMSDK).
# emcc shells out to python, so EMSDK_PYTHON must point at the SDK's bundled
# interpreter. We then source the SDK's env unconditionally: this puts the real
# emcc/emcmake binaries ahead of asdf's shims on PATH. The shims matter because
# asdf-emsdk's shim sanitizes the environment, which makes emcmake's `cmake`
# lookup fail; the real binaries don't. Sourcing also keeps emcc and its
# matching wasm-ld self-consistent, avoiding a half-updated checkout's skew.
EMSDK_HOME="${EMSDK:-}"
if [[ -z "$EMSDK_HOME" ]] && command -v asdf >/dev/null 2>&1; then
  EMSDK_HOME="$(asdf where emsdk 2>/dev/null || true)"
fi
if [[ -n "$EMSDK_HOME" ]]; then
  if [[ -z "${EMSDK_PYTHON:-}" ]]; then
    EMSDK_PYTHON="$(ls -d "$EMSDK_HOME"/python/*/bin/python3 2>/dev/null | head -1 || true)"
    [[ -n "$EMSDK_PYTHON" ]] && export EMSDK_PYTHON
  fi
  if [[ -f "$EMSDK_HOME/emsdk_env.sh" ]]; then
    # shellcheck disable=SC1091
    source "$EMSDK_HOME/emsdk_env.sh" >/dev/null 2>&1
  fi
fi
command -v emcc >/dev/null 2>&1 || { echo "error: emcc not found. Run 'asdf install emsdk' (version pinned in .tool-versions) or set EMSDK." >&2; exit 1; }
echo "Using $(emcc --version 2>/dev/null | head -1)"

mkdir -p "$OUT"

# --- apply the async-stdin patch to the vendored submodule -------------------
# Replaces the blocking fread() on stdin with a suspending host read so the
# decoder can run on the main thread with no SharedArrayBuffer (see the patch
# header and src/decoder.ts). Idempotent: skipped if already applied.
PATCH="$ROOT/wasm/stdin-async.patch"
if [[ -f "$PATCH" ]]; then
  if git -C "$SRC" apply --reverse --check "$PATCH" >/dev/null 2>&1; then
    echo "async-stdin patch already applied"
  else
    echo "applying async-stdin patch"
    git -C "$SRC" apply "$PATCH"
  fi
fi

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
  -sJSPI                  # suspend the wasm on the async stdin read (no SAB/worker)
  -sFORCE_FILESYSTEM=1    # rtl_433 still touches the FS for stdin/stdout setup
  -sEXPORTED_RUNTIME_METHODS=callMain,FS,stringToNewUTF8,getValue,setValue,HEAPU8
  -sENVIRONMENT=web
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

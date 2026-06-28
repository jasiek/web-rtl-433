import { defineConfig } from "vite";

// No cross-origin isolation needed: the decoder runs on the main thread and the
// SDR -> decoder hand-off is a plain in-thread queue (no SharedArrayBuffer), so
// COOP/COEP headers and the coi-serviceworker are gone. This also means the site
// works on any static host (e.g. GitHub Pages) with no header configuration.
export default defineConfig({
  // rtlsdrjs is a CommonJS package, vendored (symlinked) outside node_modules.
  // Force CJS interop for it in both dev (esbuild prebundle) and build (Rollup).
  optimizeDeps: {
    include: ["rtlsdrjs"],
  },
  build: {
    commonjsOptions: {
      include: [/node_modules/, /vendor[\\/]rtlsdrjs/],
      transformMixedEsModules: true,
    },
  },
});

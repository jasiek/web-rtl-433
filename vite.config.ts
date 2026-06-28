import { defineConfig } from "vite";

// SharedArrayBuffer (used for the SDR -> decoder ring buffer) requires the page
// to be cross-origin isolated. These headers enable that in dev and preview.
const crossOriginIsolation = {
  name: "cross-origin-isolation",
  configureServer(server: any) {
    server.middlewares.use((_req: any, res: any, next: any) => {
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      next();
    });
  },
};

export default defineConfig({
  plugins: [crossOriginIsolation],
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  worker: {
    format: "es",
  },
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

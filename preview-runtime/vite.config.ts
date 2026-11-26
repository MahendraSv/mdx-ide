import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Built once and shipped as a Tauri resource (`preview/`), served by the
// `mdxpreview://` protocol. Relative base so it works under any scheme/host.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Keep it to one predictable JS + CSS file.
    rollupOptions: { output: { entryFileNames: "runtime.js", assetFileNames: "[name][extname]" } },
  },
});

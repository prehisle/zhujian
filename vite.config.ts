import { defineConfig } from "vite";
import { resolve } from "node:path";

// Tauri expects a fixed dev port and a static `dist` build output.
// Two windows = two HTML entry points: capture (the floating quick-capture
// window) + notebook (the single main window hosting all browse/manage views).
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/target/**"],
    },
  },
  build: {
    outDir: "dist",
    target: "esnext",
    rollupOptions: {
      input: {
        capture: resolve(__dirname, "index.html"),
        notebook: resolve(__dirname, "notebook.html"),
      },
    },
  },
});

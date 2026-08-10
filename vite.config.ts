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
      // 三个独立 crate 的 target 也要忽略(刻意不建 workspace,.gitignore 同名单):
      // 4000+ 个文件对着老内核 inotify 默认上限 8192,`cargo test` 重写 target 时
      // vite 还会白收几千个文件事件——轻则 dev server 卡、重则 watcher 静默降级。
      ignored: [
        "**/src-tauri/target/**",
        "**/core/target/**",
        "**/server/target/**",
        "**/sync-proto/target/**",
      ],
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

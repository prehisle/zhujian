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
      // 每一只独立 crate 的 target 都要忽略(刻意不建 workspace,**与 `.gitignore` 同名单** ——
      // ⛔ 那边加一行,这边就要加一行):4000+ 个文件对着老内核 inotify 默认上限 8192,
      // `cargo test` 重写 target 时 vite 还会白收几千个文件事件——轻则 dev server 卡、
      // 重则 **ENOSPC 当场退出**(484 实测:在 `mobile/` 跑过一次 cargo test 之后,
      // `npm run dev` 起来 0.6 秒就死在 `mobile/target/.fingerprint/…`)。
      // ⚠ 这份名单 465/468 新开两只 crate 时**漏跟**了两行,直到 484 才被撞出来。
      ignored: [
        "**/src-tauri/target/**", // 桌面壳(它也吃掉 android/src-tauri/target)
        "**/core/target/**",
        "**/server/target/**",
        "**/sync-proto/target/**",
        "**/mobile/target/**", // 468/OH-d:两只手机壳共用的 crate
        "**/ohos/src-tauri/target/**", // 465/OH-a:鸿蒙壳
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

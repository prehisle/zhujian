import { defineConfig } from "vite";
import { resolve } from "node:path";

// Tauri expects a fixed dev port and a static `dist` build output.
// Three windows = three HTML entry points: capture (the floating quick-capture
// window) + notebook (the single main window hosting all browse/manage views)
// + lightbox(606 起看大图那层遮罩自己是一只铺满显示器的透明置顶窗;此前它长在
// 主窗的 DOM 上,于是「看起来像全屏」只能靠去动主窗的几何 —— 用户两次否掉了那条路)。
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // 每一只独立 crate 的 target 都要忽略(刻意不建 workspace):4000+ 个文件对着老内核 inotify 默认上限 8192,
      // `cargo test` 重写 target 时 vite 还会白收几千个文件事件——轻则 dev server 卡、
      // 重则 **ENOSPC 当场退出**(484 实测:在 `mobile/` 跑过一次 cargo test 之后,
      // `npm run dev` 起来 0.6 秒就死在 `mobile/target/.fingerprint/…`)。
      // ⚠ 这份名单 465/468 新开两只 crate 时**漏跟**了两行,直到 484 才被撞出来。
      // ⛔⛔ **别指望 `.gitignore` 提醒你**(644 更正:这里原本写着「与 .gitignore 同名单,
      // 那边加一行这边就要加一行」——**607 之后不成立了**,那边改成了 `target/` 通配、
      // 一行就盖住所有 crate ⇒ 新开一只 crate 时那边**什么都不用加**,这条互相提醒的链子
      // 早就断了,而断得很安静)。⇒ **新开一只 crate = 回来这儿手加一行**,判据只有这一条。
      // ⚠ 这份名单**不是**「dev server 该忽略什么」的全集:`.zjshots/` / `.cdp-profile/` /
      // `.ui-shots-profile/` / `dist/` 都在 watch 面里。644 量过:全树 8840 个 watcher 总共
      // 才占 134 MB ⇒ **减 watcher 省不下内存,别为省内存来改这里**(那笔账在 backlog 测试与工装 93)。
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
        lightbox: resolve(__dirname, "lightbox.html"),
      },
    },
  },
});

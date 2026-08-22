import { defineConfig } from "vite";

// 端口钉死 1420(tauri.conf.json devUrl 同值)。
// ⚠ 鸿蒙侧今天**没有 dev 热重载那条路**(没有 `cargo tauri ohos dev`),打包走的是
// 「手写 gen 目录 + hvigorw assembleHap」,前端恒走 `vite build` 出的 dist。
// 这份配置留着是为了与另外两只壳同形,别当它已经通了 dev。
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "0.0.0.0",
    watch: {
      ignored: ["**/src-tauri/target/**"],
    },
  },
});

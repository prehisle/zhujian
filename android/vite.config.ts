import { defineConfig } from "vite";

// 端口钉死 1420(tauri.conf.json devUrl 同值);host 0.0.0.0 供安卓真机 dev 模式
// 从局域网访问 dev server(探针工程同款)。
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "0.0.0.0",
  },
});

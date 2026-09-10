import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { policyAsset } from "../scripts/lib/policy-asset.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// 端口钉死 1420(tauri.conf.json devUrl 同值);host 0.0.0.0 供安卓真机 dev 模式
// 从局域网访问 dev server(探针工程同款)。
export default defineConfig({
  clearScreen: false,
  // 651:把**境外渠道**那一份隐私政策页烤进产物(zhujian.app 下载的包连境外服务器,
  // 政策正文也是境外那一版)。⛔ 别指到 site-cool/ —— 两份正文关于「数据在哪儿」
  // 刻意不同,指错了就是在包里放一份对这只包不成立的政策。
  plugins: [policyAsset(resolve(here, "../site-app/privacy.html"))],
  server: {
    port: 1420,
    strictPort: true,
    host: "0.0.0.0",
    watch: {
      // 本工程自己的 crate target(根工程的 vite 有同款名单,理由见那边注释)。
      ignored: ["**/src-tauri/target/**"],
    },
  },
});

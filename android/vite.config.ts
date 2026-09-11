import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { policyAsset } from "../scripts/lib/policy-asset.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// 668 起安卓自己也有渠道分叉(见 src/channel.ts 头注):默认(不设下面这个变量)
// 编译出的仍是今天在用的境外渠道,零风险;真要出国内商店渠道包才显式置
// `ZJ_ANDROID_CHANNEL=cn`(`node scripts/build-android.mjs --channel-cn` 帮你置)。
const channelCn = process.env.ZJ_ANDROID_CHANNEL === "cn";

/**
 * 国内渠道 seam:把 `./channel` 改指到 `src/channel.cn.ts`。⛔ fail-closed,与
 * `ohos/vite.config.ts` 里那个 `seam()` 同一份纪律(源码见那份文件头注)——
 * 两份导出名对不上就构建期报错,别等运行期在设备上炸出一个 `undefined` 当地址用。
 */
function channelSeamCn(): Plugin {
  const target = resolve(here, "src/channel.cn.ts");
  const source = resolve(here, "src/channel.ts");
  const seamDir = resolve(here, "src");
  const norm = (p: string) => p.replace(/\\/g, "/");
  return {
    name: "zhujian-channel-cn-seam",
    enforce: "pre",
    buildStart() {
      const names = (file: string) =>
        [...readFileSync(file, "utf8").matchAll(/^export (?:async )?(?:function|const|type) (\w+)/gm)]
          .map((m) => m[1])
          .sort();
      const want = names(source);
      const got = names(target);
      if (want.length === 0) this.error(`国内渠道接缝 ${source} 一个导出都没解析到 —— 提取器失灵或文件变了形。`);
      if (want.join(",") !== got.join(",")) {
        const missing = want.filter((n) => !got.includes(n));
        const extra = got.filter((n) => !want.includes(n));
        this.error(
          `国内渠道接缝两份对不上 —— 少了 [${missing}] / 多了 [${extra}]。\n` +
            `  境外那份(真相源) ${source}\n  国内那份 ${target}`,
        );
      }
    },
    resolveId(id, importer) {
      if (id !== "./channel" || !importer) return null;
      return norm(importer).startsWith(norm(seamDir)) ? target : null;
    },
  };
}

// 端口钉死 1420(tauri.conf.json devUrl 同值);host 0.0.0.0 供安卓真机 dev 模式
// 从局域网访问 dev server(探针工程同款)。
export default defineConfig({
  clearScreen: false,
  // 651:把**这条渠道**的隐私政策页烤进产物 —— 境外渠道连境外服务器、政策正文也是
  // 境外那一版;国内渠道包(channelCn)连境内服务器,必须换成 site-cool/ 那份,否则
  // 包里装的是一份对这只包不成立的政策(两份正文关于「数据在哪儿」刻意不同)。
  plugins: [
    policyAsset(resolve(here, channelCn ? "../site-cool/privacy.html" : "../site-app/privacy.html")),
    ...(channelCn ? [channelSeamCn()] : []),
  ],
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

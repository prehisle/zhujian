import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

// 朱简鸿蒙端的前端构建(OH-d/D3 起是**产品前端**,不再是那一页验收面板)。
//
// ⭐⭐ **root 指向 `android/`,不是这个目录** —— 用户 2026-08-23 拍板:两只手机壳
// **共用同一棵前端源码树**(`android/index.html` + `android/src` 那 8.5k 行 TS),
// 鸿蒙这边**一行都不复制**。判据:抄两份的话 UI 每改一次要改两处,而仓里最重的那份
// 复制逻辑今天是 268 行的 filter、还专门配了一道门禁(`check-filter-parity`);
// 8.5k 行没有任何一道门禁守得住。
//
// 两端真正的差别只有一处 —— **平台接缝** `platform.ts`(端专属的 `invoke` 与扫码)。
// 下面那个 resolve 插件把它换掉;其余带原生桥的模块本来就天生降级
// (`theme` / `textsize` 是 `window.__zhujianXxx?.…`,`saf` 是 `hasBridge()`),
// ⛔ 别为它们再加别名。
//
// ⚠ 鸿蒙侧**没有 dev 热重载那条路**(没有 `cargo tauri ohos dev`),恒走 `vite build`
// 出的 dist,再由 cargo 在**编译期**烤进 `.so`。⇒ 改了前端就**别带 `--skip-cargo`**
// (466 真栽:装上去还是旧界面,且不报错)。

const here = dirname(fileURLToPath(import.meta.url));
const androidRoot = resolve(here, "../android");

// `--c4` 那趟(`ZJ_OHOS_C4=1`)出的是**验收面板**那一页,不是产品前端。
// ⭐ 它与 Rust 侧的 `c4-harness` feature **成对**:验收命令面在哪一趟里,验收按钮就在哪一趟。
// ⛔ 别让产品包里出现那一页(里头有 `c4_plant` 与明文回报备份码的按钮)。
const c4 = process.env.ZJ_OHOS_C4 === "1";

/**
 * 把 `android/src/**` 里的 `./platform` 改指到 `ohos/src/platform.ts`。
 *
 * ⚠ **为什么不用 `resolve.alias`**:alias 按说明符全局匹配,`./platform` 这种相对
 * 说明符一旦全局改写,任何目录下的同名文件都会被卷进去。这里按 **importer 的目录**
 * 判,只认「从共用那棵树里发出的、恰好叫 `./platform` 的那一条」。
 *
 * ⛔ **fail-closed**:接缝两份的导出面必须逐个对得上 —— 少一个,产品前端在鸿蒙上会在
 * **运行期**报 `xxx is not a function`,而 `vite build` **一声不吭**(esbuild 不做跨模块
 * 类型检查)。⇒ 构建期就把两份的导出名比一遍,不等则当场红。
 */
function platformSeam(): Plugin {
  const target = resolve(here, "src/platform.ts");
  const source = resolve(androidRoot, "src/platform.ts");
  const seamDir = resolve(androidRoot, "src");
  const norm = (p: string) => p.replace(/\\/g, "/");
  return {
    name: "zhujian-platform-seam",
    enforce: "pre",
    buildStart() {
      const names = (file: string) =>
        [...readFileSync(file, "utf8").matchAll(/^export (?:async )?(?:function|const|type) (\w+)/gm)]
          .map((m) => m[1])
          .sort();
      const want = names(source);
      const got = names(target);
      if (want.length === 0) this.error(`平台接缝 ${source} 一个导出都没解析到 —— 提取器失灵或文件变了形。`);
      if (want.join(",") !== got.join(",")) {
        const missing = want.filter((n) => !got.includes(n));
        const extra = got.filter((n) => !want.includes(n));
        this.error(
          `平台接缝两份对不上 —— 少了 [${missing}] / 多了 [${extra}]。\n` +
            `  真实现 ${source}\n  鸿蒙那份 ${target}\n` +
            `⇒ 少一个导出,产品前端会在真机上运行期报 "not a function",而构建一声不吭。`,
        );
      }
    },
    resolveId(id, importer) {
      if (id !== "./platform" || !importer) return null;
      return norm(importer).startsWith(norm(seamDir)) ? target : null;
    },
  };
}

export default defineConfig({
  clearScreen: false,
  root: c4 ? here : androidRoot,
  plugins: c4 ? [] : [platformSeam()],
  build: {
    outDir: resolve(here, "dist"),
    emptyOutDir: true,
  },
  server: {
    port: 1420,
    strictPort: true,
    host: "0.0.0.0",
    watch: {
      ignored: ["**/src-tauri/target/**"],
    },
  },
});

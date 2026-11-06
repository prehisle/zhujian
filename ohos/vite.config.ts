import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { policyAsset } from "../scripts/lib/policy-asset.mjs";
import { buildStampDefine } from "../scripts/lib/build-stamp.mjs";

// 朱简鸿蒙端的前端构建(OH-d/D3 起是**产品前端**,不再是那一页验收面板)。
//
// ⭐⭐ **root 指向 `android/`,不是这个目录** —— 用户 2026-08-23 拍板:两只手机壳
// **共用同一棵前端源码树**(`android/index.html` + `android/src` 那 8.5k 行 TS),
// 鸿蒙这边**一行都不复制**。判据:抄两份的话 UI 每改一次要改两处,而仓里最重的那份
// 复制逻辑今天是 268 行的 filter、还专门配了一道门禁(`check-filter-parity`);
// 8.5k 行没有任何一道门禁守得住。
//
// 两端的差别收在**两条接缝**里,下面那个 resolve 插件按同一套办法把它们换掉:
// · **平台接缝** `platform.ts`(端专属的 `invoke` 与扫码)——「这端有没有那座桥」;
// · **渠道接缝** `channel.ts`(651 起)——「这份包发给谁」:默认同步服务器地址与
//   隐私政策网址。⛔ 别把它并进平台接缝:安卓将来是**同一个平台、两个渠道**
//   (国内商店 / 官网),平台那根轴表达不了它。
// 其余带原生桥的模块本来就天生降级(`theme` / `textsize` 是 `window.__zhujianXxx?.…`,
// `saf` 是 `hasBridge()`),⛔ 别为它们再加别名。
// 第三条是**包**的接缝(W5 A54):`@tauri-apps/plugin-opener` 换成 `ohos/src/opener.ts`(为什么它
// 不归上一句管,见下面 `opener()` 头注)。
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
 * 把 `android/src/**` 里的 `./<mod>` 改指到 `ohos/src/<mod>.ts`(`mod` = platform / channel)。
 *
 * ⚠ **为什么不用 `resolve.alias`**:alias 按说明符全局匹配,`./platform` 这种相对
 * 说明符一旦全局改写,任何目录下的同名文件都会被卷进去。这里按 **importer 的目录**
 * 判,只认「从共用那棵树里发出的、恰好叫 `./<mod>` 的那一条」。
 *
 * ⛔ **fail-closed**:接缝两份的导出面必须逐个对得上 —— 少一个,产品前端在鸿蒙上会在
 * **运行期**报 `xxx is not a function`(渠道那条更阴:是 `undefined` 当地址用),而
 * `vite build` **一声不吭**(esbuild 不做跨模块类型检查)。⇒ 构建期就把两份的导出名
 * 比一遍,不等则当场红。
 */
function seam(mod: string, label: string): Plugin {
  const target = resolve(here, `src/${mod}.ts`);
  const source = resolve(androidRoot, `src/${mod}.ts`);
  const seamDir = resolve(androidRoot, "src");
  const norm = (p: string) => p.replace(/\\/g, "/");
  return {
    name: `zhujian-${mod}-seam`,
    enforce: "pre",
    buildStart() {
      const names = (file: string) =>
        [...readFileSync(file, "utf8").matchAll(/^export (?:async )?(?:function|const|type) (\w+)/gm)]
          .map((m) => m[1])
          .sort();
      const want = names(source);
      const got = names(target);
      if (want.length === 0) this.error(`${label} ${source} 一个导出都没解析到 —— 提取器失灵或文件变了形。`);
      if (want.join(",") !== got.join(",")) {
        const missing = want.filter((n) => !got.includes(n));
        const extra = got.filter((n) => !want.includes(n));
        this.error(
          `${label}两份对不上 —— 少了 [${missing}] / 多了 [${extra}]。\n` +
            `  真实现 ${source}\n  鸿蒙那份 ${target}\n` +
            `⇒ 少一个导出,产品前端会在真机上运行期报 "not a function",而构建一声不吭。`,
        );
      }
    },
    resolveId(id, importer) {
      if (id !== `./${mod}` || !importer) return null;
      return norm(importer).startsWith(norm(seamDir)) ? target : null;
    },
  };
}

/**
 * **opener 接缝**(W5 A54):把共用前端里的 `@tauri-apps/plugin-opener` 改指到 `ohos/src/opener.ts`。
 *
 * ⭐ **为什么这条要接缝、而上面那句「⛔ 别为它们再加别名」不管它**:那句说的是**本来就天生降级**的原生桥
 * (`window.__zhujianXxx?.…`,桥不在 = 那件事不做);这个包不降级 —— 它的 Rust 那半在这一端去调
 * `xdg-open`,**恒错**(平台事实②)。共用前端在 `HAS_BROWSER` 为真时直接调它的 `openUrl`
 * (「关于」三行 / 长文链接 / 意见反馈那一框),鸿蒙这份把 `HAS_BROWSER` 翻成真之后,这几处得落到
 * 壳里那座桥(`shell/OpenerBridge.ets`)上 ⇒ 在构建期换掉这个包,共用前端一行不改。
 *
 * ⚠ 与上面 `seam()` 的差别:那两条按 importer 目录认相对说明符;这一条是**包名**,鸿蒙产品包里
 * 不论谁导入它都换(这一端它没有一处是对的)。
 *
 * ⛔ **fail-closed**(同 `seam()` 的理由:少一个导出,构建一声不吭、真机上运行期才 `not a function`):
 * 每个导入它的模块,导入的名字逐个与 `opener.ts` 的导出比,少一个就当场红;认不出的导入形
 * (`import *` / 默认导入 / 动态 `import()`)也红 —— 那几种形逐个比不了。
 */
function opener(): Plugin {
  const pkg = "@tauri-apps/plugin-opener";
  const target = resolve(here, "src/opener.ts");
  let exported: Set<string>;
  return {
    name: "zhujian-opener-seam",
    enforce: "pre",
    buildStart() {
      exported = new Set(
        [...readFileSync(target, "utf8").matchAll(/^export (?:async )?(?:function|const) (\w+)/gm)].map((m) => m[1]),
      );
      if (exported.size === 0) this.error(`opener 接缝 ${target} 一个导出都没解析到 —— 提取器失灵或文件变了形。`);
    },
    resolveId(id) {
      return id === pkg ? target : null;
    },
    transform(code, id) {
      // 替身自己(头注里提到包名)不核;只数**带引号**的包名,注释里用反引号提它不算一次导入。
      const norm = (p: string) => p.replace(/\\/g, "/");
      if (!code.includes(pkg) || norm(id).startsWith(norm(target))) return null;
      const stmts = [...code.matchAll(/import\s+([^;]*?)\s+from\s+["']@tauri-apps\/plugin-opener["']/g)];
      const mentions = [...code.matchAll(/["']@tauri-apps\/plugin-opener["']/g)].length;
      if (stmts.length !== mentions) {
        this.error(`opener 接缝:${id} 里有认不出的 ${pkg} 导入形(动态 import / 再导出?)—— 只认 \`import { … } from\`。`);
      }
      for (const [, clause] of stmts) {
        const named = /^\{([^}]*)\}$/.exec(clause.trim());
        if (!named) this.error(`opener 接缝:${id} 用了 \`import ${clause}\` —— 只认具名导入,别的形逐个比不了。`);
        for (const part of named![1].split(",")) {
          const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
          if (name && !part.trim().startsWith("type ") && !exported.has(name)) {
            this.error(
              `opener 接缝:${id} 从 ${pkg} 导入了 \`${name}\`,鸿蒙那份 ${target} 没有它。\n` +
                `⇒ 少一个导出,鸿蒙上运行期报 "not a function",而构建一声不吭。`,
            );
          }
        }
      }
      return null;
    },
  };
}

export default defineConfig({
  clearScreen: false,
  // 构建身份戳(701)。⚠ 这一端**必须**跟着有:它共用 `android/src` 那棵树,而那棵树
  // 里的「关于」会读 `__ZJ_BUILD__` —— 漏了就在真机上运行期炸,`vite build` 一声不吭
  // (与上面两条接缝 fail-closed 同一个理由)。`--c4` 那趟 root 换成验收面板、读不到它,
  // 但 define 是全局文本替换,多给一份不碍事。
  define: buildStampDefine(),
  root: c4 ? here : androidRoot,
  // 651:渠道接缝之外还烤一份**境内渠道**的隐私政策页进产物(鸿蒙上没有 xdg-open,
  // 「阅读完整隐私政策」只能在应用内看)。⛔ 别指到 site-app/ —— 那是境外那一版正文。
  plugins: c4
    ? []
    : [
        seam("platform", "平台接缝"),
        seam("channel", "渠道接缝"),
        opener(),
        policyAsset(resolve(here, "../site-cool/privacy.html")),
      ],
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

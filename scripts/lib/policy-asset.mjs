// 把**这条渠道那三份**协议页作为静态资源烤进手机端产物(651)。
//
// # 为什么要烤进去
// 651 真机实测:鸿蒙的编译目标是 `linux`(`target_os="linux"` + `target_env="ohos"`),
// `tauri-plugin-opener` 因此走 Linux 分支去调 `xdg-open` —— 鸿蒙上没有这个程序,
// 于是「阅读完整隐私政策」报 `No such file or directory (os error 2)`。
// ⇒ 不依赖任何原生能力:协议页跟着包走,应用内就地展开,**离线也读得到**。
//
// # 为什么不会与官网分家
// 这里烤进去的就是 `scripts/build-site-cool.mjs` 生成的**那几份产物**(境内取 site-cool/、
// 境外取 site-app/),与官网上挂的是同一批文件、同一份 markdown 源。
// ⚠ 它是**构建那一刻的快照**:政策后来在官网改了,包里这份要等下一次发版才跟上
// ⇒ 展开页顶上印着官网网址,告诉用户最新版在哪儿。
//
// # ⭐ 那几个链接必须就地改掉(651 真机上看见才想到)
// 生成给网站用的那份,导航与页脚的链接是**根绝对路径**(`/privacy.html`、`/`)。
// 在应用的 WebView 里,`/` 指的是**应用自己的 index.html** ⇒ 点徽标会把整个朱简界面
// 套进 iframe 里。⇒ 这里逐条处理:
//   · 指向这三份之一的 → 改成相对路径(三份都在包里,点得通);
//   · 其余(`/` 与外链)→ **整个 href 去掉**,`<a>` 没有 href 就不是链接了。
// ⛔ 别改成「拦住点击」那类运行期兜底:那要在 iframe 里注脚本,比这脆得多。

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const PAGES = ["privacy.html", "privacy-rights.html", "terms.html"];

/** 把网站用的那份就地改成「应用内能走通」的那份。⛔ 改不动就当场停,别出半成品。 */
function forApp(html, srcName) {
  let out = html;
  // ① 三份互链:根绝对 → 相对
  for (const p of PAGES) out = out.split(`href="/${p}"`).join(`href="${p}"`);
  // ② 其余 href 一律摘掉(`/` 首页、以及正文里那条指向官网的外链)
  const before = (out.match(/href="/g) || []).length;
  out = out.replace(/\s*href="(?!privacy\.html|privacy-rights\.html|terms\.html)[^"]*"/g, "");
  const left = (out.match(/href="/g) || []).length;
  if (left === before) throw new Error(`${srcName}:一个 href 都没摘掉 —— 页面结构变了,先去看生成器`);
  return out;
}

/**
 * @param {string} src 隐私政策产物的绝对路径(site-cool/privacy.html 或 site-app/privacy.html)
 * @returns {import("vite").Plugin}
 */
export function policyAsset(src) {
  const dir = dirname(src);
  return {
    name: "zhujian-policy-asset",
    // ⚠ 只在 build 时挂:dev(安卓热重载那条路)下产物目录里没有它们,
    //   链接会 404 —— 那是开发态的已知边界,⛔ 别为此加运行期兜底。
    apply: "build",
    buildStart() {
      for (const p of PAGES) {
        const f = join(dir, p);
        if (!existsSync(f)) {
          this.error(`协议页产物不在:${f}\n  ⇒ 先跑 node scripts/build-site-cool.mjs 生成它们。`);
        }
      }
      if (basename(src) !== PAGES[0]) this.error(`policyAsset 的入参应当是 ${PAGES[0]},收到:${src}`);
    },
    generateBundle() {
      for (const p of PAGES) {
        const f = join(dir, p);
        this.emitFile({ type: "asset", fileName: p, source: forApp(readFileSync(f, "utf8"), p) });
      }
    },
  };
}

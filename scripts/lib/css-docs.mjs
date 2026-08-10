// 「一次层叠的作用域」= 一个**文档**,以及它按顺序加载了哪几份样式(338)。
//
// # 为什么要单独一件
//
// 337 的对比度门禁把「桌面」当成一整份来层叠:src/*.css 全并在一起。可桌面其实是**两个
// 窗口壳**——capture 窗(index.html)与 notebook 窗(notebook.html),各自加载各自那批
// CSS,还各带一段内联 `<style>`。并成一份会算错:board.css 的规则压根盖不到捕获窗里的
// 元素身上。337 排队第 1 条写的就是这件事,当时的注记是「要做得先把『哪个文档加载哪几份』
// 写成登记表」。
//
// # 它不是登记表,是**算出来的**
//
// 手写「捕获窗加载这 6 份」那种登记表,和 336 的 ⑩ 刀判过死刑的 `dark: false` 是同一种
// 东西:**那句登记本身没人核**,改错了照样绿。所以这里全部从地面事实推:
//   · `<link rel=stylesheet>` / `<style>` / `<script type=module src>` 按出现顺序扫 html;
//   · script 入口沿**静态模块图**递归,收 `import "./x.css"`。
// 认不出的形状一律抛(裸包名除外)—— 宁可当场响,不许猜出一份看着合理的清单。
//
// 唯一写死的是 DOCS 那四行「哪几个 html 是文档入口」,而它由使用方的反向探针钉住:
// src/*.css 里每一份都必须至少被一个文档加载到,漏了就是这只遍历失灵。
//
// # 顺序为什么可以不精确
//
// JS 模块图带进来的那些 CSS,在 dev(运行期注入 head 末尾)与 build(vite 提成 link)下
// 相对内联 `<style>` 的位置并不一样,静态定不了。但下游的层叠对**跨文件同权重冲突**本来
// 就 fail-closed(见 check-contrast 的 win()),所以这里只需保证「同一文件内的先后」正确,
// 文件之间的顺序不参与决胜。

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const R = (p) => resolve(root, p);

/**
 * 文档 = 一次层叠的作用域。`source` 是「份」(决定用哪张令牌表,与 check-theme-drift 的
 * 三份同名);同一份下可以有多个文档。
 */
export const DOCS = [
  { source: "桌面", tokens: "src/theme.css", name: "捕获窗", html: "index.html" },
  { source: "桌面", tokens: "src/theme.css", name: "主窗", html: "notebook.html" },
  { source: "安卓", tokens: "android/index.html", name: "单页", html: "android/index.html" },
  { source: "官网", tokens: "site/index.html", name: "单页", html: "site/index.html" },
];

/** 内联 `<style>` 的虚拟文件名。故意不带空格 —— 下游 `--list` 按多空格切列。 */
export const inlineName = (html, i) => `${html}#style${i > 0 ? i + 1 : ""}`;

/**
 * 把 import 的目标解析成仓内相对路径。`./x.css` 原样;`./x` 试 .ts / .tsx / /index.ts。
 * 裸包名(@tauri-apps/… 之类)返回 null = 不进模块图。
 */
function resolveSpec(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const dir = posix.dirname(fromFile.split("\\").join("/"));
  const base = posix.normalize(posix.join(dir, spec));
  if (base.endsWith(".css")) {
    if (!existsSync(R(base))) throw new Error(`${fromFile} import 的 ${spec} 不存在(${base})`);
    return base;
  }
  for (const ext of [".ts", ".tsx", "/index.ts"]) {
    if (existsSync(R(base + ext))) return base + ext;
  }
  throw new Error(`${fromFile} import 的 ${spec} 解析不到文件 —— 这只遍历只认 .ts/.tsx//index.ts`);
}

/**
 * 从一个 ts 入口沿静态模块图收 CSS(深度优先,去重)。返回**排序后**的路径数组:
 * 文件之间的先后本来就定不了(见头部注释),排序只是让输出稳定。
 */
export function cssClosure(entry) {
  const seen = new Set();
  const css = new Set();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const raw = readFileSync(R(f), "utf8");
    // `let x: import("./api").T` 是**类型位置**的 import,不是动态 import。先摘掉它,
    // 剩下的 `import(` 才是真的按需加载 —— 那种这只遍历认不出,当场响。
    const text = raw.replace(/\bimport\s*\(\s*["'][^"']+["']\s*\)\s*\./g, "TYPEREF.");
    if (/(?<![.\w$])import\s*\(/.test(text)) {
      throw new Error(`${f} 里有动态 import() —— 静态模块图看不出它加载了哪份 CSS,先在这里教它怎么算`);
    }
    // 自我校验:以 import 开头的行数,必须与解析到的条数对得上(多行 import 的正则最容易
    // 在这里静默少收 —— 少收 = 少判 = 安静的绿,同 337 第 ⑤ 刀那族)。
    const importLines = (text.match(/^[ \t]*import\b/gm) ?? []).length;
    let parsed = 0;
    for (const m of text.matchAll(
      // ⚠ `import` 与 `from` 之间用 `[^;]*?` 而**不是** `[\s\S]*?`(340 修):后者跨得过分号,
      // 于是「裸的副作用 import 后面跟一个 from import」会被**一次匹配整个吞掉**——
      //     import "./toast.css";            ← 这行的 import
      //     import { x } from "./timing";    ← 懒匹配一路吃到这里的 from
      // 两行算成一条,`parsed` 少一。真实的多行 import(花括号跨行)里没有分号,故 `[^;]`
      // 照样跨得过换行;而它跨不过上一条语句的结尾,顺序不再影响收成。
      // 这个形状躲了下来是因为**它取决于 import 的先后**:仓里此前每份文件的裸 CSS import
      // 都恰好排在最后一行,从没触发过。是那道「行数必须对得上」的自检把它逼出来的。
      /^[ \t]*(import|export)\b([^;]*?)\bfrom\s*["']([^"']+)["']|^[ \t]*import\s+["']([^"']+)["']/gm,
    )) {
      if (m[1]) parsed++;
      const typeOnly = m[2] !== undefined && /^\s+type\s/.test(m[2]);
      const spec = m[3] ?? m[4];
      if (m[4] !== undefined) parsed++;
      if (typeOnly) continue; // 纯类型 import 会被打包器整条抹掉,不产生任何加载
      const t = resolveSpec(f, spec);
      if (t === null) continue;
      if (t.endsWith(".css")) css.add(t);
      else stack.push(t);
    }
    if (parsed !== importLines) {
      throw new Error(
        `${f}:有 ${importLines} 行以 import 开头,只解析出 ${parsed} 条 —— 解析器漏了某种写法,` +
          `别让它安静地少收(少收 = 那份 CSS 从此不进层叠)`,
      );
    }
  }
  return [...css].sort();
}

/**
 * 一个文档按加载顺序的样式清单:`[{ file, text }]`。
 * `file` 是给人看也给下游对拍用的稳定标识(内联段是 `x.html#style`)。
 */
export function sheetsOf(doc) {
  const html = readFileSync(R(doc.html), "utf8");
  const base = dirname(doc.html).split("\\").join("/");
  const at = (p) => (base === "." ? p : posix.join(base, p));
  const sheets = [];
  let inlineIdx = 0;
  const re = /<link\b[^>]*>|<style>([\s\S]*?)<\/style>|<script\b[^>]*>/g;
  for (const m of html.matchAll(re)) {
    const tag = m[0];
    if (tag.startsWith("<link")) {
      if (!/rel\s*=\s*["']stylesheet["']/.test(tag)) continue;
      const href = /href\s*=\s*["']([^"']+)["']/.exec(tag);
      if (!href) throw new Error(`${doc.html}:有 rel=stylesheet 的 link 却没有 href —— ${tag}`);
      if (!href[1].startsWith("/")) {
        throw new Error(`${doc.html}:link href「${href[1]}」不是 / 开头的项目内路径,这只解析器不猜`);
      }
      const file = at(href[1].slice(1));
      sheets.push({ file, text: readFileSync(R(file), "utf8") });
      continue;
    }
    if (tag.startsWith("<style")) {
      sheets.push({ file: inlineName(doc.html, inlineIdx++), text: m[1] });
      continue;
    }
    // <script>:只有 type=module 且带 src 的才进模块图;内联 script 与它无关
    if (!/type\s*=\s*["']module["']/.test(tag)) continue;
    const src = /src\s*=\s*["']([^"']+)["']/.exec(tag);
    if (!src) continue;
    if (!src[1].startsWith("/")) {
      throw new Error(`${doc.html}:module script 的 src「${src[1]}」不是 / 开头,这只解析器不猜`);
    }
    for (const file of cssClosure(at(src[1].slice(1)))) {
      sheets.push({ file, text: readFileSync(R(file), "utf8") });
    }
  }
  if (!sheets.length) throw new Error(`${doc.html}:一份样式都没扫到 —— 解析器失灵,不是它真的没样式`);
  return sheets;
}

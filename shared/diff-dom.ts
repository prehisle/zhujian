// 历史比对的结果 → DOM。两端共用这一份;算法与预算数在 `diff.ts` 头注。
//
// ⚠ 与 markdown-dom.ts 同一个例外:它调全局 `document`、是两端共用的浏览器适配层,理由同样是
// 「安全落点只许有一处」。⛔ 不 import 任一端的 i18n / invoke / DOM 助手;文案(「旧版」「没算出
// 逐行差异」之类)由各端在外面包,本文件只画差异本身。
//
// ⛔ **只用 `createElement` + 文本节点**,不碰 `innerHTML` / 字符串模板 / `src/dom.ts` 的 `el()`。
// 正文的每一截只进文本节点;标签名与 class 都是本文件的固定常量。⛔ **比对面不渲染 Markdown**
// —— 显示的是原文,否则「改了一个 `*`」这类差异看不见。
//
// 画法(`diff.ts` 的 `rowCost` 照它数,改一边就改另一边,测试对拍):
//   根 `div.diff`;eq / del / ins 一行 = `div.diff-eq|diff-del|diff-ins` + 一个文本节点;
//   pair = `div.diff-del` + `div.diff-ins` 两行,每截:eq 截 = 文本节点,del / ins 截 = `span.diff-hl`
//   + 文本节点。行里的换行原样留在文本节点里,要显示成换行由各端给 `.diff` 配 `white-space: pre-wrap`。
// 预算:建之前再数一遍(≤ DIFF_MAX_DOM,与 diff.ts 的数应当相等);超了或算的阶段就降级 ⇒
// `div.diff.diff-raw` 里两块原文(`diff-raw-old` / `diff-raw-new`),半截产物整个丢掉。

import { DIFF_MAX_DOM, diffText, type DiffFail, type DiffRow, type DiffSeg } from "./diff";

/** `degraded` 非空 = 没画逐行差异、画的是两份原文;`limited` = 有配对行因预算没细化到字。 */
export type DiffRendered = { root: HTMLElement; degraded: DiffFail | "dom" | null; limited: boolean };

type Tag = "div" | "span";

class DomOver {}

type Cx = { n: number };

function count(cx: Cx): void {
  if (cx.n >= DIFF_MAX_DOM) throw new DomOver();
  cx.n++;
}
function mk(cx: Cx, tag: Tag, cls: string): HTMLElement {
  count(cx);
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}
function txt(cx: Cx, s: string): Text {
  count(cx);
  return document.createTextNode(s);
}

function raw(a: string, b: string): HTMLElement {
  const root = document.createElement("div");
  root.className = "diff diff-raw";
  const o = document.createElement("div");
  o.className = "diff-raw-old";
  o.append(document.createTextNode(a));
  const n = document.createElement("div");
  n.className = "diff-raw-new";
  n.append(document.createTextNode(b));
  root.append(o, n);
  return root;
}

/** 比较旧版 `a` 与新版 `b` 并画出来。 */
export function renderDiff(a: string, b: string): DiffRendered {
  const r = diffText(a, b);
  if (!r.ok) return { root: raw(a, b), degraded: r.reason, limited: false };
  const cx: Cx = { n: 0 };
  try {
    const root = mk(cx, "div", "diff");
    for (const x of r.rows) row(cx, root, x);
    return { root, degraded: null, limited: r.limited };
  } catch (e) {
    if (e instanceof DomOver) return { root: raw(a, b), degraded: "dom", limited: false };
    throw e;
  }
}

function row(cx: Cx, root: HTMLElement, x: DiffRow): void {
  switch (x.t) {
    case "eq":
    case "del":
    case "ins": {
      const e = mk(cx, "div", x.t === "eq" ? "diff-eq" : x.t === "del" ? "diff-del" : "diff-ins");
      e.append(txt(cx, x.s));
      root.append(e);
      return;
    }
    case "pair": {
      root.append(line(cx, "diff-del", x.del), line(cx, "diff-ins", x.ins));
      return;
    }
    default:
      throw new Error(`diff: 未知行 ${(x as { t: unknown }).t}`);
  }
}

function line(cx: Cx, cls: "diff-del" | "diff-ins", segs: DiffSeg[]): HTMLElement {
  const e = mk(cx, "div", cls);
  for (const s of segs) {
    switch (s.t) {
      case "eq":
        e.append(txt(cx, s.s));
        break;
      case "del":
      case "ins": {
        const h = mk(cx, "span", "diff-hl");
        h.append(txt(cx, s.s));
        e.append(h);
        break;
      }
      default:
        throw new Error(`diff: 未知截 ${(s as { t: unknown }).t}`);
    }
  }
  return e;
}

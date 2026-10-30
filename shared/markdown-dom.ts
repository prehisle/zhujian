// 长文 Markdown 语法树 → DOM。两端(桌面 / 安卓与鸿蒙那棵)共用这一份 —— 一个渲染器,
// 「字段到 DOM 的落点」只有一处要审。解析与预算数在 `markdown.ts` 头注。
//
// ⚠ **这是 `shared/` 「只放零平台依赖的纯逻辑」那条规矩的例外**:它调全局 `document`、有副作用,
// 是一层**两端共用的浏览器适配层**。例外的理由 = 安全落点只许有一处(两份渲染器 = 两处要审、
// 两处会漂)。例外的边界照旧:⛔ 不 import 任一端的 i18n / invoke / DOM 助手 —— 各端的文案与
// 动作只经 `MdHooks` 以「字符串 + 回调」交进来,**DOM 一律由本文件建**(各端钩子不交节点,
// 否则那些节点既不在预算里、也不在下面那张去向表里)。
//
// ⛔ **只用 `createElement` + 文本节点**:不碰 `innerHTML` / `insertAdjacentHTML` / 字符串模板,
// 也不经 `src/dom.ts` 的 `el()`(它整体 `Object.assign` 进元素,不是安全边界)。
// 每个字段的唯一去向:
//   - 正文、代码、链接文字、代码块语言标记 → 文本节点(语言标记只当字显示,⛔ 不拼 class);
//   - 标签名、class、属性名 → 本文件里的固定常量,⛔ 不从语法树取;
//   - 链接目标 → **只活在点击闭包里**,⛔ 不写 `href` / `src` / `title`;点下去再过一遍
//     `validateHttpUrl`(点击出口也调同一个校验器),交给各端的 `openLink`;
//   - 图N → 有界整数,交给各端的 `image(n)` 查当前条目的配图;有就画成本文件建的芯片按钮
//     (文案是各端字典给的,点了调各端的回调),查不到就按原文「图N」;
//     **一段里只有图N(中间只隔空白 / 换行)** ⇒ 那几张画成原位的图(`button.md-fig` 包一个
//     `img`):`img.src` 只取各端 `src()` 交回的串(各端从自己的取图命令拿的 blob: / data:
//     地址,⛔ 不来自正文),`alt` / `title` / `aria-label` 是各端字典给的文案;段里有一个图N
//     查不到,整段照普通段落画(芯片 + 原文);
//   - 勾选状态与行号 → 布尔 / 行号,交给各端的 `checkbox` 换回文案与翻面回调,方框本身由本文件建;
//   - 有序列表起始号 → 校验过的整数,写 `start` 属性(数值,不是字符串拼接)。
// 各端交进来的文案只进 `textContent` / `title` / `aria-label`(⛔ 它们不来自正文)。
// 未知节点类型 fail-fast(抛错),⛔ 不兜底成任何「原样输出」。
//
// 预算:画出来的全部 DOM 节点(元素 + 文本节点,含根)≤ MD_MAX_DOM,**建之前查**;超了或解析
// 阶段就超了 ⇒ 整篇按原文显示(`.md-plain` 一个文本节点),半截产物整个丢掉。
//
// 段落里的换行是原样留在文本节点里的,要显示成换行得由各端给 `.md p` 等配 `white-space: pre-wrap`。

import { MD_MAX_DOM, imgRefText, parseMarkdown, validateHttpUrl, type MdBlock, type MdFail, type MdInline, type MdItem } from "./markdown";

export type MdHooks = {
  /** 用系统浏览器打开(拿到的一定是校验过的 http/https)。`null` = 这个平台打不开外部浏览器
   *  (鸿蒙):链接只显示文字与地址,⛔ 不拿可导航的 `href` 兜底。 */
  openLink: ((url: string) => void) | null;
  /** 当前条目有没有第 n 张图:有就回芯片上的字、点了做什么、原位显示时的图址(⛔ 只许是各端
   *  自己取来的 blob: / data: 地址;手上已有就同步交回,免得重画时图先塌成零高再撑开),
   *  没有回 `null`(按原文「图N」)。 */
  image: (n: number) => { label: string; open: () => void; src: () => string | Promise<string> } | null;
  /** 勾选项那枚方框的文案(悬停 / 读屏)与翻面动作;`toggle = null` = 只读视图,方框禁用。
   *  `line` 原样交给 `toggleChecklistLine`。 */
  checkbox: (checked: boolean, line: number) => { label: string; toggle: (() => void) | null };
};

/** `anchors` = 顶层每一块画成的元素 + 它起于正文第几行(编辑器对齐左右滚动用;降级时为空)。 */
export type MdRendered = { root: HTMLElement; degraded: MdFail | "dom" | null; anchors: { line: number; el: HTMLElement }[] };

type Tag =
  | "div" | "p" | "h1" | "h2" | "h3" | "strong" | "em" | "code" | "pre" | "ul" | "ol" | "li" | "blockquote" | "hr" | "a" | "span"
  | "button" | "img";

class DomOver {}

type Cx = { n: number; hooks: MdHooks };

function count(cx: Cx): void {
  if (cx.n >= MD_MAX_DOM) throw new DomOver();
  cx.n++;
}
function mk(cx: Cx, tag: Tag, cls?: string): HTMLElement {
  count(cx);
  const e = document.createElement(tag);
  if (cls !== undefined) e.className = cls;
  return e;
}
function txt(cx: Cx, s: string): Text {
  count(cx);
  return document.createTextNode(s);
}

function plain(text: string): HTMLElement {
  const e = document.createElement("div");
  e.className = "md md-plain";
  e.append(document.createTextNode(text));
  return e;
}

/** 把一篇长文画出来。`degraded` 非空 = 超了某道预算、画的是原文。 */
export function renderMarkdown(text: string, hooks: MdHooks): MdRendered {
  const r = parseMarkdown(text);
  if (!r.ok) return { root: plain(text), degraded: r.reason, anchors: [] };
  const cx: Cx = { n: 0, hooks };
  try {
    const root = mk(cx, "div", "md");
    const anchors: { line: number; el: HTMLElement }[] = [];
    r.blocks.forEach((b, k) => {
      const e = block(cx, b);
      anchors.push({ line: r.starts[k], el: e });
      root.append(e);
    });
    return { root, degraded: null, anchors };
  } catch (e) {
    if (e instanceof DomOver) return { root: plain(text), degraded: "dom", anchors: [] };
    throw e;
  }
}

function block(cx: Cx, b: MdBlock): HTMLElement {
  switch (b.t) {
    case "heading": {
      const h = mk(cx, b.level === 1 ? "h1" : b.level === 2 ? "h2" : "h3");
      inlines(cx, h, b.c);
      return h;
    }
    case "para": {
      const figs = figures(cx, b.c);
      if (figs !== null) return figs;
      const p = mk(cx, "p");
      inlines(cx, p, b.c);
      return p;
    }
    case "list": {
      const l = mk(cx, b.ordered ? "ol" : "ul");
      if (b.ordered && b.start !== 1) {
        if (!Number.isSafeInteger(b.start) || b.start < 0) throw new Error("markdown: 有序列表起始号不是整数");
        (l as HTMLOListElement).start = b.start;
      }
      for (const it of b.items) l.append(item(cx, it));
      return l;
    }
    case "quote": {
      const q = mk(cx, "blockquote");
      for (const k of b.c) q.append(block(cx, k));
      return q;
    }
    case "fence": {
      const pre = mk(cx, "pre");
      if (b.lang !== "") {
        const tag = mk(cx, "span", "md-lang");
        tag.append(txt(cx, b.lang));
        pre.append(tag);
      }
      const code = mk(cx, "code");
      code.append(txt(cx, b.s));
      pre.append(code);
      return pre;
    }
    case "hr":
      return mk(cx, "hr");
    default:
      throw new Error(`markdown: 未知块节点 ${(b as { t: unknown }).t}`);
  }
}

type MdImage = NonNullable<ReturnType<MdHooks["image"]>>;

/** 一段里只有图N(中间只隔空白)且张张查得到 ⇒ 原位画成图;否则 `null`(照普通段落画)。 */
function figures(cx: Cx, xs: MdInline[]): HTMLElement | null {
  const imgs: MdImage[] = [];
  for (const x of xs) {
    if (x.t === "text" && x.s.trim() === "") continue;
    if (x.t !== "img") return null;
    const img = cx.hooks.image(x.n);
    if (img === null) return null;
    imgs.push(img);
  }
  if (imgs.length === 0) return null;
  const wrap = mk(cx, "div", "md-figs");
  for (const img of imgs) {
    const fig = mk(cx, "button", "md-fig") as HTMLButtonElement;
    fig.type = "button";
    fig.title = img.label;
    fig.setAttribute("aria-label", img.label);
    fig.addEventListener("click", (e) => {
      e.stopPropagation();
      img.open();
    });
    const pic = mk(cx, "img") as HTMLImageElement;
    pic.alt = img.label;
    const src = img.src();
    if (typeof src === "string") pic.src = src;
    else
      src.then(
        (u) => {
          pic.src = u;
        },
        () => fig.classList.add("broken"),
      );
    fig.append(pic);
    wrap.append(fig);
  }
  return wrap;
}

function item(cx: Cx, it: MdItem): HTMLElement {
  switch (it.t) {
    case "item": {
      const li = mk(cx, "li");
      for (const k of it.c) li.append(block(cx, k));
      return li;
    }
    case "task": {
      const li = mk(cx, "li", it.checked ? "md-task on" : "md-task");
      const { label, toggle } = cx.hooks.checkbox(it.checked, it.line);
      const box = mk(cx, "button", "ckbox") as HTMLButtonElement;
      box.type = "button";
      box.title = label;
      box.setAttribute("aria-label", label);
      if (toggle === null) box.disabled = true;
      else
        box.addEventListener("click", (e) => {
          e.stopPropagation(); // 卡片 / 面板上还有别的点击主,这一下只归方框
          toggle();
        });
      li.append(box);
      for (const k of it.c) li.append(block(cx, k));
      return li;
    }
    default:
      throw new Error(`markdown: 未知列表项 ${(it as { t: unknown }).t}`);
  }
}

function inlines(cx: Cx, parent: HTMLElement, xs: MdInline[]): void {
  for (const x of xs) parent.append(inline(cx, x));
}

function inline(cx: Cx, x: MdInline): Node {
  switch (x.t) {
    case "text":
      return txt(cx, x.s);
    case "strong":
    case "em": {
      const e = mk(cx, x.t);
      inlines(cx, e, x.c);
      return e;
    }
    case "code": {
      const e = mk(cx, "code", "md-code");
      e.append(txt(cx, x.s));
      return e;
    }
    case "link":
      return link(cx, x);
    case "img": {
      const img = cx.hooks.image(x.n);
      if (img === null) return txt(cx, imgRefText(x.n));
      const chip = mk(cx, "button", "img-ref") as HTMLButtonElement;
      chip.type = "button";
      chip.append(txt(cx, img.label));
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        img.open();
      });
      return chip;
    }
    default:
      throw new Error(`markdown: 未知行内节点 ${(x as { t: unknown }).t}`);
  }
}

function link(cx: Cx, x: { url: string; bare: boolean; c: MdInline[] }): Node {
  const open = cx.hooks.openLink;
  if (open === null) {
    // 打不开外部浏览器的平台:文字照常,Markdown 链接后面补一个括号地址(裸地址本身就是地址)
    const s = mk(cx, "span", "md-link-off");
    inlines(cx, s, x.c);
    if (!x.bare) s.append(txt(cx, ` (${x.url})`));
    return s;
  }
  const url = x.url;
  const go = (e: Event): void => {
    e.preventDefault();
    e.stopPropagation();
    const ok = validateHttpUrl(url);
    if (ok === null) throw new Error("markdown: 进了语法树的链接没过校验器");
    open(ok);
  };
  // `<a>` 不带 href:不可导航、也不会被拖成链接;tabIndex + role 补回键盘可达
  const a = mk(cx, "a", "md-link");
  a.tabIndex = 0;
  a.setAttribute("role", "link");
  a.addEventListener("click", go);
  a.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") go(e);
  });
  inlines(cx, a, x.c);
  return a;
}

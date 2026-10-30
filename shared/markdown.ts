// 长文的 Markdown —— 文本 → 语法树(纯函数,两端共用这一份)+ 唯一的链接校验器。
// 画成 DOM 在隔壁 `markdown-dom.ts`;本文件零 DOM、零平台依赖(同 checklist.ts 那条规矩)。
//
// ⛔ **只在长文里用**。随记 / 任务 / 看板卡 / 记一笔照旧只认方框(checklist.ts 头注那条线),
// 长文是唯一的例外 —— 别借这份解析器把 Markdown 渲染顺手推到别的面。
//
// **认的语法一次定死**(往外扩要再拍):标题 `#`–`###`、段落、粗体 / 斜体、行内代码、围栏代码块、
// 有序 / 无序列表、勾选方框(就是 checklist.ts 认的那一种行)、引用、分隔线、链接(只认
// http/https)、裸地址、「图N」。⛔ 不认:原始 HTML、表格、脚注、公式、图片语法、setext 标题、
// 缩进代码块、`<地址>` 尖括号链接、链接标题。反斜杠转义(`\*`)是「怎么写出字面量」,不是新语法,认。
//
// **刻意与 CommonMark 不同的几处**(都是为了线性与中文,写死在这儿免得被当成 bug 修):
//   - 段落里的换行**原样保留**(渲染侧靠 `white-space: pre-wrap`),不折成空格 —— 中文不靠空格断句。
//   - 粗斜的开合只看紧挨的那个字是不是空白,不看标点 ⇒ `中文**粗体**中文` 照样成立(CommonMark
//     的标点规则在中文里出名地坑)。`_` 另加「贴着字母数字就不算」⇒ `snake_case` 不变斜。
//     三个及以上连在一起的 `***` 当原文。粗斜**最多两层**,再往里当原文。
//   - 没有惰性续行:引用的每一行都要带 `>`,列表项的续行要缩进到内容列。
//   - 块起头不限缩进(没有缩进代码块,也就没有「4 格以上算代码」那条)。行首 tab 一律算 4 列。
//   - 链接目标里不许有空白和 `]`(后者让每次「`](` 试配」的目标区间两两不交 ⇒ 复制总量线性,
//     见 `destEnd`);括号可以成对嵌套(维基百科那种地址)。
//   - 勾选项 ⇔ 那一**原始行**被 `parseChecklistLine` 认出(所以引用里的 `- [ ]` 不是勾选项)——
//     这样带出去的行号拿去 `toggleChecklistLine` 一定翻得动,两边永远对得上。
//
// **安全**(语法树的形本身就是第一道闸):节点只有下面那几种固定类型,⛔ 没有「原样 HTML」节点、
// ⛔ 不带通用 attrs / props / style;叶子只有字符串、布尔与有界整数。链接目标只以**校验器吐出的
// 规范化值**进树,画的那一侧把它关进点击闭包(markdown-dom.ts)。
//
// **资源上界**(⚠ 都是**未经实测的起始值**,不是「已证明不卡」;最慢的受支持真机测不过就先降
// 节点预算,调高必须重跑 scripts/test-markdown.mjs 的资源族):
//   - 输入 ≤ 204,800 UTF-8 字节(与正文 200 KiB 上限一致,入口先数,超了不解析);
//   - 语法树总深度 ≤ 16(根为 0,所有节点都计);语法树节点 ≤ 8,192(含文本节点);
//   - 渲染出的 DOM 节点 ≤ 16,384(在 markdown-dom.ts 里数;两个数分开限,别假设一对一)。
// 一律**分配之前查**;超了整篇丢掉本次产物、按原文显示,⛔ 不把半截产物混进来。三端同一组数。
// 行内解析是单遍的:反引号先建「同长度闭合串」索引(失败查询 O(1))、方括号与粗斜各走显式栈
// (每个 token 至多进出一次)、链接目标靠一趟预算好的「括号余额下一次跌破」表 O(1) 定位,
// ⛔ 不从每个开符往后搜。解析器里的逐字循环都往 `MdStats` 里记数,测试拿它与 `C·n + B` 比;
// ⚠ 计数器只看得见**记了数的**循环(校验器那一圈不记,它吃的区间已按长度记进 `copied`),
// 一个忘了记数的平方扫描只剩墙钟烟测碰得到 ⇒ 新加逐字循环时记数是评审要盯的,不是测试能证的。

import { parseChecklistLine } from "./checklist";

export const MD_MAX_BYTES = 204_800;
export const MD_MAX_DEPTH = 16;
export const MD_MAX_NODES = 8_192;
export const MD_MAX_DOM = 16_384;
/** 正文里引用第 n 张配图的写法(语法,与界面语言无关 —— 英文界面插进去的也是这个)。 */
export function imgRefText(n: number): string {
  return `图${n}`;
}
/** 正文里一处「图N」引用在原文中的位置 `[a, b)` 与它在第几行(`split("\n")` 口径;写字框给它垫底色、配缩略图用)。 */
export type ImgRefSpan = { a: number; b: number; n: number; line: number };

/** 原文里每一处「图N」。词法同解析器:「图」+ 1–6 位数字(连着第 7 位数字就整串不算);
 *  围栏代码块里、行内代码里的不算。⚠ 嵌在引用 / 列表里的围栏这里不跳过(只给写字框做标注,⛔ 不当渲染判据)。 */
export function scanImgRefs(text: string): ImgRefSpan[] {
  const out: ImgRefSpan[] = [];
  const lines = text.split("\n");
  let fence: { ch: string; len: number } | null = null;
  let off = 0;
  lines.forEach((ln, i) => {
    const t = ln.replace(/^ +/, "");
    if (fence !== null) {
      const m = /^(`{3,}|~{3,})\s*$/.exec(t);
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len) fence = null;
    } else {
      const f = /^(`{3,}|~{3,})/.exec(t);
      if (f && ln.length - t.length <= 3 && !(f[1][0] === "`" && t.slice(f[1].length).includes("`"))) fence = { ch: f[1][0], len: f[1].length };
      else {
        // 行内代码:等长的反引号串两两配对,配上的区间里不认
        const skip: [number, number][] = [];
        const ticks = [...ln.matchAll(/`+/g)];
        for (let p = 0; p < ticks.length; p++) {
          const q = ticks.findIndex((x, k) => k > p && x[0].length === ticks[p][0].length);
          if (q < 0) continue;
          skip.push([ticks[p].index!, ticks[q].index! + ticks[q][0].length]);
          p = q;
        }
        for (const m of ln.matchAll(/图(\d+)/g)) {
          const at = m.index!;
          if (m[1].length > 6 || skip.some(([x, y]) => at >= x && at < y)) continue;
          out.push({ a: off + at, b: off + at + m[0].length, n: Number(m[1]), line: i });
        }
      }
    }
    off += ln.length + 1;
  });
  return out;
}

/** 写字框右侧窄边上,每处「图N」的缩略图排第几列(0 = 最靠右;顺序同 `refs`)。缩略图停在它那一行、
 *  比一行高 ⇒ 相隔不足 `reach` 行的两枚在同一列会叠住,排开到下一列;隔得够远的回到最右列。
 *  按原文行数算:一行原文折成几行只会更远,所以只会多让、不会叠。 */
export function gutterCols(refs: ImgRefSpan[], reach: number): number[] {
  const lastLine: number[] = []; // 每一列最后一枚停在哪一行
  return refs.map((r) => {
    let c = lastLine.findIndex((l) => r.line - l >= reach);
    if (c < 0) c = lastLine.length;
    lastLine[c] = r.line;
    return c;
  });
}

/** 链接地址的长度上限(码元)。比它长的一律不当链接 —— 也是在给每次校验的复制量封顶。 */
export const URL_MAX_LEN = 4_096;

export type MdInline =
  | { t: "text"; s: string }
  | { t: "strong"; c: MdInline[] }
  | { t: "em"; c: MdInline[] }
  | { t: "code"; s: string }
  /** `url` 只可能是 `validateHttpUrl` 的产物;`bare` = 裸地址(显示的字就是地址本身)。 */
  | { t: "link"; url: string; bare: boolean; c: MdInline[] }
  /** 「图N」;N 是 1–6 位数字,有没有这张图由画的那一侧查当前条目的配图。 */
  | { t: "img"; n: number };

export type MdItem =
  | { t: "item"; c: MdBlock[] }
  /** `line` = 这一项在正文 `split("\n")` 里的行号,原样交给 `toggleChecklistLine`。 */
  | { t: "task"; checked: boolean; line: number; c: MdBlock[] };

export type MdBlock =
  | { t: "heading"; level: 1 | 2 | 3; c: MdInline[] }
  | { t: "para"; c: MdInline[] }
  | { t: "list"; ordered: boolean; start: number; items: MdItem[] }
  | { t: "quote"; c: MdBlock[] }
  /** `lang` 只当文字显示,⛔ 不拿它拼 class。 */
  | { t: "fence"; lang: string; s: string }
  | { t: "hr" };

/** 资源计数器:扫过的字符、配对 / 栈操作、累计复制长度。只给测试与排查用,不影响结果。 */
export type MdStats = { scanned: number; pairOps: number; copied: number };
export type MdFail = "bytes" | "depth" | "nodes";
/** `starts[k]` = 顶层第 k 块起于正文 `split("\n")` 的第几行(与 `blocks` 一一对应;编辑器对齐
 *  左右滚动用,只是整数,⛔ 不进 DOM)。 */
export type MdResult =
  | { ok: true; blocks: MdBlock[]; starts: number[]; nodes: number; stats: MdStats }
  | { ok: false; reason: MdFail; stats: MdStats };

// ---------------------------------------------------------------------------
// 唯一的 URL 校验器 —— Markdown 链接目标、裸地址、点击出口三处都调它,⛔ 别另写一份判据。
// ---------------------------------------------------------------------------

/** 是 http/https 地址就返回规范化后的地址(`URL.href`),否则 `null`。
 *
 *  ⛔ 先拒控制字符与空白,**再**解析:`URL` 解析器会静默删掉中间的 tab / 换行、剥掉首尾的
 *  C0 与空格,`"java\nscript:…"` 进去出来就是 `javascript:`(这里靠协议判据也挡得住,但
 *  「解析器替你改过的串」不该进入后面任何一步)。无 base 解析 ⇒ 相对地址一律失败。 */
export function validateHttpUrl(raw: string): string | null {
  if (raw.length === 0 || raw.length > URL_MAX_LEN) return null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c <= 0x20 || (c >= 0x7f && c <= 0x9f)) return null;
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  // ⚠ 规范化会把地址变长(一个汉字 → `%E4%B8%AD` 九个字符):输出也得过长度闸,否则
  // 「自己的输出再验一次」会被拒 —— 点击出口正是这么验的(codex 2a 一弹 M)。
  if (u.href.length > URL_MAX_LEN) return null;
  return u.href;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

class Over {
  reason: MdFail;
  constructor(reason: MdFail) {
    this.reason = reason;
  }
}

type Ctx = { lines: string[]; stats: MdStats; nodes: number };

/** 每造一个语法树节点之前调一次:深度与节点数都是**先查后造**。 */
function alloc(cx: Ctx, depth: number): void {
  if (depth > MD_MAX_DEPTH) throw new Over("depth");
  if (cx.nodes >= MD_MAX_NODES) throw new Over("nodes");
  cx.nodes++;
}

/** UTF-8 字节数超没超 `limit`(超了就停,不数完)。孤立代理按 3 字节算(编码时会变 U+FFFD)。 */
function exceedsBytes(s: string, limit: number, st: MdStats): boolean {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    st.scanned++;
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
    if (bytes > limit) return true;
  }
  return false;
}

export function parseMarkdown(text: string): MdResult {
  const stats: MdStats = { scanned: 0, pairOps: 0, copied: 0 };
  if (exceedsBytes(text, MD_MAX_BYTES, stats)) return { ok: false, reason: "bytes", stats };
  // 行号口径与 checklist.ts 一致(`split("\n")`),勾选项带出去的行号才翻得动。
  const lines = text.split("\n");
  stats.copied += text.length;
  const cx: Ctx = { lines, stats, nodes: 0 };
  const all: Ln[] = lines.map((_, i) => ({ i, off: 0 }));
  try {
    const starts: number[] = [];
    const blocks = parseBlocks(cx, all, 1, starts);
    return { ok: true, blocks, starts, nodes: cx.nodes, stats };
  } catch (e) {
    if (e instanceof Over) return { ok: false, reason: e.reason, stats };
    throw e;
  }
}

// ---------------------------------------------------------------------------
// 块
// ---------------------------------------------------------------------------

/** 一行在当前容器里的样子:原始行号 + 容器前缀(`> `、列表缩进)剥掉之后从哪个字符起。
 *  ⛔ 剥前缀只挪 `off`,不切新串 —— 嵌套多少层都不复制行。 */
type Ln = { i: number; off: number };

function isLineWs(c: number): boolean {
  return c === 32 || c === 9 || c === 13;
}

/** 从 `off` 起第一个非空白字符的位置;整行空白就是 `s.length`。 */
function firstNonWs(cx: Ctx, s: string, off: number): number {
  let p = off;
  while (p < s.length && isLineWs(s.charCodeAt(p))) {
    cx.stats.scanned++;
    p++;
  }
  return p;
}

/** `[from, to)` 那段空白占几列(tab 记 4 列)。 */
function colsBetween(cx: Ctx, s: string, from: number, to: number): number {
  let cols = 0;
  for (let p = from; p < to; p++) {
    cx.stats.scanned++;
    cols += s.charCodeAt(p) === 9 ? 4 : 1;
  }
  return cols;
}

/** 从 `off` 起剥掉至多 `n` 列空白,返回新的 `off`(剥到半个 tab 就整个吃掉)。 */
function stripCols(cx: Ctx, s: string, off: number, n: number): number {
  let p = off;
  let cols = 0;
  while (p < s.length && cols < n) {
    const c = s.charCodeAt(p);
    if (c !== 32 && c !== 9) break;
    cx.stats.scanned++;
    cols += c === 9 ? 4 : 1;
    p++;
  }
  return p;
}

type Start =
  | { k: "fence"; ch: number; len: number; lang: string }
  | { k: "heading"; level: 1 | 2 | 3 }
  | { k: "hr" }
  | { k: "quote" }
  | { k: "list"; ordered: boolean; num: number; markEnd: number };

/** `pos` 是一行(在当前容器里)第一个非空白字符;这一行起不起一个块、起哪种。 */
function classify(cx: Ctx, s: string, pos: number): Start | null {
  const st = cx.stats;
  const c = s.charCodeAt(pos);
  // 围栏:三个以上 ` 或 ~;` 围栏的信息串里不许再有 `
  if (c === 96 || c === 126) {
    let j = pos;
    while (j < s.length && s.charCodeAt(j) === c) {
      st.scanned++;
      j++;
    }
    if (j - pos >= 3) {
      let a = firstNonWs(cx, s, j);
      let e = a;
      let bad = false;
      while (e < s.length) {
        st.scanned++;
        if (c === 96 && s.charCodeAt(e) === 96) bad = true;
        e++;
      }
      if (!bad) {
        let w = a;
        while (w < s.length && !isLineWs(s.charCodeAt(w))) {
          st.scanned++;
          w++;
        }
        st.copied += w - a;
        return { k: "fence", ch: c, len: j - pos, lang: s.slice(a, w) };
      }
    }
  }
  // 标题:1–3 个 #,后面是行尾或空白;#### 起不认(当段落原文)
  if (c === 35) {
    let j = pos;
    while (j < s.length && j - pos < 4 && s.charCodeAt(j) === 35) {
      st.scanned++;
      j++;
    }
    const level = j - pos;
    if (level <= 3 && (j === s.length || isLineWs(s.charCodeAt(j)))) return { k: "heading", level: level as 1 | 2 | 3 };
  }
  // 分隔线:同一种 - * _ 至少三个,中间只许空白。先于列表判(`- - -` 是线不是列表)
  if (c === 45 || c === 42 || c === 95) {
    let n = 0;
    let ok = true;
    for (let j = pos; j < s.length; j++) {
      st.scanned++;
      const d = s.charCodeAt(j);
      if (d === c) n++;
      else if (!isLineWs(d)) {
        ok = false;
        break;
      }
    }
    if (ok && n >= 3) return { k: "hr" };
  }
  if (c === 62) return { k: "quote" };
  // 无序:- + * 后面是行尾或空白
  if (c === 45 || c === 43 || c === 42) {
    if (pos + 1 === s.length || isLineWs(s.charCodeAt(pos + 1))) return { k: "list", ordered: false, num: 1, markEnd: pos + 1 };
  }
  // 有序:1–9 位数字 + . 或 ) + 行尾或空白
  if (c >= 48 && c <= 57) {
    let j = pos;
    while (j < s.length && j - pos < 10) {
      const d = s.charCodeAt(j);
      if (d < 48 || d > 57) break;
      st.scanned++;
      j++;
    }
    const digits = j - pos;
    if (digits <= 9 && j < s.length) {
      const d = s.charCodeAt(j);
      if ((d === 46 || d === 41) && (j + 1 === s.length || isLineWs(s.charCodeAt(j + 1)))) {
        st.copied += digits;
        return { k: "list", ordered: true, num: Number(s.slice(pos, j)), markEnd: j + 1 };
      }
    }
  }
  return null;
}

/** `starts` 只有顶层那一趟传:每长出一块就记下它起于哪一行(每一圈至多长一块)。 */
function parseBlocks(cx: Ctx, ls: Ln[], depth: number, starts?: number[]): MdBlock[] {
  const out: MdBlock[] = [];
  const lines = cx.lines;
  let k = 0;
  let from = 0;
  while (k < ls.length) {
    if (starts !== undefined && starts.length < out.length) starts.push(from);
    const ln = ls[k];
    from = ln.i;
    const s = lines[ln.i];
    const pos = firstNonWs(cx, s, ln.off);
    if (pos === s.length) {
      k++;
      continue;
    }
    const st = classify(cx, s, pos);
    if (st === null) {
      k = parsePara(cx, ls, k, depth, out);
      continue;
    }
    switch (st.k) {
      case "fence":
        k = parseFence(cx, ls, k, depth, pos, st, out);
        break;
      case "heading": {
        alloc(cx, depth);
        let a = firstNonWs(cx, s, pos + st.level);
        let e = s.length;
        while (e > a && isLineWs(s.charCodeAt(e - 1))) {
          cx.stats.scanned++;
          e--;
        }
        // 收尾的 # 串(`## 标题 ##`):前面得是空白或干脆整行就是它,才剥
        let h = e;
        while (h > a && s.charCodeAt(h - 1) === 35) {
          cx.stats.scanned++;
          h--;
        }
        if (h < e && (h === a || isLineWs(s.charCodeAt(h - 1)))) {
          e = h;
          while (e > a && isLineWs(s.charCodeAt(e - 1))) {
            cx.stats.scanned++;
            e--;
          }
        }
        cx.stats.copied += e - a;
        out.push({ t: "heading", level: st.level, c: parseInline(cx, s.slice(a, e), depth + 1) });
        k++;
        break;
      }
      case "hr":
        alloc(cx, depth);
        out.push({ t: "hr" });
        k++;
        break;
      case "quote": {
        alloc(cx, depth);
        const sub: Ln[] = [];
        let j = k;
        while (j < ls.length) {
          const lj = ls[j];
          const sj = lines[lj.i];
          const pj = firstNonWs(cx, sj, lj.off);
          if (pj === sj.length || sj.charCodeAt(pj) !== 62) break;
          const after = pj + 1 < sj.length && sj.charCodeAt(pj + 1) === 32 ? pj + 2 : pj + 1;
          sub.push({ i: lj.i, off: after });
          cx.stats.pairOps++;
          j++;
        }
        out.push({ t: "quote", c: parseBlocks(cx, sub, depth + 1) });
        k = j;
        break;
      }
      case "list":
        k = parseList(cx, ls, k, depth, st, out);
        break;
    }
  }
  if (starts !== undefined && starts.length < out.length) starts.push(from);
  return out;
}

function parsePara(cx: Ctx, ls: Ln[], k: number, depth: number, out: MdBlock[]): number {
  alloc(cx, depth);
  const parts: string[] = [];
  let j = k;
  while (j < ls.length) {
    const lj = ls[j];
    const sj = cx.lines[lj.i];
    const pj = firstNonWs(cx, sj, lj.off);
    if (pj === sj.length) break;
    if (j > k && classify(cx, sj, pj) !== null) break;
    let e = sj.length;
    while (e > pj && isLineWs(sj.charCodeAt(e - 1))) {
      cx.stats.scanned++;
      e--;
    }
    parts.push(sj.slice(pj, e));
    cx.stats.copied += e - pj;
    j++;
  }
  const text = parts.join("\n");
  cx.stats.copied += text.length;
  out.push({ t: "para", c: parseInline(cx, text, depth + 1) });
  return j;
}

function parseFence(
  cx: Ctx,
  ls: Ln[],
  k: number,
  depth: number,
  pos: number,
  st: { ch: number; len: number; lang: string },
  out: MdBlock[],
): number {
  alloc(cx, depth);
  const lines = cx.lines;
  const indent = colsBetween(cx, lines[ls[k].i], ls[k].off, pos);
  const body: string[] = [];
  let j = k + 1;
  let closed = false;
  for (; j < ls.length; j++) {
    const lj = ls[j];
    const sj = lines[lj.i];
    const pj = firstNonWs(cx, sj, lj.off);
    // 收尾:同一种字符、不短于开头那串、后面只许空白;没有收尾就一直到容器末尾
    let q = pj;
    while (q < sj.length && sj.charCodeAt(q) === st.ch) {
      cx.stats.scanned++;
      q++;
    }
    if (q - pj >= st.len && firstNonWs(cx, sj, q) === sj.length) {
      closed = true;
      break;
    }
    const o = stripCols(cx, sj, lj.off, indent);
    body.push(sj.slice(o));
    cx.stats.copied += sj.length - o;
  }
  const s = body.join("\n");
  cx.stats.copied += s.length;
  out.push({ t: "fence", lang: st.lang, s });
  return closed ? j + 1 : j;
}

function parseList(
  cx: Ctx,
  ls: Ln[],
  k: number,
  depth: number,
  first: { ordered: boolean; num: number },
  out: MdBlock[],
): number {
  alloc(cx, depth);
  const lines = cx.lines;
  const ordered = first.ordered;
  const items: MdItem[] = [];
  let j = k;
  while (j < ls.length) {
    const lj = ls[j];
    const sj = lines[lj.i];
    const pj = firstNonWs(cx, sj, lj.off);
    const st = classify(cx, sj, pj);
    if (st === null || st.k !== "list" || st.ordered !== ordered) break;
    // 内容列 = 标记之后的空白(1–4 列);超过 4 列或标记后就是行尾,内容列 = 标记后一列
    const markCols = colsBetween(cx, sj, lj.off, pj) + (st.markEnd - pj);
    let q = st.markEnd;
    let w = 0;
    while (q < sj.length && w <= 4) {
      const c = sj.charCodeAt(q);
      if (c !== 32 && c !== 9) break;
      cx.stats.scanned++;
      w += c === 9 ? 4 : 1;
      q++;
    }
    let contentOff: number;
    let contentCol: number;
    if (q === sj.length) {
      contentOff = sj.length;
      contentCol = markCols + 1;
    } else if (w > 4) {
      contentOff = st.markEnd + 1;
      contentCol = markCols + 1;
    } else {
      contentOff = q;
      contentCol = markCols + w;
    }
    // 勾选项:必须是这一**原始行**被 checklist.ts 认出,且认出的那个 `-` 就是本项的标记
    let task: { checked: boolean } | null = null;
    if (!ordered && sj.charCodeAt(pj) === 45) {
      cx.stats.scanned += sj.length;
      const box = parseChecklistLine(sj);
      if (box !== null && firstNonWs(cx, sj, 0) === pj) {
        task = { checked: box.checked };
        contentOff = pj + 5 < sj.length && isLineWs(sj.charCodeAt(pj + 5)) ? pj + 6 : pj + 5;
      }
    }
    const itemLines: Ln[] = [{ i: lj.i, off: contentOff }];
    let m = j + 1;
    while (m < ls.length) {
      const lm = ls[m];
      const sm = lines[lm.i];
      const pm = firstNonWs(cx, sm, lm.off);
      if (pm === sm.length) itemLines.push({ i: lm.i, off: sm.length });
      else if (colsBetween(cx, sm, lm.off, pm) >= contentCol) itemLines.push({ i: lm.i, off: stripCols(cx, sm, lm.off, contentCol) });
      else break;
      cx.stats.pairOps++;
      m++;
    }
    alloc(cx, depth + 1);
    const kids = parseBlocks(cx, itemLines, depth + 2);
    items.push(task === null ? { t: "item", c: kids } : { t: "task", checked: task.checked, line: lj.i, c: kids });
    j = m;
  }
  out.push({ t: "list", ordered, start: first.num, items });
  return j;
}

// ---------------------------------------------------------------------------
// 行内
// ---------------------------------------------------------------------------

// 一趟词法扫描产出的事件。正文一律以**源区间**进事件(转义 = 跳过反斜杠的那一格区间),
// 到第二趟建树时相邻区间并起来、每个文本节点只切一次片。
type Open = { k: "open"; a: number; b: number; kind: "lit" | "strong" | "em" | "link"; url: string };
type Ev =
  | { k: "txt"; a: number; b: number }
  | Open
  | { k: "close" }
  | { k: "code"; a: number; b: number }
  | { k: "auto"; a: number; b: number; url: string }
  | { k: "img"; a: number; b: number; n: number };

type Frame = { br: true; ord: number; ev: Open } | { br: false; ch: number; len: number; ev: Open };

function isSpaceCode(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 || c === 0xa0 || c === 0x3000;
}
function isAsciiPunct(c: number): boolean {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
const WORD = /[\p{L}\p{N}]/u;

/** `i` 前面那一整个码点(生僻字是代理对,只取 `src[i-1]` 会拿到半个字、判不出是字母)。 */
function codePointBefore(src: string, i: number): string {
  const lo = src.charCodeAt(i - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && i >= 2) {
    const hi = src.charCodeAt(i - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return src.slice(i - 2, i);
  }
  return src[i - 1];
}

// 裸地址提取器:候选到这些字符为止(同桌面 renderContent 那条正则的停字,另加 Markdown 里会
// 贴着地址的 ` [ ] < >)。尾部这些标点剥掉(另加 * _ ~ ' ",好让 `**https://a.com**` 认对);
// `)` 只在不成对时剥(维基百科式 `…_(消歧义)` 不被截断)。
const URL_STOP = new Set(Array.from(" \t\n\r，。、;：！？）】《」』`[]<>"));
const URL_TAIL = new Set(Array.from(")].,;:!?，。、;:!?…）】》」』*_~'\""));

function isSpecial(c: number): boolean {
  // \ ` * _ [ ] h 图
  return c === 92 || c === 96 || c === 42 || c === 95 || c === 91 || c === 93 || c === 104 || c === 0x56fe;
}

function parseInline(cx: Ctx, src: string, depth: number): MdInline[] {
  const st = cx.stats;
  const n = src.length;

  // ② 反引号串:先按长度建「起点表」,每种长度一枚只进不退的指针 ⇒ 找闭合串均摊 O(1)。
  const runs = new Map<number, number[]>();
  const runPtr = new Map<number, number>();
  for (let i = 0; i < n; ) {
    st.scanned++;
    if (src.charCodeAt(i) !== 96) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < n && src.charCodeAt(j) === 96) {
      st.scanned++;
      j++;
    }
    let arr = runs.get(j - i);
    if (arr === undefined) {
      arr = [];
      runs.set(j - i, arr);
    }
    arr.push(i);
    st.pairOps++;
    i = j;
  }
  const closerAt = (len: number, from: number): number => {
    const arr = runs.get(len);
    if (arr === undefined) return -1;
    let p = runPtr.get(len) ?? 0;
    while (p < arr.length && arr[p] < from) {
      st.pairOps++;
      p++;
    }
    runPtr.set(len, p);
    return p < arr.length ? arr[p] : -1;
  };

  // 链接目标:第一次遇到 `](` 才建三张表(余额下一次跌破处 / 下一个空白 / 下一个 `]`)。
  let lower: Int32Array | null = null;
  let nextWs: Int32Array | null = null;
  let nextRb: Int32Array | null = null;
  const prepDest = (): void => {
    const bal = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) {
      st.scanned++;
      const c = src.charCodeAt(i);
      bal[i + 1] = bal[i] + (c === 40 ? 1 : c === 41 ? -1 : 0);
    }
    // lower[i] = 最小的 k > i 使 bal[k] < bal[i](单调栈,每个下标进出一次)
    lower = new Int32Array(n + 1);
    const stack = new Int32Array(n + 1);
    let top = 0;
    for (let i = n; i >= 0; i--) {
      while (top > 0 && bal[stack[top - 1]] >= bal[i]) {
        st.pairOps++;
        top--;
      }
      lower[i] = top > 0 ? stack[top - 1] : -1;
      stack[top++] = i;
      st.pairOps++;
    }
    nextWs = new Int32Array(n + 1);
    nextRb = new Int32Array(n + 1);
    nextWs[n] = n;
    nextRb[n] = n;
    for (let i = n - 1; i >= 0; i--) {
      st.scanned++;
      const c = src.charCodeAt(i);
      nextWs[i] = isSpaceCode(c) ? i : nextWs[i + 1];
      nextRb[i] = c === 93 ? i : nextRb[i + 1];
    }
  };
  /** `(` 之后从 `s` 起的链接目标在哪儿结束(那个 `)` 的下标);不成立就 `null`。 */
  const destEnd = (s: number): number | null => {
    if (lower === null) prepDest();
    const k = lower![s];
    if (k < 0) return null;
    const e = k - 1;
    if (e <= s || e - s > URL_MAX_LEN) return null;
    if (nextWs![s] < e || nextRb![s] < e) return null;
    return e;
  };

  const evs: Ev[] = [];
  const pushText = (a: number, b: number): void => {
    const last = evs.length > 0 ? evs[evs.length - 1] : null;
    if (last !== null && last.k === "txt" && last.b === a) last.b = b;
    else evs.push({ k: "txt", a, b });
  };
  const frames: Frame[] = [];
  let emph = 0; // 栈上的粗斜层数(≤ 2)
  let brCount = 0; // 栈上的方括号数
  let floor = 0; // 序号低于它的方括号已失效(刚成了一条链接,链接里不再套链接)

  let i = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    st.scanned++;
    if (c === 92) {
      // 反斜杠转义:后面是 ASCII 标点就只留那个字
      if (i + 1 < n && isAsciiPunct(src.charCodeAt(i + 1))) {
        pushText(i + 1, i + 2);
        i += 2;
      } else {
        pushText(i, i + 1);
        i++;
      }
      continue;
    }
    if (c === 96) {
      let j = i + 1;
      while (j < n && src.charCodeAt(j) === 96) {
        st.scanned++;
        j++;
      }
      const len = j - i;
      const close = closerAt(len, j);
      if (close < 0) {
        pushText(i, j);
        i = j;
        continue;
      }
      // 内容两头各有一个空格(且不全是空格)就各剥一个,好写出贴着反引号的 `` ` ``
      let a = j;
      let b = close;
      if (b - a >= 2 && src.charCodeAt(a) === 32 && src.charCodeAt(b - 1) === 32) {
        let allSpace = true;
        for (let p = a; p < b; p++) {
          st.scanned++;
          if (src.charCodeAt(p) !== 32) {
            allSpace = false;
            break;
          }
        }
        if (!allSpace) {
          a++;
          b--;
        }
      }
      evs.push({ k: "code", a, b });
      i = close + len;
      continue;
    }
    if (c === 42 || c === 95) {
      let j = i + 1;
      while (j < n && src.charCodeAt(j) === c) {
        st.scanned++;
        j++;
      }
      const len = j - i;
      if (len > 2) {
        pushText(i, j);
        i = j;
        continue;
      }
      const prev = i > 0 ? src.charCodeAt(i - 1) : -1;
      const next = j < n ? src.charCodeAt(j) : -1;
      let canOpen = next >= 0 && !isSpaceCode(next);
      let canClose = prev >= 0 && !isSpaceCode(prev);
      if (c === 95) {
        if (prev >= 0 && WORD.test(codePointBefore(src, i))) canOpen = false;
        if (next >= 0 && WORD.test(String.fromCodePoint(src.codePointAt(j)!))) canClose = false;
      }
      if (canClose) {
        // 只在最近一个方括号之上找(≤ 2 层):同字符、同长度的开符
        let f = frames.length - 1;
        let hit = -1;
        for (; f >= 0; f--) {
          st.pairOps++;
          const fr = frames[f];
          if (fr.br) break;
          if (fr.ch === c && fr.len === len) {
            hit = f;
            break;
          }
        }
        if (hit >= 0) {
          while (frames.length - 1 > hit) {
            frames.pop(); // 夹在中间没配上的:原文
            emph--;
            st.pairOps++;
          }
          const fr = frames.pop()!;
          emph--;
          st.pairOps++;
          fr.ev.kind = len === 2 ? "strong" : "em";
          evs.push({ k: "close" });
          i = j;
          continue;
        }
      }
      if (canOpen && emph < 2) {
        const ev: Open = { k: "open", a: i, b: j, kind: "lit", url: "" };
        evs.push(ev);
        frames.push({ br: false, ch: c, len, ev });
        emph++;
        st.pairOps++;
        i = j;
        continue;
      }
      pushText(i, j);
      i = j;
      continue;
    }
    if (c === 91) {
      const ev: Open = { k: "open", a: i, b: i + 1, kind: "lit", url: "" };
      evs.push(ev);
      frames.push({ br: true, ord: brCount, ev });
      brCount++;
      st.pairOps++;
      i++;
      continue;
    }
    if (c === 93) {
      let f = frames.length - 1;
      while (f >= 0 && !frames[f].br) {
        st.pairOps++;
        f--;
      }
      if (f < 0) {
        pushText(i, i + 1);
        i++;
        continue;
      }
      while (frames.length - 1 > f) {
        frames.pop(); // 方括号里没配上的粗斜:原文
        emph--;
        st.pairOps++;
      }
      const fr = frames.pop()! as { br: true; ord: number; ev: Open };
      brCount--;
      st.pairOps++;
      const active = fr.ord >= floor;
      if (floor > brCount) floor = brCount;
      if (active && i + 1 < n && src.charCodeAt(i + 1) === 40) {
        const e = destEnd(i + 2);
        if (e !== null) {
          st.copied += e - (i + 2);
          const url = validateHttpUrl(src.slice(i + 2, e));
          if (url !== null) {
            fr.ev.kind = "link";
            fr.ev.url = url;
            evs.push({ k: "close" });
            floor = brCount;
            i = e + 1;
            continue;
          }
        }
      }
      // 不成链接(没有目标 / 目标不合法 / 已在链接里):`[` 与 `]` 都按原文
      pushText(i, i + 1);
      i++;
      continue;
    }
    if (c === 0x56fe) {
      let j = i + 1;
      while (j < n) {
        const d = src.charCodeAt(j);
        if (d < 48 || d > 57) break;
        st.scanned++;
        j++;
      }
      const digits = j - i - 1;
      if (digits >= 1 && digits <= 6) {
        st.copied += digits;
        evs.push({ k: "img", a: i, b: j, n: Number(src.slice(i + 1, j)) });
      } else pushText(i, j);
      i = j;
      continue;
    }
    if (c === 104 && urlAt(src, i, st)) {
      let j = i;
      let opens = 0;
      let closes = 0;
      while (j < n && !URL_STOP.has(src[j])) {
        st.scanned++;
        const d = src.charCodeAt(j);
        if (d === 40) opens++;
        else if (d === 41) closes++;
        j++;
      }
      let e = j;
      while (e > i && URL_TAIL.has(src[e - 1])) {
        st.scanned++;
        if (src.charCodeAt(e - 1) === 41) {
          if (opens >= closes) break; // 成对的 ) 是地址的一部分
          closes--;
        }
        e--;
      }
      st.copied += e - i;
      const url = e - i <= URL_MAX_LEN ? validateHttpUrl(src.slice(i, e)) : null;
      if (url !== null) evs.push({ k: "auto", a: i, b: e, url });
      else pushText(i, e);
      i = e;
      continue;
    }
    // 普通文字:一口气走到下一个特殊字符(`h` 只在真是地址开头时才算)
    let j = i + 1;
    while (j < n) {
      const d = src.charCodeAt(j);
      if (isSpecial(d) && !(d === 104 && !urlAt(src, j, st))) break;
      st.scanned++;
      j++;
    }
    pushText(i, j);
    i = j;
  }
  // 收尾时栈上剩下的开符:默认就是 "lit"(原文),什么都不用做。

  return buildInline(cx, src, evs, depth);
}

function urlAt(src: string, i: number, st: MdStats): boolean {
  st.scanned += 8;
  return src.startsWith("http://", i) || src.startsWith("https://", i);
}

/** 第二趟:事件 → 节点。相邻的源区间并成一段,每个文本节点只切 / 拼一次;每个节点先查预算。 */
function buildInline(cx: Ctx, src: string, evs: Ev[], depth: number): MdInline[] {
  const st = cx.stats;
  const root: MdInline[] = [];
  const stack: { c: MdInline[]; link: boolean }[] = [];
  let cur = root;
  let d = depth;
  let inLink = false;
  let ra = -1;
  let rb = -1;
  const parts: string[] = [];
  const flushRange = (): void => {
    if (ra < 0) return;
    parts.push(src.slice(ra, rb));
    st.copied += rb - ra;
    ra = -1;
  };
  const addRange = (a: number, b: number): void => {
    if (a === b) return;
    if (ra >= 0 && rb === a) {
      rb = b;
      return;
    }
    flushRange();
    ra = a;
    rb = b;
  };
  const flushText = (): void => {
    flushRange();
    if (parts.length === 0) return;
    alloc(cx, d);
    let s = parts[0];
    if (parts.length > 1) {
      s = parts.join("");
      st.copied += s.length;
    }
    cur.push({ t: "text", s });
    parts.length = 0;
  };
  for (const ev of evs) {
    switch (ev.k) {
      case "txt":
        addRange(ev.a, ev.b);
        break;
      case "open": {
        if (ev.kind === "lit") {
          addRange(ev.a, ev.b);
          break;
        }
        if (ev.kind === "link" && inLink) throw new Error("markdown: 链接里又套了链接(方括号失效表坏了)");
        flushText();
        alloc(cx, d);
        const c: MdInline[] = [];
        cur.push(ev.kind === "link" ? { t: "link", url: ev.url, bare: false, c } : { t: ev.kind, c });
        stack.push({ c: cur, link: inLink });
        cur = c;
        d++;
        if (ev.kind === "link") inLink = true;
        break;
      }
      case "close": {
        flushText();
        const up = stack.pop();
        if (up === undefined) throw new Error("markdown: 多出一个闭合事件");
        cur = up.c;
        inLink = up.link;
        d--;
        break;
      }
      case "code":
        flushText();
        alloc(cx, d);
        st.copied += ev.b - ev.a;
        cur.push({ t: "code", s: src.slice(ev.a, ev.b) });
        break;
      case "auto":
        // 链接文字里的裸地址 / 图N 只当字(链接里不套链接、不套按钮)
        if (inLink) {
          addRange(ev.a, ev.b);
          break;
        }
        flushText();
        alloc(cx, d);
        alloc(cx, d + 1);
        st.copied += ev.b - ev.a;
        cur.push({ t: "link", url: ev.url, bare: true, c: [{ t: "text", s: src.slice(ev.a, ev.b) }] });
        break;
      case "img":
        if (inLink) {
          addRange(ev.a, ev.b);
          break;
        }
        flushText();
        alloc(cx, d);
        cur.push({ t: "img", n: ev.n });
        break;
    }
  }
  flushText();
  if (stack.length !== 0) throw new Error("markdown: 有开无闭");
  return root;
}

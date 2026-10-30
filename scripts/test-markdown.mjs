#!/usr/bin/env node
// 长文 Markdown(shared/markdown.ts + markdown-dom.ts)的单测。跑法:node scripts/test-markdown.mjs
// 阴性对照:node scripts/knives-markdown.mjs(每把刀都必须让这里真红)。
//
// 测的是**真源码**:esbuild 现场把两份 .ts 打成一个模块再 import(同 check-filter-parity 的路数),
// 不抄一遍逻辑。DOM 侧用一个**记账的假 DOM** 当观测装置:每一次属性写入、setAttribute、
// 建的每个标签都记下来,再对照「字段唯一去向」那张表断言 —— 它记不到的东西(真 webview 里的
// 导航 / 网络)不在本脚本的证明范围内,那是真机验收那一格的事。
//
// 资源族:每族 32 / 64 / 128 / 200 KiB(核实际 UTF-8 字节),断计数器 ≤ C·n + B,同时断输出
// (合法语法真被认出、或明确降级)。墙钟只当烟测,放宽到比线性预期高一个数量级仍算过。
import { build } from "esbuild";
import { test } from "node:test";
import assert from "node:assert/strict";

const r = await build({
  stdin: {
    contents: 'export * from "./shared/markdown"; export * from "./shared/markdown-dom"; export * from "./shared/checklist";',
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "esm",
});
const M = await import("data:text/javascript," + encodeURIComponent(r.outputFiles[0].text));
const { parseMarkdown, validateHttpUrl, renderMarkdown, toggleChecklistLine, scanImgRefs, gutterCols, MD_MAX_NODES, MD_MAX_DEPTH, MD_MAX_BYTES } = M;

// ---------------------------------------------------------------------------
// 语法树 → 紧凑字符串(只为断言好读)
// ---------------------------------------------------------------------------
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function ast(xs) {
  return xs.map(node).join("");
}
function node(x) {
  switch (x.t) {
    case "heading": return `<h${x.level}>${ast(x.c)}</h${x.level}>`;
    case "para": return `<p>${ast(x.c)}</p>`;
    case "list": return x.ordered ? `<ol${x.start !== 1 ? ` start=${x.start}` : ""}>${ast(x.items)}</ol>` : `<ul>${ast(x.items)}</ul>`;
    case "item": return `<li>${ast(x.c)}</li>`;
    case "task": return `<li task=${x.checked ? "x" : "_"} line=${x.line}>${ast(x.c)}</li>`;
    case "quote": return `<q>${ast(x.c)}</q>`;
    case "fence": return `<pre${x.lang ? ` lang=${x.lang}` : ""}>${esc(x.s)}</pre>`;
    case "hr": return "<hr>";
    case "text": return esc(x.s);
    case "strong": return `<b>${ast(x.c)}</b>`;
    case "em": return `<i>${ast(x.c)}</i>`;
    case "code": return `<code>${esc(x.s)}</code>`;
    case "link": return `<a${x.bare ? " bare" : ""} url=${x.url}>${ast(x.c)}</a>`;
    case "img": return `<img ${x.n}>`;
    default: throw new Error("未知节点 " + x.t);
  }
}
function md(text) {
  const r = parseMarkdown(text);
  assert.ok(r.ok, `本该解析成功:${r.reason}`);
  return ast(r.blocks);
}

// ---------------------------------------------------------------------------
// 1. URL 校验器
// ---------------------------------------------------------------------------
test("校验器:http/https 收下并规范化", () => {
  assert.equal(validateHttpUrl("https://a.com"), "https://a.com/");
  assert.equal(validateHttpUrl("HTTP://A.COM/x?y=1#z"), "http://a.com/x?y=1#z");
  assert.equal(validateHttpUrl("https://例子.中国/路径"), "https://xn--fsqu00a.xn--fiqs8s/%E8%B7%AF%E5%BE%84");
});
test("校验器:别的协议、相对地址、控制字符、超长一律拒", () => {
  const bad = [
    "javascript:alert(1)", "JaVaScRiPt:alert(1)", "javascript:https://a.com", "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd", "mailto:a@x?body=https://e.com", "tel:110", "vbscript:x", "ftp://a.com",
    "//a.com", "/x", "a.com", "https://", "",
    "java\nscript:alert(1)", "https://a.com/\n", "https://a.com/\t", "\u0000https://a.com", " https://a.com",
    "https://a.com/ x", "https://a.com/\u0085", "https://a.com/\u007f",
    "https://a.com/" + "x".repeat(5000),
  ];
  for (const u of bad) assert.equal(validateHttpUrl(u), null, JSON.stringify(u));
});

// ---------------------------------------------------------------------------
// 2. 块
// ---------------------------------------------------------------------------
test("标题只认 1–3 级,# 后要空白", () => {
  assert.equal(md("# 一\n## 二\n### 三"), "<h1>一</h1><h2>二</h2><h3>三</h3>");
  assert.equal(md("#### 四"), "<p>#### 四</p>");
  assert.equal(md("#标签"), "<p>#标签</p>");
  assert.equal(md("## 收尾 ##"), "<h2>收尾</h2>");
  assert.equal(md("## C#"), "<h2>C#</h2>");
});
test("段落保留换行,空行分段", () => {
  assert.equal(md("第一行\n第二行  \n\n第二段"), "<p>第一行\n第二行</p><p>第二段</p>");
});
test("分隔线先于列表", () => {
  assert.equal(md("---\n- - -\n***\n__ _"), "<hr><hr><hr><hr>");
});
test("列表:无序 / 有序 / 起始号 / 嵌套 / 换种类另起", () => {
  assert.equal(md("- a\n- b\n* c"), "<ul><li><p>a</p></li><li><p>b</p></li><li><p>c</p></li></ul>");
  assert.equal(md("3. a\n4) b"), "<ol start=3><li><p>a</p></li><li><p>b</p></li></ol>");
  assert.equal(md("- a\n  - b\n- c"), "<ul><li><p>a</p><ul><li><p>b</p></li></ul></li><li><p>c</p></li></ul>");
  assert.equal(md("- a\n1. b"), "<ul><li><p>a</p></li></ul><ol><li><p>b</p></li></ol>");
  assert.equal(md("- a\n\n  续\n\n不缩进"), "<ul><li><p>a</p><p>续</p></li></ul><p>不缩进</p>");
  assert.equal(md("1234567890. 太长"), "<p>1234567890. 太长</p>");
});
test("勾选项:只认 checklist 那一种行,行号能直接拿去翻", () => {
  const src = "说明\n\n- [ ] 甲\n- [x] 乙\n  - [X] 丙\n* [ ] 星号不算\n- [x]贴着不算\n> - [ ] 引用里不算";
  assert.equal(
    md(src),
    "<p>说明</p><ul><li task=_ line=2><p>甲</p></li><li task=x line=3><p>乙</p><ul><li task=x line=4><p>丙</p></li></ul></li>" +
      "<li><p>[ ] 星号不算</p></li><li><p>[x]贴着不算</p></li></ul><q><ul><li><p>[ ] 引用里不算</p></li></ul></q>",
  );
  // 闭环:语法树给的每个行号,toggleChecklistLine 都翻得动
  const r = parseMarkdown(src);
  const lines = [];
  const walk = (xs) => xs.forEach((x) => { if (x.t === "task") lines.push(x.line); for (const k of x.c ?? x.items ?? []) if (typeof k === "object") walk([k]); });
  walk(r.blocks);
  assert.deepEqual(lines, [2, 3, 4]);
  for (const l of lines) assert.notEqual(toggleChecklistLine(src, l), null);
});
test("引用:每行要带 >,可嵌套", () => {
  assert.equal(md("> a\n> > b\n> c\n不带"), "<q><p>a</p><q><p>b</p></q><p>c</p></q><p>不带</p>");
});
test("围栏:原文不解析;未闭合到容器末尾;语言标记只取第一个词", () => {
  assert.equal(md("```js extra\n# 不是标题\n*不斜*\n```\n后"), "<pre lang=js># 不是标题\n*不斜*</pre><p>后</p>");
  assert.equal(md("~~~\n<script>\n"), "<pre>&lt;script&gt;\n</pre>");
  assert.equal(md("> ```\n> 里\n外"), "<q><pre>里</pre></q><p>外</p>");
  assert.equal(md("``` a`b\nx"), "<p>``` a`b\nx</p>"); // ` 围栏的信息串里有 ` ⇒ 不是围栏
});

// ---------------------------------------------------------------------------
// 3. 行内
// ---------------------------------------------------------------------------
test("粗斜:中文贴字成立、snake_case 不斜、三连当原文、最多两层", () => {
  assert.equal(md("中文**粗体**中文"), "<p>中文<b>粗体</b>中文</p>");
  assert.equal(md("*斜* 与 _斜_"), "<p><i>斜</i> 与 <i>斜</i></p>");
  assert.equal(md("snake_case_name"), "<p>snake_case_name</p>");
  assert.equal(md("𠀀_甲_"), "<p>𠀀_甲_</p>"); // 生僻字是代理对:得按整个码点判「贴着字」
  assert.equal(md("甲_乙_𠀀"), "<p>甲_乙_𠀀</p>");
  assert.equal(md("***三***"), "<p>***三***</p>");
  assert.equal(md("**粗*斜*粗**"), "<p><b>粗<i>斜</i>粗</b></p>");
  assert.equal(md("**a *b _c_ b* a**"), "<p><b>a <i>b _c_ b</i> a</b></p>");
  assert.equal(md("a * b * c"), "<p>a * b * c</p>");
  assert.equal(md("**没收尾"), "<p>**没收尾</p>");
});
test("行内代码:同长度闭合、里面不解析、两头空格各剥一个", () => {
  assert.equal(md("`*x*` 与 `` a`b `` 与 ` `` `"), "<p><code>*x*</code> 与 <code>a`b</code> 与 <code>``</code></p>");
  assert.equal(md("``没闭合`"), "<p>``没闭合`</p>");
  assert.equal(md("`[a](https://a.com)`"), "<p><code>[a](https://a.com)</code></p>");
});
test("转义", () => {
  // 转义掉的 [ 让后面不成 Markdown 链接;括号里的地址照常按裸地址认
  assert.equal(md("\\*不斜\\* \\[不是链接](https://a.com) \\a"), "<p>*不斜* [不是链接](<a bare url=https://a.com/>https://a.com</a>) \\a</p>");
});
test("链接:合法的成链接,不合法的整段原文", () => {
  assert.equal(md("[甲](https://a.com/x)"), "<p><a url=https://a.com/x>甲</a></p>");
  assert.equal(md("[维基](https://zh.wikipedia.org/wiki/A_(B))后"), "<p><a url=https://zh.wikipedia.org/wiki/A_(B)>维基</a>后</p>");
  assert.equal(md("[**粗**](https://a.com)"), "<p><a url=https://a.com/><b>粗</b></a></p>");
  for (const t of ["[x](javascript:alert(1))", "[x](data:text/html,1)", "[x]()", "[x](//a.com)"])
    assert.equal(md(t), `<p>${esc(t)}</p>`, t);
  // 目标里不许有 ](头注那条:保住「每次试配的目标区间两两不交」);裸地址也在 [ 停
  assert.equal(md("[x](https://a.com/[1])"), "<p>[x](<a bare url=https://a.com/>https://a.com/</a>[1])</p>");
  // 不成 Markdown 链接,但目标里嵌着的 https 片段照常是裸地址 —— 点下去开的就是显示出来的那个
  // https 地址,⛔ 绝不是外层的 mailto(那正是「拿提取器 .test(整串)」会放过的形)
  assert.equal(md("[x](mailto:a@x?body=https://e.com)"), "<p>[x](mailto:a@x?body=<a bare url=https://e.com/>https://e.com</a>)</p>");
  assert.equal(md("[x](https://a.com y)"), "<p>[x](<a bare url=https://a.com/>https://a.com</a> y)</p>");
  assert.equal(md("[x] (https://a.com)"), "<p>[x] (<a bare url=https://a.com/>https://a.com</a>)</p>");
  assert.equal(md("[x](https://a.com"), "<p>[x](<a bare url=https://a.com/>https://a.com</a></p>");
});
test("裸地址:剥尾部标点、成对括号保留、贴着粗体也认对", () => {
  assert.equal(md("见 https://a.com。"), "<p>见 <a bare url=https://a.com/>https://a.com</a>。</p>");
  assert.equal(md("(https://a.com/x_(y))"), "<p>(<a bare url=https://a.com/x_(y)>https://a.com/x_(y)</a>)</p>");
  assert.equal(md("**https://a.com**"), "<p><b><a bare url=https://a.com/>https://a.com</a></b></p>");
  assert.equal(md("https:// 空的"), "<p>https:// 空的</p>");
});
test("链接里不套链接:里面的裸地址 / 图N / 内层链接都当字", () => {
  assert.equal(md("[https://b.com 图1](https://a.com)"), "<p><a url=https://a.com/>https://b.com 图1</a></p>");
  // 内层先成了链接 ⇒ 外层方括号失效,`](…)` 只剩原文(里面的地址照常按裸地址认)
  assert.equal(md("[外 [内](https://b.com)](https://a.com)"), "<p>[外 <a url=https://b.com/>内</a>](<a bare url=https://a.com/>https://a.com</a>)</p>");
});
test("图N:1–6 位数字", () => {
  assert.equal(md("见图3、图12"), "<p>见<img 3>、<img 12></p>");
  assert.equal(md("图1234567 与 图"), "<p>图1234567 与 图</p>");
});
test("方括号没配上就是原文", () => {
  assert.equal(md("[1] [2 ]] [[ x"), "<p>[1] [2 ]] [[ x</p>");
});

// ---------------------------------------------------------------------------
// 4. 预算与降级
// ---------------------------------------------------------------------------
test("字节预算按 UTF-8 数,恰好到顶还解析", () => {
  assert.equal(parseMarkdown("a".repeat(MD_MAX_BYTES)).ok, true);
  assert.equal(parseMarkdown("a".repeat(MD_MAX_BYTES + 1)).reason, "bytes");
  assert.equal(parseMarkdown("中".repeat(68_266) + "aa").ok, true); // 204,798 + 2
  assert.equal(parseMarkdown("中".repeat(68_267)).reason, "bytes"); // 204,801
  assert.equal(parseMarkdown("😀".repeat(51_201)).reason, "bytes"); // 204,804
});
test("深度预算:所有节点都计", () => {
  assert.equal(parseMarkdown(">".repeat(MD_MAX_DEPTH - 2) + " x").ok, true); // 引用 1..14、段落 15、文本 16
  assert.equal(parseMarkdown(">".repeat(MD_MAX_DEPTH - 1) + " x").reason, "depth"); // 文本落在 17
  assert.equal(parseMarkdown(">".repeat(5000)).reason, "depth");
  assert.equal(parseMarkdown("- ".repeat(9) + "x").reason, "depth"); // 列表 + 项 每层 2
});
test("节点预算:超了整篇降级,不留半截", () => {
  const many = "- a\n".repeat(Math.ceil(MD_MAX_NODES / 3) + 10); // 每项 = 项 + 段落 + 文本
  const r = parseMarkdown(many);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "nodes");
  const fine = "- a\n".repeat(1000);
  assert.equal(parseMarkdown(fine).ok, true);
});

// ---------------------------------------------------------------------------
// 5. DOM:记账的假 DOM
// ---------------------------------------------------------------------------
function fakeDom() {
  const log = { tags: [], props: [], attrs: [], listeners: [] };
  const mkEl = (tag) => {
    log.tags.push(tag);
    const t = {
      nodeType: 1, tag, kids: [], on: {}, attrs: {}, className: "", tabIndex: -1,
      append(...ns) { for (const n of ns) this.kids.push(typeof n === "string" ? { nodeType: 3, data: n } : n); },
      setAttribute(k, v) { log.attrs.push(k); this.attrs[k] = String(v); },
      addEventListener(type, fn) { log.listeners.push(type); (this.on[type] ??= []).push(fn); },
    };
    return new Proxy(t, {
      set(o, k, v) { log.props.push(String(k)); o[k] = v; return true; },
    });
  };
  const document = { createElement: mkEl, createTextNode: (s) => ({ nodeType: 3, data: s }) };
  return { document, log };
}
function html(n) {
  if (n.nodeType === 3) return esc(n.data);
  const attrs = Object.entries(n.attrs).map(([k, v]) => ` ${k}=${v}`).join("");
  const cls = n.className ? ` .${n.className.replace(/ /g, ".")}` : "";
  return `<${n.tag}${cls}${attrs}>${n.kids.map(html).join("")}</${n.tag}>`;
}
function render(text, hooks = {}) {
  const { document, log } = fakeDom();
  globalThis.document = document;
  const opened = [];
  // 钩子只交「字符串 + 回调」,⛔ 不碰 document —— 节点全由渲染器建(才都在预算与去向表里)
  const h = {
    openLink: (u) => opened.push(u),
    image: (n) => (n === 1 ? { label: `图${n}`, open: () => opened.push(`img:${n}`), src: () => `blob:app/${n}` } : null),
    checkbox: (checked, line) => ({ label: checked ? "取消勾选" : "勾上", toggle: () => opened.push(`tick:${line}`) }),
    ...hooks,
  };
  const out = renderMarkdown(text, h);
  delete globalThis.document;
  return { ...out, log, opened, html: html(out.root) };
}
const ALLOWED_TAGS = new Set(["div", "p", "h1", "h2", "h3", "strong", "em", "code", "pre", "ul", "ol", "li", "blockquote", "hr", "a", "span", "button", "img"]);
const ALLOWED_PROPS = new Set(["className", "tabIndex", "start", "type", "title", "disabled", "alt", "src"]);
const ALLOWED_ATTRS = new Set(["role", "aria-label"]);

const EVIL = [
  "<img src=x onerror=alert(1)>", "<script>alert(1)</script>", "<iframe srcdoc='<script>1</script>'>",
  "[x](javascript:alert(1))", "[x](JAVASCRIPT:alert(1))", "[x](java\tscript:alert(1))", "[x](data:text/html,<b>1</b>)",
  "[x](mailto:a@x?body=https://e.com)", "[x](https://a.com\" onclick=\"alert(1))", "[x](<https://a.com>)",
  "```\" onmouseover=\"alert(1)\n</pre><script>1</script>", "``` <img src=x onerror=1>\nx\n```",
  "# <b onclick=1>标题</b>", "- [ ] <svg onload=alert(1)>", "> `</code><script>`", "图1<img>", "**<i>**",
  "https://a.com/<script>", "[a](https://a.com/x'onerror='1)", "图1", "图1\n<img src=x onerror=1>", "图1 [x](javascript:1)",
].join("\n\n");

test("恶意输入:所有字段只进固定标签 / 文本节点 / 闭包", () => {
  const r = render(EVIL);
  assert.equal(r.degraded, null);
  for (const t of r.log.tags) assert.ok(ALLOWED_TAGS.has(t), `出现了不在表里的标签 ${t}`);
  for (const p of r.log.props) assert.ok(ALLOWED_PROPS.has(p), `写了不在表里的属性 ${p}`);
  for (const a of r.log.attrs) assert.ok(ALLOWED_ATTRS.has(a), `setAttribute 了不在表里的 ${a}`);
  for (const l of r.log.listeners) assert.ok(l === "click" || l === "keydown", l);
  // 恶意片段都原样当字出现了(不是被吞掉)
  for (const frag of ["&lt;img src=x onerror=alert(1)&gt;", "&lt;script&gt;alert(1)&lt;/script&gt;", "[x](javascript:alert(1))", "[x](mailto:a@x?body="])
    assert.ok(r.html.includes(frag), `没找到原文 ${frag}`);
  // 只有合法的那几个地址成了可点的东西;没有任何 href
  assert.ok(!r.html.includes("href"));
});
test("链接点击:只走闭包里的规范化地址,点击出口再验一次", () => {
  const r = render("[甲](HTTPS://A.com/x) 与 https://b.com。");
  const links = [];
  const walk = (n) => { if (n.nodeType === 1) { if (n.tag === "a") links.push(n); n.kids.forEach(walk); } };
  walk(r.root);
  assert.equal(links.length, 2);
  const ev = () => ({ prevented: 0, stopped: 0, key: "Enter", preventDefault() { this.prevented++; }, stopPropagation() { this.stopped++; } });
  for (const a of links) {
    assert.equal(a.attrs.role, "link");
    const e = ev();
    a.on.click[0](e);
    assert.equal(e.prevented, 1);
    a.on.keydown[0](ev());
  }
  assert.deepEqual(r.opened, ["https://a.com/x", "https://a.com/x", "https://b.com/", "https://b.com/"]);
});
test("打不开外部浏览器的平台:链接只显示文字与地址,不挂监听", () => {
  const r = render("[甲](https://a.com) 与 https://b.com", { openLink: null });
  assert.equal(r.html, '<div .md><p><span .md-link-off>甲 (https://a.com/)</span> 与 <span .md-link-off>https://b.com</span></p></div>');
  assert.equal(r.log.listeners.length, 0);
});
test("图N 与方框:渲染器自己建,钩子只给文案与动作;查不到的图按原文", () => {
  const r = render("见图1 与图2\n\n- [x] 做完");
  assert.equal(
    r.html,
    '<div .md><p>见<button .img-ref>图1</button> 与图2</p><ul><li .md-task.on><button .ckbox aria-label=取消勾选></button><p>做完</p></li></ul></div>',
  );
  const buttons = [];
  const walk = (n) => { if (n.nodeType === 1) { if (n.tag === "button") buttons.push(n); n.kids.forEach(walk); } };
  walk(r.root);
  const ev = () => ({ stopped: 0, stopPropagation() { this.stopped++; } });
  for (const b of buttons) {
    const e = ev();
    b.on.click[0](e);
    assert.equal(e.stopped, 1);
  }
  assert.deepEqual(r.opened, ["img:1", "tick:2"]);
  // 只读视图:方框禁用、不挂监听
  const ro = render("- [ ] 只读", { checkbox: () => ({ label: "未勾", toggle: null }) });
  assert.ok(ro.log.props.includes("disabled"));
  assert.equal(ro.log.listeners.length, 0);
});
test("单独成段的图N 原位画成图;src 只取钩子交回的串,段里夹了别的就照段落画", () => {
  const r = render("图1\n\n图1\n图1\n\n见图1\n\n图1 图2\n\n图1 x\n\n> 图1");
  assert.equal(
    r.html,
    "<div .md>" +
      "<div .md-figs><button .md-fig aria-label=图1><img></img></button></div>" +
      "<div .md-figs><button .md-fig aria-label=图1><img></img></button><button .md-fig aria-label=图1><img></img></button></div>" +
      "<p>见<button .img-ref>图1</button></p>" +
      "<p><button .img-ref>图1</button> 图2</p>" +
      "<p><button .img-ref>图1</button> x</p>" +
      "<blockquote><div .md-figs><button .md-fig aria-label=图1><img></img></button></div></blockquote>" +
      "</div>",
  );
  const imgs = [];
  const walk = (n) => { if (n.nodeType === 1) { if (n.tag === "img") imgs.push(n); n.kids.forEach(walk); } };
  walk(r.root);
  assert.equal(imgs.length, 4);
  for (const i of imgs) {
    assert.equal(i.src, "blob:app/1");
    assert.equal(i.alt, "图1");
  }
  // 点图 = 钩子的 open,且不往外冒(卡片 / 面板上还有别的点击主)
  const figs = [];
  const walkF = (n) => { if (n.nodeType === 1) { if (n.className === "md-fig") figs.push(n); n.kids.forEach(walkF); } };
  walkF(r.root);
  const e = { stopped: 0, stopPropagation() { this.stopped++; } };
  figs[0].on.click[0](e);
  assert.equal(e.stopped, 1);
  assert.deepEqual(r.opened, ["img:1"]);
});
test("原位图的图址晚到:Promise 落了才写 src,拒了只标坏、不写", async () => {
  let ok;
  const late = render("图1", { image: () => ({ label: "图1", open() {}, src: () => new Promise((r) => (ok = r)) }) });
  const pic = late.root.kids[0].kids[0].kids[0];
  assert.equal(pic.tag, "img");
  assert.equal(pic.src, undefined);
  ok("blob:app/late");
  await Promise.resolve();
  assert.equal(pic.src, "blob:app/late");
  const bad = render("图1", { image: () => ({ label: "图1", open() {}, src: () => Promise.reject(new Error("x")) }) });
  const fig = bad.root.kids[0].kids[0];
  fig.classList = { add: (c) => (fig.className += ` ${c}`) };
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(fig.className, "md-fig broken");
  assert.equal(fig.kids[0].src, undefined);
});
test("校验器对自己的输出闭合:规范化后变长的地址也点得开(codex 2a 一弹 M)", () => {
  for (const u of ["https://a.com", "HTTP://A.COM/x?y=1#z", "https://例子.中国/路径", "https://a.com/" + "中".repeat(400), "https://a.com/a b"]) {
    const v = validateHttpUrl(u);
    if (v !== null) assert.equal(validateHttpUrl(v), v, u);
  }
  // 400 个汉字:原文 414、规范化 3614 ≤ 4096 ⇒ 成链接、点得开
  const ok = render(`[x](https://a.com/${"中".repeat(400)})`);
  assert.equal(ok.log.listeners.includes("click"), true);
  const links = [];
  const walk = (n) => { if (n.nodeType === 1) { if (n.tag === "a") links.push(n); n.kids.forEach(walk); } };
  walk(ok.root);
  links[0].on.click[0]({ preventDefault() {}, stopPropagation() {} });
  assert.equal(ok.opened.length, 1);
  // 500 个汉字:原文 514、规范化 4514 > 4096 ⇒ 不成链接(Markdown 与裸地址都是)
  assert.equal(md(`[x](https://a.com/${"中".repeat(500)})`).includes("<a"), false);
  assert.equal(md(`https://a.com/${"中".repeat(500)}`).includes("<a"), false);
});
test("有序列表起始号走数值属性", () => {
  const r = render("7. a");
  assert.ok(r.log.props.includes("start"));
  assert.ok(!r.log.attrs.includes("start"));
  assert.equal(render("1. a").log.props.includes("start"), false);
});
test("DOM 预算:语法树没超而 DOM 超了也整篇降级", () => {
  const src = "```\nx\n```\n".repeat(6000); // 6000 个树节点、每个 3 个 DOM 节点
  assert.equal(parseMarkdown(src).ok, true);
  const r = render(src);
  assert.equal(r.degraded, "dom");
  assert.equal(r.html, `<div .md.md-plain>${esc(src)}</div>`);
});
test("解析阶段超预算:按原文显示", () => {
  const r = render(">".repeat(100));
  assert.equal(r.degraded, "depth");
  assert.equal(r.html, `<div .md.md-plain>${">".repeat(100).replace(/>/g, "&gt;")}</div>`);
});

// ---------------------------------------------------------------------------
// 6. 资源族:计数器线性 + 输出正确
// ---------------------------------------------------------------------------
const KIB = 1024;
const SIZES = [32, 64, 128, 200].map((k) => k * KIB);
const utf8 = (s) => Buffer.byteLength(s, "utf8");
/** 把 unit 重复到恰好不超过 bytes 个 UTF-8 字节。 */
function fill(unit, bytes, head = "") {
  const u = utf8(unit);
  return head + unit.repeat(Math.floor((bytes - utf8(head)) / u));
}
// 每族:造输入、判输出。C / B 是计数器上界的系数(按「每个字符至多被看常数次」定,留了余量)。
const C = 24;
const B = 4096;
const FAMILIES = [
  ["长单行", (n) => fill("长", n), (r) => r.ok && r.blocks.length === 1],
  ["密集短行", (n) => fill("x\n", n), (r) => r.ok && r.blocks.length === 1],
  ["未闭合方括号", (n) => fill("[", n), (r) => r.ok && r.nodes === 2],
  ["不同长度反引号串", (n) => {
    // 长度 1,2,3… 各出现一次、互相闭合不上:逐开符往后搜就是平方
    const parts = [];
    let used = 0;
    for (let L = 1; used + L + 1 <= n; L++) { parts.push("`".repeat(L)); used += L + 1; }
    return parts.join("a");
  }, (r) => r.ok && r.nodes === 2],
  ["同长度反引号成对", (n) => fill("`a` ", n), (r) => r.ok || r.reason === "nodes"],
  ["交替粗斜(稠密)", (n) => fill("**a*b", n), (r) => r.ok || r.reason === "nodes"],
  ["交替粗斜(稀疏)", (n) => fill("**粗*斜*粗** " + "字".repeat(60), n), (r, src) =>
    r.ok && r.blocks[0].c.filter((x) => x.t === "strong").length === src.split("**粗").length - 1],
  ["列表 × 引用", (n) => fill("> - " + "字".repeat(60) + "\n", n), (r) => r.ok && r.blocks[0].t === "quote" && r.blocks[0].c[0].t === "list"],
  ["上千个合法短链接", (n) => fill("[链](https://a.com/x) " + "字".repeat(30), n), (r, src) =>
    // 32 KiB 约三百条、200 KiB 约一千八百条:每一条都得认出来
    r.ok && r.blocks[0].c.filter((x) => x.t === "link").length === src.split("[链]").length - 1],
  ["末尾才失败的链接", (n) => fill("[a](b", n), (r) => r.ok && r.nodes === 2],
  ["嵌套括号的目标", (n) => {
    const k = Math.floor(n / 5); // "[a](" + ")" 每层 5 字节
    return "[a](".repeat(k) + ")".repeat(k);
  }, (r) => r.ok],
  ["满屏 h(每个都要看是不是地址开头)", (n) => fill("h", n), (r) => r.ok && r.nodes === 2],
  ["行首大段空白", (n) => fill(" ".repeat(100) + "x\n", n), (r) => r.ok && r.blocks.length === 1],
  ["十四层引用 × 多行", (n) => fill(">".repeat(14) + " x\n", n), (r) => r.ok && r.nodes === 16],
  ["深括号裸地址", (n) => fill("https://a.com/" + "(".repeat(50) + ")".repeat(49) + " ", n), (r) => r.ok],
];
for (const [name, gen, check] of FAMILIES) {
  test(`资源族「${name}」:计数器 ≤ ${C}·n + ${B},输出对`, () => {
    const per = [];
    for (const size of SIZES) {
      const src = gen(size);
      const bytes = utf8(src);
      assert.ok(bytes <= size && bytes > size * 0.9, `${name} 造出 ${bytes} 字节,不在 ${size} 附近`);
      const t0 = performance.now();
      const r = parseMarkdown(src);
      const ms = performance.now() - t0;
      const n = src.length;
      for (const k of ["scanned", "pairOps", "copied"]) {
        assert.ok(r.stats[k] <= C * n + B, `${name} @${size / KIB}KiB ${k}=${r.stats[k]} > ${C}·${n}+${B}`);
      }
      assert.ok(check(r, src),`${name} @${size / KIB}KiB 输出不对:${JSON.stringify({ ok: r.ok, reason: r.reason, nodes: r.nodes })}`);
      per.push(ms);
    }
    // 墙钟烟测:200 KiB 不超过 2 秒(线性实现在桌面上是毫秒级)
    assert.ok(per[per.length - 1] < 2000, `${name} 200KiB 花了 ${per[per.length - 1].toFixed(0)} ms`);
  });
}
test("写字框标注:scanImgRefs 的位置、行号、代码里不认", () => {
  const src = "# 题\n见图1。\n\n图2\n图3\n\n2. 可以的\n图4\n\n文字\n图5\n\n```\n图6\n```\n`图7` 与 图8\n图1234567\n\n> 图9";
  const got = scanImgRefs(src).map((r) => `${src.slice(r.a, r.b)}@${r.line}`);
  assert.deepEqual(got, ["图1@1", "图2@3", "图3@4", "图4@7", "图5@10", "图8@15", "图9@18"]);
});
test("写字框窄边:gutterCols 隔不足 reach 行才排开,够远就回最右列", () => {
  const cols = (src, reach) => gutterCols(scanImgRefs(src), reach);
  // 同一行两枚并排;相邻行错开;隔够 reach 行回第 0 列
  assert.deepEqual(cols("图1 图2\n图3\n\n图4", 2), [0, 1, 2, 0]);
  assert.deepEqual(cols("图1\n图2\n图3\n图4", 2), [0, 1, 0, 1]);
  assert.deepEqual(cols("图1\n图2\n图3\n图4", 3), [0, 1, 2, 0]);
  // 用户那篇:句中的图1 与单独一行的图2 隔一空行,都在最右列
  assert.deepEqual(cols("# hello\n1. 好\n2. 可以的\n1图1好的\n\n图2", 2), [0, 0]);
  // 一整段不空行、每行都有图:最多两列,不随段长一直往左排
  assert.equal(Math.max(...cols(Array.from({ length: 40 }, (_, i) => `第${i}行 图${i + 1}`).join("\n"), 2)), 1);
});
test("顶层块的起始行:与 blocks 一一对应,行号口径同 split(\"\n\")", () => {
  const src = "\n# 题\n段一\n段一续\n\n- a\n- b\n\n> 引\n> 用\n```\nx\n\n```\n---\n图1\n";
  const r = parseMarkdown(src);
  assert.equal(r.ok, true);
  assert.deepEqual(r.starts, [1, 2, 5, 8, 10, 14, 15]);
  assert.equal(r.starts.length, r.blocks.length);
  const d = render(src);
  assert.deepEqual(d.anchors.map((a) => a.line), r.starts);
  assert.deepEqual(d.anchors.map((a) => a.el), d.root.kids);
  for (const [, gen] of FAMILIES) {
    const q = parseMarkdown(gen(4096));
    if (q.ok) assert.equal(q.starts.length, q.blocks.length);
  }
});
test("资源族里至少有几族在 200 KiB 时没触发节点预算(否则提前降级会掩盖平方扫描)", () => {
  let fine = 0;
  for (const [, gen] of FAMILIES) if (parseMarkdown(gen(200 * KIB)).ok) fine++;
  assert.ok(fine >= 8, `只有 ${fine} 族没降级`);
});

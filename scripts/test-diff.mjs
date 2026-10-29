#!/usr/bin/env node
// 长文历史比对(shared/diff.ts + diff-dom.ts)的单测。跑法:node scripts/test-diff.mjs
// 阴性对照:node scripts/knives-diff.mjs(每把刀都必须让这里真红)。
//
// 测的是**真源码**:esbuild 现场把两份 .ts 打成一个模块再 import(同 test-markdown.mjs 的路数)。
// 正确性靠**独立的朴素算法**对拍(O(n·m) 的 LCS 表,与 Myers 不共一行代码):随机小输入上,
// 行级编辑距离、字级删增码点数都必须等于朴素算法给的最短值;两侧都必须逐码元拼回原文。
// DOM 侧用记账的假 DOM(同 test-markdown.mjs):记每个标签、属性写入、setAttribute、监听。
import { build } from "esbuild";
import { test } from "node:test";
import assert from "node:assert/strict";

const r = await build({
  stdin: {
    contents: 'export * from "./shared/diff"; export * from "./shared/diff-dom";',
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "esm",
});
const M = await import("data:text/javascript," + encodeURIComponent(r.outputFiles[0].text));
const { diffText, renderDiff, DIFF_MAX_BYTES, DIFF_MAX_D, DIFF_MAX_WORK, DIFF_MAX_MEM, DIFF_MAX_CP, DIFF_MAX_DOM } = M;

// ---------------------------------------------------------------------------
// 工具:拼回、数改动、朴素算法
// ---------------------------------------------------------------------------
function rebuild(rows) {
  let a = "";
  let b = "";
  for (const x of rows) {
    if (x.t === "eq") { a += x.s; b += x.s; }
    else if (x.t === "del") a += x.s;
    else if (x.t === "ins") b += x.s;
    else if (x.t === "pair") {
      for (const s of x.del) { assert.ok(s.t === "eq" || s.t === "del", "pair.del 里混进了 " + s.t); a += s.s; }
      for (const s of x.ins) { assert.ok(s.t === "eq" || s.t === "ins", "pair.ins 里混进了 " + s.t); b += s.s; }
    } else throw new Error("未知行 " + x.t);
  }
  return [a, b];
}
const lines = (s) => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
/** 行级:删掉的行数 + 新增的行数(pair 各算一行)。 */
function lineEdits(rows) {
  let n = 0;
  for (const x of rows) {
    if (x.t === "del" || x.t === "ins") n += lines(x.s).length;
    else if (x.t === "pair") n += 2;
  }
  return n;
}
/** 朴素 LCS 编辑距离(只删 / 增):n + m - 2·LCS。 */
function naive(A, B) {
  const n = A.length, m = B.length;
  let prev = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    const cur = new Array(m + 1).fill(0);
    for (let j = 1; j <= m; j++) cur[j] = A[i - 1] === B[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return n + m - 2 * prev[m];
}
function ok(a, b) {
  const x = diffText(a, b);
  assert.ok(x.ok, `本该算出来:${x.reason}`);
  const [ra, rb] = rebuild(x.rows);
  assert.equal(ra, a, "旧版拼不回去");
  assert.equal(rb, b, "新版拼不回去");
  return x;
}
/** 可复现的随机数(mulberry32)。 */
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const isHi = (c) => c >= 0xd800 && c <= 0xdbff;
const isLo = (c) => c >= 0xdc00 && c <= 0xdfff;
/** 一截的两头都不是劈开的代理对。 */
function whole(s) {
  if (s.length === 0) return false;
  return !isLo(s.charCodeAt(0)) && !isHi(s.charCodeAt(s.length - 1));
}

// ---------------------------------------------------------------------------
// 1. 分行与精确还原
// ---------------------------------------------------------------------------
test("还原:行结束符、末尾换行、CRLF 都是真差异,两侧逐码元拼回", () => {
  const cases = [
    ["", ""], ["", "\n"], ["\n", ""], ["甲", "甲\n"], ["甲\n", "甲"], ["a\r\nb\r\n", "a\nb\n"], ["a\nb", "a\nb\n"],
    ["\n\n\n", "\n\n"], ["x", "y"], ["同一段\n", "同一段\n"], ["a\r\n", "a\r\n"], ["\r", "\r\n"],
  ];
  for (const [a, b] of cases) {
    const x = ok(a, b);
    const same = x.rows.every((r) => r.t === "eq");
    assert.equal(same, a === b, `${JSON.stringify(a)} → ${JSON.stringify(b)} 判成了${same ? "没变" : "有变"}`);
  }
  assert.deepEqual(ok("", "").rows, []);
  assert.deepEqual(ok("", "\n").rows, [{ t: "ins", s: "\n" }]);
});

test("行级最短:随机小输入与朴素 LCS 对拍,删增行数 = 编辑距离", () => {
  const rand = rng(7);
  const pool = ["a\n", "b\n", "c\n", "甲\n", "\n", "a\r\n", "𠀀\n", "a"];
  for (let it = 0; it < 3000; it++) {
    const gen = () => {
      const n = Math.floor(rand() * 9);
      const ls = [];
      for (let i = 0; i < n; i++) ls.push(pool[Math.floor(rand() * (pool.length - 1))]);
      if (rand() < 0.3) ls.push("尾"); // 没有末尾换行的最后一行
      return ls;
    };
    const A = gen(), B = gen();
    const x = ok(A.join(""), B.join(""));
    const d = naive(A, B);
    assert.equal(x.stats.d, d, `D 不是最短:${JSON.stringify(A)} → ${JSON.stringify(B)}`);
    assert.equal(lineEdits(x.rows), d);
  }
});

test("字级最短:配对行内删增码点数 = 朴素码点编辑距离", () => {
  const rand = rng(11);
  const pool = ["a", "b", "甲", "乙", "𠀀", "😀", "́"];
  for (let it = 0; it < 3000; it++) {
    const gen = () => Array.from({ length: Math.floor(rand() * 12) }, () => pool[Math.floor(rand() * pool.length)]);
    const A = gen(), B = gen();
    const a = A.join("") + "\n", b = B.join("") + "\n";
    const x = ok(a, b);
    if (a === b) continue;
    assert.equal(x.rows.length, 1);
    assert.equal(x.rows[0].t, "pair");
    let n = 0;
    for (const s of x.rows[0].del) if (s.t === "del") { assert.ok(whole(s.s)); n += Array.from(s.s).length; }
    for (const s of x.rows[0].ins) if (s.t === "ins") { assert.ok(whole(s.s)); n += Array.from(s.s).length; }
    assert.equal(n, naive(Array.from(a), Array.from(b)), `${a} → ${b}`);
  }
});

// ---------------------------------------------------------------------------
// 2. 配对与平局
// ---------------------------------------------------------------------------
test("配对:段内删增等长才逐行配对,不等长整段删在前、增在后", () => {
  const x = ok("头\na\nb\n尾\n", "头\nA\nB\nC\n尾\n");
  assert.deepEqual(x.rows.map((r) => r.t), ["eq", "del", "ins", "eq"]);
  assert.equal(x.rows[1].s, "a\nb\n");
  assert.equal(x.rows[2].s, "A\nB\nC\n");
  const y = ok("头\na1\nb1\n尾\n", "头\na2\nb2\n尾\n");
  assert.deepEqual(y.rows.map((r) => r.t), ["eq", "pair", "pair", "eq"]);
  assert.deepEqual(y.rows[1].del, [{ t: "eq", s: "a" }, { t: "del", s: "1" }, { t: "eq", s: "\n" }]);
  assert.deepEqual(y.rows[2].ins, [{ t: "eq", s: "b" }, { t: "ins", s: "2" }, { t: "eq", s: "\n" }]);
});

test("平局:重复行与交换的结果钉死(同一段里删在前)", () => {
  assert.deepEqual(ok("x\ny\n", "y\nx\n").rows, [{ t: "del", s: "x\n" }, { t: "eq", s: "y\n" }, { t: "ins", s: "x\n" }]);
  assert.deepEqual(ok("a\na\n", "a\n").rows, [{ t: "eq", s: "a\n" }, { t: "del", s: "a\n" }]);
  assert.deepEqual(ok("p\na\nq\na\nr\n", "p\na\nr\n").rows, [
    { t: "eq", s: "p\na\n" }, { t: "del", s: "q\na\n" }, { t: "eq", s: "r\n" },
  ]);
  assert.deepEqual(ok("p\nb\na\nr\n", "p\na\nb\nr\n").rows, [
    { t: "eq", s: "p\n" }, { t: "del", s: "b\n" }, { t: "eq", s: "a\n" }, { t: "ins", s: "b\n" }, { t: "eq", s: "r\n" },
  ]);
  assert.deepEqual(ok("a\nb\na\nb\n", "b\na\n").rows, [{ t: "del", s: "a\n" }, { t: "eq", s: "b\na\n" }, { t: "del", s: "b\n" }]);
  // 字级同一条规则;另一侧的改动夹在中间时,这一侧相邻的相等截并成一截
  assert.deepEqual(ok("ab\n", "ba\n").rows, [{
    t: "pair",
    del: [{ t: "del", s: "a" }, { t: "eq", s: "b\n" }],
    ins: [{ t: "eq", s: "b" }, { t: "ins", s: "a" }, { t: "eq", s: "\n" }],
  }]);
});

// ---------------------------------------------------------------------------
// 3. 码点
// ---------------------------------------------------------------------------
test("码点:代理对不劈开,组合 / ZWJ / 旗帜原文精确还原", () => {
  const x = ok("𠀀a\n", "𠀁a\n");
  assert.deepEqual(x.rows[0].del[0], { t: "del", s: "𠀀" });
  assert.deepEqual(x.rows[0].ins[0], { t: "ins", s: "𠀁" });
  // 只差低半的两个码点(U+1F600 / U+1F601):按码元比会只标半个代理
  const y = ok("😀\n", "😁\n");
  assert.deepEqual(y.rows[0].del, [{ t: "del", s: "😀" }, { t: "eq", s: "\n" }]);
  for (const [a, b] of [["é\n", "è\n"], ["👨‍👩‍👧\n", "👨‍👩‍👦\n"], ["🇨🇳\n", "🇯🇵\n"], ["👍🏻\n", "👍🏿\n"]]) {
    const z = ok(a, b);
    for (const s of [...z.rows[0].del, ...z.rows[0].ins]) assert.ok(whole(s.s), JSON.stringify(s));
  }
});

test("字级资格:两侧都 ≤ DIFF_MAX_CP 个码点才细化(按码点不按 .length;行尾换行也算一个)", () => {
  const astral = (n) => "𠀀".repeat(n);
  const x = ok(astral(DIFF_MAX_CP - 2) + "a\n", astral(DIFF_MAX_CP - 2) + "b\n");
  assert.equal(x.rows[0].t, "pair", "2000 码点(3998 码元 + 2)应当够资格");
  const y = ok(astral(DIFF_MAX_CP - 1) + "a\n", astral(DIFF_MAX_CP - 1) + "b\n");
  assert.deepEqual(y.rows.map((r) => r.t), ["del", "ins"], "2001 码点不该细化");
  assert.equal(y.limited, false, "资格不够不算「细化受限」");
  // 一边够、一边不够:整行
  const z = ok("a\n", "x".repeat(DIFF_MAX_CP + 5) + "\n");
  assert.deepEqual(z.rows.map((r) => r.t), ["del", "ins"]);
  // 不够资格的那一对夹在两对之间:前后照常细化
  const w = ok("a1\n" + "q".repeat(5000) + "\nb1\n", "a2\n" + "Q".repeat(5000) + "\nb2\n");
  assert.deepEqual(w.rows.map((r) => r.t), ["pair", "del", "ins", "pair"]);
});

// ---------------------------------------------------------------------------
// 4. 预算与降级
// ---------------------------------------------------------------------------
test("字节预算:每侧 ≤ 204,800 UTF-8 字节,按字节不按码元", () => {
  assert.ok(diffText("a".repeat(DIFF_MAX_BYTES), "a".repeat(DIFF_MAX_BYTES)).ok);
  assert.equal(diffText("a".repeat(DIFF_MAX_BYTES + 1), "").reason, "bytes");
  const han = "汉".repeat(Math.floor(DIFF_MAX_BYTES / 3));
  assert.ok(diffText(han, "").ok);
  const x = diffText("", han + "汉");
  assert.equal(x.ok, false);
  assert.equal(x.reason, "bytes");
  assert.equal(x.stats.work, 0, "字节超了应当一步不算");
});

const distinct = (n, p) => Array.from({ length: n }, (_, i) => `${p}${i}\n`).join("");

test("行级 D 上限:全异长文在 1,024 层停,trace 是紧凑的", () => {
  const x = diffText(distinct(3000, "a"), distinct(3000, "b"));
  assert.equal(x.ok, false);
  assert.equal(x.reason, "depth");
  assert.equal(x.stats.d, DIFF_MAX_D);
  // 紧凑 trace:Σ(d+1)·4 ≈ 2.1 MiB,加两张行号表;存满 V 会翻倍以上
  assert.ok(x.stats.peakMem <= 2.3 * 1024 * 1024, `trace 峰值 ${x.stats.peakMem}`);
  assert.ok(x.stats.work <= DIFF_MAX_WORK);
  // 恰好 1,024 还算得出来
  const y = ok(distinct(512, "a"), distinct(512, "b"));
  assert.equal(y.stats.d, DIFF_MAX_D);
});

test("字级工作预算:贵的一对超了 ⇒ 行级保留、这一对及其后不细化、标「受限」", () => {
  const s = (base) => Array.from({ length: DIFF_MAX_CP - 1 }, (_, i) => String.fromCodePoint(base + i)).join("");
  const a = s(0x4e00), b = s(0x6000);
  const x = ok(`a1\n${a}\nb1\n`, `a2\n${b}\nb2\n`);
  assert.equal(x.limited, true);
  assert.deepEqual(x.rows.map((r) => r.t), ["pair", "del", "ins"], "前一对照常细化,贵的那对与其后整行");
  assert.equal(x.rows[1].s, `${a}\nb1\n`);
  assert.ok(x.stats.work <= DIFF_MAX_WORK + 1, `工作量 ${x.stats.work} 冲过了预算`);
  assert.ok(x.stats.peakMem <= DIFF_MAX_MEM);
  // 细化受限不是「全部不同」:行级结果还在
  assert.equal(x.ok, true);
});

test("输出节点预算按整份合计,不按改动段各给一份;与渲染器对拍", () => {
  // 每对约 4·k 个节点,单看一对都很小
  const pairOf = (i, k) => [Array.from({ length: k }, () => "ab").join("") + i + "\n", Array.from({ length: k }, () => "ac").join("") + i + "\n"];
  const mk = (n, k) => {
    let a = "", b = "";
    for (let i = 0; i < n; i++) {
      const [x, y] = pairOf(i, k);
      a += "同\n" + x;
      b += "同\n" + y;
    }
    return [a, b];
  };
  const [a1, b1] = mk(100, 10);
  const x = ok(a1, b1);
  assert.ok(x.nodes < DIFF_MAX_DOM);
  const rd = renderWith(a1, b1);
  assert.equal(rd.degraded, null);
  assert.equal(rd.created, x.nodes, "diff.ts 数的节点与渲染器建的不一致");
  const [a2, b2] = mk(400, 10);
  const y = diffText(a2, b2);
  assert.equal(y.ok, false);
  assert.equal(y.reason, "nodes");
  const r2 = renderWith(a2, b2);
  assert.equal(r2.degraded, "nodes");
  assert.equal(r2.html, `<div.diff.diff-raw><div.diff-raw-old>${esc(a2)}</div><div.diff-raw-new>${esc(b2)}</div></div>`);
});

test("D 很小但行数极多:相等行合成一块,节点数不跟行数走", () => {
  const blank = "\n".repeat(100_000);
  const x = ok("a\n" + blank + "b\n", "A\n" + blank + "B\n");
  assert.ok(x.nodes <= 20, `节点 ${x.nodes}`);
  assert.equal(x.stats.d, 4);
});

test("资源族:各族 32 / 64 / 128 / 200 KiB 不超预算、墙钟烟测", () => {
  const fams = {
    "末尾一处改动": (n) => ["x\n".repeat(n / 2), "x\n".repeat(n / 2 - 2) + "y\n"],
    "满屏同一行、稀疏替换": (n) => {
      const L = Math.floor(n / 2.1);
      const A = [], B = [];
      for (let i = 0; i < L; i++) { A.push(i % 200 === 0 ? `m${i}` : "x"); B.push(i % 200 === 0 ? `n${i}` : "x"); }
      return [A.join("\n"), B.join("\n")];
    },
    "全异短行": (n) => [distinct(Math.floor(n / 8), "a"), distinct(Math.floor(n / 8), "b")],
    "长单行一字之差": (n) => ["中".repeat(Math.floor(n / 3) - 1), "中".repeat(Math.floor(n / 3) - 2) + "文"],
    "大量短配对行": (n) => {
      const k = Math.floor(n / 6);
      return [Array.from({ length: k }, (_, i) => (i % 2 ? "同\n" : "甲\n")).join(""), Array.from({ length: k }, (_, i) => (i % 2 ? "同\n" : "乙\n")).join("")];
    },
  };
  for (const [name, f] of Object.entries(fams)) {
    for (const kib of [32, 64, 128, 200]) {
      const [a, b] = f(kib * 1024);
      assert.ok(Buffer.byteLength(a) <= DIFF_MAX_BYTES && Buffer.byteLength(b) <= DIFF_MAX_BYTES, `${name} ${kib}`);
      const t = performance.now();
      const x = diffText(a, b);
      const ms = performance.now() - t;
      assert.ok(x.stats.work <= DIFF_MAX_WORK + 1, `${name} ${kib}:工作 ${x.stats.work}`);
      assert.ok(x.stats.peakMem <= DIFF_MAX_MEM, `${name} ${kib}:内存 ${x.stats.peakMem}`);
      assert.ok(ms < 2000, `${name} ${kib}:${ms.toFixed(0)} ms`);
      if (x.ok) {
        const [ra, rb] = rebuild(x.rows);
        assert.ok(ra === a && rb === b, `${name} ${kib}:拼不回去`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 5. DOM:记账的假 DOM
// ---------------------------------------------------------------------------
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function fakeDom() {
  const log = { tags: [], props: [], attrs: [], listeners: [], created: 0 };
  const mkEl = (tag) => {
    log.tags.push(tag);
    log.created++;
    const t = {
      nodeType: 1, tag, kids: [], attrs: {}, className: "",
      append(...ns) { for (const n of ns) this.kids.push(typeof n === "string" ? { nodeType: 3, data: n } : n); },
      setAttribute(k, v) { log.attrs.push(k); this.attrs[k] = String(v); },
      addEventListener(type) { log.listeners.push(type); },
    };
    return new Proxy(t, { set(o, k, v) { log.props.push(String(k)); o[k] = v; return true; } });
  };
  const document = { createElement: mkEl, createTextNode: (s) => { log.created++; return { nodeType: 3, data: s }; } };
  return { document, log };
}
function html(n) {
  if (n.nodeType === 3) return esc(n.data);
  const cls = n.className ? `.${n.className.replace(/ /g, ".")}` : "";
  return `<${n.tag}${cls}>${n.kids.map(html).join("")}</${n.tag}>`;
}
function renderWith(a, b) {
  const { document, log } = fakeDom();
  globalThis.document = document;
  try {
    const out = renderDiff(a, b);
    return { ...out, log, created: log.created, html: html(out.root) };
  } finally {
    delete globalThis.document;
  }
}

test("DOM:只有固定标签与 class,正文全进文本节点,不渲染 Markdown", () => {
  const a = "# 标题\n<img src=x onerror=alert(1)>\n**粗** [x](javascript:alert(1))\n同\n";
  const b = "# 标题!\n<script>alert(1)</script>\n**细** [x](https://a.com)\n同\n";
  const r = renderWith(a, b);
  assert.equal(r.degraded, null);
  for (const t of r.log.tags) assert.ok(t === "div" || t === "span", t);
  assert.deepEqual([...new Set(r.log.props)], ["className"]);
  assert.deepEqual(r.log.attrs, []);
  assert.deepEqual(r.log.listeners, []);
  const classes = new Set();
  const walk = (n) => { if (n.nodeType === 1) { classes.add(n.className); n.kids.forEach(walk); } };
  walk(r.root);
  for (const c of classes) assert.ok(["diff", "diff-eq", "diff-del", "diff-ins", "diff-hl"].includes(c), c);
  // 两侧的字按顺序拼回原文(# 与 ** 没被吃掉、HTML 字样是字):旧版 = 相等 + 删,新版 = 相等 + 增
  const side = (n, keep, out) => {
    if (n.nodeType === 3) out.push(n.data);
    else if (["diff", "diff-eq", "diff-hl", keep].includes(n.className)) n.kids.forEach((k) => side(k, keep, out));
    return out;
  };
  assert.equal(side(r.root, "diff-del", []).join(""), a);
  assert.equal(side(r.root, "diff-ins", []).join(""), b);
  // 高亮只在 pair 行里
  assert.ok(r.html.includes('<span.diff-hl>!</span>'), r.html);
});

test("DOM:受限照画、标出来;降级画两份原文", () => {
  const s = (base) => Array.from({ length: DIFF_MAX_CP - 1 }, (_, i) => String.fromCodePoint(base + i)).join("");
  const r = renderWith(s(0x4e00) + "\n", s(0x6000) + "\n");
  assert.equal(r.degraded, null);
  assert.equal(r.limited, true);
  const d = renderWith(distinct(3000, "a"), distinct(3000, "b"));
  assert.equal(d.degraded, "depth");
  assert.equal(d.limited, false);
  assert.ok(d.html.startsWith("<div.diff.diff-raw><div.diff-raw-old>a0\n"));
});

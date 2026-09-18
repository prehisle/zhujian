#!/usr/bin/env node
// 版权证明材料的两份鉴别材料:①源代码前后各 30 页 ②软件操作说明书(703 补2 立)。
//
//   node scripts/copyright-materials.mjs            两份都出
//   node scripts/copyright-materials.mjs --source   只出源代码
//   node scripts/copyright-materials.mjs --manual   只出操作说明书
//   node scripts/copyright-materials.mjs --plan     只印「会取哪些文件、前后 30 页各落在哪」,一个字不写
//
// ⭐ **为什么是「认证」不是「登记」**(⛔ 这条决定了这份材料能不能用,别按印象改):
//    国内商店要的是**版权证明**,有三种形式,官方软著只是其一。走的是
//    **易版权《APP软著认证电子版权》**(`yibanquan.com.cn/product/cc.at`,600 元 / 10-15 工作日,
//    原文「无需获得软件著作权登记证书」)—— 它**不经国家软件登记机构**。
//    ⛔ 同站那个 `product/app.at`(1588 元 / 60 日)是**登记**,要「在国家软件登记机构登记之后」发证
//    ⇒ 照样要签版权保护中心那张表,而那张表 2026-03-15 起要**手抄**「未使用 AI 开发编写代码、撰写文档
//    或生成登记申请材料」并挂个人征信。⚠ 腾讯应用宝表单里那个「官方申请通道」跳的正是 `app.at`,
//    **别顺着它点下去**。全文见 progress-log 702 / 703 补2。
//
// ── 材料规格(易版权个人办理:身份证 + 软件操作说明书 + 前后各 30 页源代码) ──
// 排版按**软著登记**那套更严的规范做,一次做全、三种证书通用:
//   · 源程序每页**不少于 50 行**;页眉标软件名称 + 版本号,**右上角页码**,60 页**连续编号 1-60**。
//   · 文档每页不少于 30 行(有图的页除外),同样带页眉页码。
//
// ⚠ **两个要与填表一致的值**(改这里之前先问用户,⛔ 别自作主张):
//   · 软件名称 `朱简` —— 腾讯文档明写「软件著作权中的应用名称请与您上传的应用名称相符」。
//   · 版本号 `V1.0` —— 首次登记惯例,**不是**仓里那个 0.3.42(那是发布版本号,两套东西)。
//
// ⛔ 产物落 `work_data/copyright/`(在 .gitignore 里)—— 材料含实名信息,**不进任何仓**。
//    本脚本自己在 `scripts/` 里 ⇒ 会进公开仓,故它只许有排版逻辑,⛔ 别把身份证号之类写进来。

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(REPO, "work_data/copyright");

const SOFTWARE = "朱简";
const VERSION = "V1.0";
const LINES_PER_PAGE = 50;
const PAGES_EACH_END = 30;

// ── 取哪些源码、按什么顺序 ────────────────────────────────────────────────
// 应用宝上架的是**安卓版** ⇒ 按这只 app 的实际构成排:入口 → 前端 → 原生壳 → 协议 → 核心。
// 这样前 30 页落在入口与界面(看得出是什么软件),后 30 页落在核心逻辑(看得出有技术含量)。
// ⚠ `main.ts` 排在 `index.html` **前面**:前 30 页 = 1500 行,而 index.html 有 2113 行 ——
//    照「页面在先」排会让整整 30 页全是 DOM 骨架,一行业务逻辑都看不见(703 补2 第一版真长这样)。
const ORDER = [
  { dir: "android/src", files: ["main.ts"] },           // 程序主入口先行
  { dir: "android", files: ["index.html"] },
  { dir: "android/src", ext: [".ts"] },
  { dir: "shared", ext: [".ts"] },
  { dir: "android/src-tauri/src", ext: [".rs"] },
  { dir: "mobile/src", ext: [".rs"] },
  { dir: "sync-proto/src", ext: [".rs"] },
  { dir: "core/src", ext: [".rs"] },
];

// ⛔ 交的是产品代码:测试、生成物、依赖不进。⚠ 别把 locales 排掉 —— 那是真界面文案,也是代码。
const SKIP = (p) =>
  /(^|\/)tests?\.rs$/.test(p) ||
  /_tests?\.rs$/.test(p) ||
  // ⚠ `core/src/test_src.rs` / `test_temp*.rs` 是**测试辅助**,名字不带 `tests.rs` 那个形
  //    ⇒ 第一版没排掉,后 30 页当场落在它们身上(703 补2 实撞)。
  /(^|\/)test_[^/]*\.rs$/.test(p) ||
  /(^|\/)tests?\//.test(p) ||
  /(^|\/)gen\//.test(p) ||
  /node_modules/.test(p) ||
  /\.d\.ts$/.test(p);

function walk(dir, ext) {
  const abs = join(REPO, dir);
  if (!existsSync(abs)) return [];
  const out = [];
  const rec = (d) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const rel = relative(REPO, full).split("\\").join("/");
      if (statSync(full).isDirectory()) { if (!SKIP(rel + "/")) rec(full); continue; }
      if (ext && !ext.some((e) => name.endsWith(e))) continue;
      if (SKIP(rel)) continue;
      out.push(rel);
    }
  };
  rec(abs);
  return out;
}

function collect() {
  const seen = new Set();
  const files = [];
  for (const step of ORDER) {
    const list = step.files
      ? step.files.map((f) => `${step.dir}/${f}`).filter((p) => existsSync(join(REPO, p)))
      : walk(step.dir, step.ext);
    for (const p of list) { if (!seen.has(p)) { seen.add(p); files.push(p); } }
  }
  return files;
}

// 把所有文件拼成一条连续的行流;每个文件前插一行路径标记(它也算一行,且让审查看得清结构)
function lineStream(files) {
  const lines = [];
  for (const f of files) {
    const body = readFileSync(join(REPO, f), "utf8").replace(/\r\n/g, "\n").split("\n");
    // 末尾空行不计:很多文件以 \n 结尾,split 后多一个空串
    while (body.length && body[body.length - 1].trim() === "") body.pop();
    lines.push(`//// ${f} ////`);
    for (const l of body) lines.push(l);
    lines.push("");
  }
  return lines;
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function pagesHtml(pages, title) {
  const body = pages
    .map(
      (lines, i) => `<div class="page">
<div class="hd"><span>${esc(SOFTWARE)} ${esc(VERSION)}</span><span>${i + 1}</span></div>
<pre>${lines.map(esc).join("\n")}</pre>
</div>`,
    )
    .join("\n");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
@page { size: A4; margin: 14mm 12mm 12mm 14mm; }
* { box-sizing: border-box; }
body { margin: 0; font-family: "Consolas","Courier New",monospace; }
.page { page-break-after: always; }
.page:last-child { page-break-after: auto; }
.hd { display: flex; justify-content: space-between; font-family: "SimSun","Songti SC",serif;
      font-size: 10pt; border-bottom: .5pt solid #000; padding-bottom: 2mm; margin-bottom: 3mm; }
/* ⚠ 行高 12pt 不是随手定的:取进材料的 3000 行里最长 195 字符宽,按 8pt 等宽算最坏一页要显示
   **57** 行(折行后),而可用高度 ≈740pt ⇒ 12pt × 57 = 684pt 放得下,留约 4 行余量。
   ⛔ 第一版 13.6pt 时两页溢出、PDF 变成 **62** 页,页码与规范的 1-60 当场对不上(703 补2 实撞)。 */
pre { margin: 0; font-size: 8pt; line-height: 12pt; white-space: pre-wrap; word-break: break-all; }
</style></head><body>
${body}
</body></html>`;
}

function chunk(lines, n) {
  const out = [];
  for (let i = 0; i < lines.length; i += n) out.push(lines.slice(i, i + n));
  return out;
}

// ⛔ headless Chrome 自带的页眉页脚(URL / 日期)必须关掉,否则每页多两行与规范打架
function toPdf(htmlPath, pdfPath) {
  const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
  if (!existsSync(chrome)) throw new Error(`找不到 Chrome:${chrome} —— 换台机器跑就来改这行`);
  // ⚠ 独立 --user-data-dir:本机可能正开着别的 Chrome(比如驱动上架表单那只),
  //    共用 profile 会让 headless 那次静默退出、不出 PDF。
  execFileSync(chrome, [
    "--headless", "--disable-gpu", "--no-pdf-header-footer",
    `--user-data-dir=${join(OUT, ".chrome")}`,
    `--print-to-pdf=${pdfPath}`, `file:///${htmlPath.split("\\").join("/")}`,
  ], { stdio: "pipe", timeout: 180000 });
  if (!existsSync(pdfPath)) throw new Error(`Chrome 没吐出 PDF:${pdfPath}`);
}

// ⭐ **PDF 的真实页数才是判据** —— HTML 里有几个 `.page` 块不算数:一页内容超出可用高度时
//    Chrome 会把它拆成两个物理页,而页眉里的页码还是老的 ⇒ 页码与「1-60 连续编排」对不上。
//    703 补2 第一版正是这样悄悄变成 62 页的(回显还是「✅ 60 页」)。
// ⚠ 页数取 `/Count` 的最大值 = 页面树根节点;数不出来就**响亮地停**,⛔ 别当它是对的。
function pdfPageCount(pdfPath) {
  const raw = readFileSync(pdfPath, "latin1");
  const counts = [...raw.matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  if (counts.length === 0) {
    throw new Error(`数不出 ${pdfPath} 的页数(PDF 里没有可见的 /Count)—— ⛔ 别跳过这道核,自己打开数一遍再说`);
  }
  return Math.max(...counts);
}

function buildSource(planOnly) {
  const files = collect();
  const all = lineStream(files);
  const need = LINES_PER_PAGE * PAGES_EACH_END;
  console.log(`源码:${files.length} 个文件 / ${all.length} 行(含路径标记与空行)`);
  if (all.length < need * 2) {
    throw new Error(`总行数 ${all.length} 不足 ${need * 2} 行 ⇒ 按规范要提交全部源码,本脚本的「前后各 30 页」不适用`);
  }
  const head = all.slice(0, need);
  const tail = all.slice(-need);
  if (process.argv.includes("--dump-lines")) { console.log(JSON.stringify([...head, ...tail])); return; }

  const firstOf = (arr) => arr.find((l) => l.startsWith("////")) ?? "(本段不含文件标记)";
  const lastOf = (arr) => [...arr].reverse().find((l) => l.startsWith("////")) ?? "(本段不含文件标记)";
  console.log(`  前 30 页:${firstOf(head)} … ${lastOf(head)}`);
  console.log(`  后 30 页:${firstOf(tail)} … ${lastOf(tail)}`);
  if (planOnly) {
    console.log(`\n取文件顺序(前 12 个):`);
    for (const f of files.slice(0, 12)) console.log(`   ${f}`);
    console.log(`   …`);
    for (const f of files.slice(-4)) console.log(`   ${f}`);
    return;
  }

  const pages = [...chunk(head, LINES_PER_PAGE), ...chunk(tail, LINES_PER_PAGE)];
  if (pages.length !== PAGES_EACH_END * 2) throw new Error(`页数算错了:${pages.length}`);
  const html = join(OUT, "源代码.html");
  const pdf = join(OUT, `${SOFTWARE}${VERSION}-源代码.pdf`);
  writeFileSync(html, pagesHtml(pages, `${SOFTWARE} ${VERSION} 源代码`), "utf8");
  toPdf(html, pdf);
  const real = pdfPageCount(pdf);
  if (real !== pages.length) {
    throw new Error(
      `⛔ PDF 实际 ${real} 页,而页眉按 ${pages.length} 页编的号 ⇒ 页码与「1-${pages.length} 连续编排」对不上。\n` +
        `   根因几乎一定是某页折行后超出可用高度被拆成两页 ⇒ 调小 pre 的 line-height 再跑。`,
    );
  }
  console.log(`✅ ${pdf}`);
  console.log(`   ${real} 页(PDF 真实页数,与页眉编号一致)· 每页 ${LINES_PER_PAGE} 行 · ${SOFTWARE} ${VERSION}`);
}

// ── 操作说明书 ────────────────────────────────────────────────────────────
// ⛔ 正文**不在本脚本里硬写** —— 它住 `work_data/copyright/操作说明书.md`,本脚本只负责排版。
//    理由:说明书要随产品改,而排版逻辑不该跟着动;且本脚本进公开仓,正文里有实名信息。
function buildManual() {
  const src = join(OUT, "操作说明书.md");
  if (!existsSync(src)) throw new Error(`没有 ${src} —— 先写正文再排版(本脚本只排版,不代笔)`);
  const md = readFileSync(src, "utf8");
  const html = join(OUT, "操作说明书.html");
  const pdf = join(OUT, `${SOFTWARE}${VERSION}-软件操作说明书.pdf`);
  writeFileSync(html, manualHtml(md), "utf8");
  toPdf(html, pdf);
  // ⚠ 说明书是流式排版,页数不固定 ⇒ 这里只报数、不断言;但仍要能数出来
  //    (数不出来 = PDF 结构异常,pdfPageCount 会自己响亮地停)。
  console.log(`✅ ${pdf}`);
  console.log(`   ${pdfPageCount(pdf)} 页 · ${SOFTWARE} ${VERSION}`);
}

// 极简 markdown:标题 / 图 / 列表 / 段落 —— ⛔ 够用就行,别在这儿长出一个 markdown 引擎
function manualHtml(md) {
  const out = [];
  let inUl = false;
  const closeUl = () => { if (inUl) { out.push("</ul>"); inUl = false; } };
  for (const raw of md.replace(/\r\n/g, "\n").split("\n")) {
    const l = raw.trimEnd();
    let m;
    if ((m = l.match(/^(#{1,4})\s+(.*)$/))) { closeUl(); const n = m[1].length; out.push(`<h${n}>${esc(m[2])}</h${n}>`); continue; }
    if ((m = l.match(/^!\[([^\]]*)\]\(([^)]+)\)$/))) {
      closeUl();
      out.push(`<figure><img src="${esc(m[2])}" alt="${esc(m[1])}"><figcaption>${esc(m[1])}</figcaption></figure>`);
      continue;
    }
    if ((m = l.match(/^[-*]\s+(.*)$/))) { if (!inUl) { out.push("<ul>"); inUl = true; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    if (l.trim() === "") { closeUl(); continue; }
    closeUl();
    out.push(`<p>${inline(l)}</p>`);
  }
  closeUl();
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(SOFTWARE)} ${esc(VERSION)} 软件操作说明书</title>
<style>
@page { size: A4; margin: 20mm 18mm 18mm 20mm;
        @top-left { content: "${SOFTWARE} ${VERSION}"; } @top-right { content: counter(page); } }
body { font-family: "SimSun","Songti SC",serif; font-size: 11pt; line-height: 1.8; margin: 0; }
h1 { font-size: 18pt; text-align: center; margin: 0 0 6mm; page-break-after: avoid; }
h2 { font-size: 14pt; margin: 6mm 0 2mm; border-bottom: .5pt solid #000; padding-bottom: 1mm; page-break-after: avoid; }
h3 { font-size: 12pt; margin: 4mm 0 1mm; page-break-after: avoid; }
p { margin: 0 0 2mm; text-align: justify; }
ul { margin: 0 0 2mm; padding-left: 8mm; }
li { margin-bottom: 1mm; }
figure { margin: 3mm 0; text-align: center; page-break-inside: avoid; }
/* ⚠ 手机截图是竖长的(889×1920,宽高比 0.46)⇒ 约束高度才有效,宽度不是瓶颈。
   105mm 时图只占页宽三分之一、界面细节看不清;140mm 时宽约 65mm,清楚且仍留得下说明文字。
   规范里「文档每页不少于 30 行」对**有图的页**本就不做要求。 */
img { max-width: 70%; max-height: 140mm; border: .5pt solid #888; }
figcaption { font-size: 9pt; color: #333; margin-top: 1mm; }
</style></head><body>
${out.join("\n")}
</body></html>`;
}
function inline(s) {
  return esc(s).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
}

// ── main ──
const argv = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
const plan = argv.includes("--plan");
const sourceOnly = plan || argv.includes("--source") || argv.includes("--dump-lines");
const wantSource = sourceOnly || !argv.includes("--manual");
const wantManual = !sourceOnly && (argv.includes("--manual") || !argv.includes("--source"));
if (wantSource) buildSource(plan);
if (wantManual) buildManual();

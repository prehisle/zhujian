#!/usr/bin/env node
// 官网双语渲染对拍(360 立;改版 2c 起判的是**生成出来的页**)。check-i18n-drift 是**静态**的:
// 它核得了「壳原文 = zh 字典」「键双向」「形状」,核不了「生成器把英文烤进去之后,页面在真浏览器里
// 显出来的是什么」。这只工装补的就是它。
//
// # 判据
//
// 2c 起语言由网址定:`site-app/<页>.html` 是中文、`site-app/en/<页>.html` 是英文,字是生成器烤进去的
// (`scripts/build-site-cool.mjs` 的 bakeEnglish)。把每一份原样喂给真 Chrome,只在最前面插一段
// prelude(桩掉 localStorage、把 navigator.language 顶成这页的语言、挂 window.onerror),然后
// **把屏幕上的字读回来**,拿去与 Node 侧独立解析出的字典(源 `site/index.html`)逐条比。
// 页内脚本只负责「报告看见了什么」,判断全在 Node 侧 —— 页内做判断的话,它自己写错的方式和被测对象
// 写错的方式长得一样(337 对拍工装那一栏的教训)。
//
// # 正控(缺一个,这只工装就可能安静地绿)
//
//  ① <title>RESULT</title> 必须在:证明页内脚本**跑完了**,不是「文档里出现过 RESULT」。
//  ② 回来的条数必须恰等于 Node 侧静态数出的绑定处数:守「有元素整个没被读到」。
//  ③ 同一页的中英两份之间必须真有一批读出不同的字:守「英文页根本没烤,两份都是中文」。
//  ④ window.onerror 抓到的一条都不许有;`<html lang>` 必须是这份该是的那种语言。
//
// 用法:node scripts/check-site-i18n-render.mjs   (要本机有 Chrome;CHROME=<路径> 可指定;先跑过生成器)
// ⚠ 非发版门禁,是 check-i18n-drift 官网那一份的回归网(照 check-contrast-xcheck 的定位)。

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = "site/index.html";
const NL = "\n";
// 页名从 site/pages/ 现算(⛔ 别手写:新加一页忘了登记 = 那页的英文一个字都没被看过)
const NAMES = ["index", ...readdirSync(resolve(root, "site/pages")).filter((f) => f.endsWith(".html")).sort().map((f) => f.slice(0, -5))];
const fileOf = (lang, name) => `site-app/${lang === "en" ? "en/" : ""}${name}.html`;

function findChrome() {
  const cands = [
    process.env.CHROME,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    // ⚠ 真二进制排在 /usr/bin/google-chrome 前面:那个是发行版包的壳脚本,本机这只往
    // 命令行里塞了 `--user-data-dir`(空值)与别的开关,--dump-dom 直接报「Multiple
    // targets are not supported in headless mode」。壳脚本的参数不归我们管。
    "/opt/google/chrome/chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  const hit = cands.find((p) => existsSync(p));
  if (!hit) {
    console.error("找不到 Chrome。这只工装靠真浏览器显出页面,没有它就没有校验 —— 用 CHROME=<路径> 指一个。");
    process.exit(2);
  }
  return hit;
}

// ---- Node 侧:独立解析字典与绑定表(源 site/index.html 那段源数据) ----

const src = readFileSync(resolve(root, SOURCE), "utf8");
const ENTRY_LINE =
  /^\s*"([A-Za-z0-9.]+)"\s*:\s*\{\s*zh\s*:\s*"((?:[^"\\\n]|\\.)*)"\s*,\s*en\s*:\s*"((?:[^"\\\n]|\\.)*)"\s*\}\s*,\s*$/;

function dictOf() {
  const a = src.indexOf("⟦i18n-dict⟧");
  const b = src.indexOf("⟦/i18n-dict⟧");
  if (a === -1 || b === -1 || b < a) throw new Error(`${SOURCE} 找不到成对的内联字典标记`);
  const body = src.slice(src.indexOf("\n", a) + 1, src.lastIndexOf("\n", b) + 1);
  const out = new Map();
  for (const line of body.split("\n")) {
    if (/^\s*$/.test(line) || /^\s*\/\*.*\*\/\s*$/.test(line)) continue;
    const m = ENTRY_LINE.exec(line);
    if (!m) throw new Error(`${SOURCE} 字典行不合形:${line.trim().slice(0, 60)}`);
    out.set(m[1], { zh: JSON.parse(`"${m[2]}"`), en: JSON.parse(`"${m[3]}"`) });
  }
  if (!out.size) throw new Error(`${SOURCE} 解析出 0 个键 —— 取块出错了`);
  return out;
}
function bindingsOf() {
  const m = /\bvar BIND = \{([^}]*)\};/.exec(src);
  if (!m) throw new Error(`${SOURCE} 读不到 BIND 绑定表`);
  const pairs = [...m[1].matchAll(/"(data-i18n-[a-z-]+)"\s*:\s*"([a-z-]+)"/g)].map((x) => [x[1], x[2]]);
  if (!pairs.length) throw new Error(`${SOURCE} 的 BIND 表是空的`);
  return pairs;
}
const dict = dictOf();
const binds = bindingsOf();

/** 正控②的分母:静态数一遍这份页里挂了多少处绑定(含 data-i18n 自己)。 */
function staticSites(raw) {
  const out = [];
  for (const m of raw.matchAll(/<[a-zA-Z][^>]*>/g)) {
    for (const attr of ["data-i18n", ...binds.map((b) => b[0])]) {
      const hit = new RegExp(`(?:^|\\s)${attr}="([^"]*)"`).exec(m[0]);
      if (hit) out.push([attr, hit[1]]);
    }
  }
  return out;
}

// ---- 跑 ------------------------------------------------------------------------------

const CHROME = findChrome();
const work = mkdtempSync(join(tmpdir(), "zj-site-i18n-"));
let bad = 0;

/** 跑一份页,回 Map(key#attr -> 读回来的字);对不上的就地记账。 */
function runPage(rel, lang) {
  const raw = readFileSync(resolve(root, rel), "utf8");
  const expectSites = staticSites(raw);
  const prelude = [
    "<script>",
    "(function(){var mem={};Object.defineProperty(window,'localStorage',{value:{",
    "  getItem:function(k){return Object.prototype.hasOwnProperty.call(mem,k)?mem[k]:null;},",
    "  setItem:function(k,v){mem[k]=String(v);},removeItem:function(k){delete mem[k];}}});",
    `Object.defineProperty(navigator,'language',{value:'${lang === "zh" ? "zh-CN" : "en-US"}'});`,
    "window.__errs=[];window.onerror=function(m){window.__errs.push(String(m));};})();",
    "</" + "script>",
  ].join(NL);
  const probe = [
    "<script>",
    "(function(){var res=[];var B=" + JSON.stringify(binds) + ";",
    "var t=document.querySelectorAll('[data-i18n]');",
    "for(var i=0;i<t.length;i++)res.push(['data-i18n',t[i].getAttribute('data-i18n'),t[i].textContent]);",
    "for(var b=0;b<B.length;b++){var n=document.querySelectorAll('['+B[b][0]+']');",
    "  for(var j=0;j<n.length;j++)res.push([B[b][0],n[j].getAttribute(B[b][0]),n[j].getAttribute(B[b][1])]);}",
    "var payload=JSON.stringify({errs:window.__errs,rows:res,lang:document.documentElement.lang});",
    "document.title='RESULT';",
    "document.body.textContent='@@BEGIN@@'+payload+'@@END@@';})();",
    "</" + "script>",
  ].join(NL);
  // ⚠ 别用 String.replace 找标签:注释里写过一次 </body> 字面量,第一次就替到那儿去了
  // (360 判例)。开标签取**第一个真标签**、闭标签取**最后一处**。
  const open = /<body[^>]*>/.exec(raw);
  const close = raw.lastIndexOf("</body>");
  if (!open || close === -1 || close < open.index) throw new Error(`${rel} 的 <body> 边界认不出来`);
  const html = raw.slice(0, open.index + open[0].length) + NL + prelude + raw.slice(open.index + open[0].length, close) + probe + NL + raw.slice(close);
  const file = join(work, rel.replace(/[\\/]/g, "_"));
  writeFileSync(file, html);
  const dom = execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=3000", "--dump-dom", file], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  });
  // 正控①
  if (!/<title[^>]*>RESULT<\/title>/.test(dom)) throw new Error(`${rel}:页内脚本没跑完(title 元素不是 RESULT)`);
  const seg = /@@BEGIN@@([\s\S]*?)@@END@@/.exec(dom);
  if (!seg) throw new Error(`${rel}:没有结果段`);
  const payload = JSON.parse(seg[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
  // 正控④
  if (payload.errs.length) throw new Error(`${rel}:页面报错 ${payload.errs.length} 条 —— ${payload.errs[0]}`);
  if (payload.lang !== lang) throw new Error(`${rel}:<html lang> 是「${payload.lang}」,应是「${lang}」`);
  // 正控②
  if (payload.rows.length !== expectSites.length) {
    throw new Error(`${rel}:读回 ${payload.rows.length} 处,静态数出 ${expectSites.length} 处 —— 有元素整个没被读到`);
  }
  const seen = new Map();
  for (const [attr, key, got] of payload.rows) {
    const entry = dict.get(key);
    if (!entry) {
      console.log(`  ✗ ${rel}  ${attr}="${key}" 不在字典里`);
      bad++;
      continue;
    }
    // 属性逐字比。文字允许首尾多出源里排版的空白,但字典值自己带的空格(两段 span 之间的那个)
    // 必须原样在 —— 只比 trim 后的那一截,会把「英文两段粘在一起」判成绿。
    const want = entry[lang];
    const ok = attr === "data-i18n" ? got === want || (got.trim() === want.trim() && got.includes(want)) : got === want;
    const shown = attr === "data-i18n" ? got.trim() : got;
    seen.set(`${key}#${attr}`, shown);
    if (!ok) {
      console.log(`  ✗ ${rel}  ${attr}="${key}"  屏幕上「${shown}」/ 字典「${entry[lang]}」`);
      bad++;
    }
  }
  return { seen, sites: expectSites.length };
}

try {
  for (const name of NAMES) {
    const zh = runPage(fileOf("zh", name), "zh");
    const en = runPage(fileOf("en", name), "en");
    // 正控③:同一页中英两份之间必须真有一批读出不同的字
    const diff = [...zh.seen.keys()].filter((k) => en.seen.has(k) && zh.seen.get(k) !== en.seen.get(k)).length;
    if (diff < zh.sites / 2) throw new Error(`${name}:中英两份只有 ${diff} / ${zh.sites} 处读出不同 —— 英文页可能压根没烤`);
    console.log(`  ${name}:中文 ${zh.sites} 处 / 英文 ${en.sites} 处绑定,两份差异 ${diff} 处(正控③)`);
  }
} catch (e) {
  console.error(e.message);
  bad = -1;
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (bad === 0) {
  console.log(`官网双语渲染对拍通过:${NAMES.length} 页 × 中英两份,${dict.size} 键,逐条与字典相同,页面零报错。`);
} else if (bad > 0) {
  console.error(`官网双语渲染对拍不过:${bad} 处对不上。`);
}
process.exit(bad === 0 ? 0 : 1);

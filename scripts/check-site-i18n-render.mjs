#!/usr/bin/env node
// 官网双语渲染对拍(360,i18n-plan 第③笔)。check-i18n-drift 是**静态**的:它核得了
// 「壳原文 = zh 字典」「键双向」「形状」,核不了「那段内联运行期真跑起来会把字换成什么」。
// 客户端两端有 e2e / CDP 资产兜这一格,官网此前一格都没有 —— 这只工装补的就是它。
//
// # 判据
//
// 把 site/index.html 原样喂给真 Chrome,只在最前面插一段 prelude(桩掉 localStorage、
// 把 navigator.language 顶成目标语言、挂 window.onerror),让页面自己那段 i18n 跑完,
// 然后**把屏幕上的字读回来**,拿去与 Node 侧独立解析出的字典逐条比。两档各跑一遍。
//
// 页内脚本只负责「报告看见了什么」,判断全在 Node 侧 —— 页内做判断的话,它自己写错
// 的方式和被测对象写错的方式长得一样(337 对拍工装那一栏的教训)。
//
// # 正控(缺一个,这只工装就可能安静地绿)
//
//  ① <title>RESULT</title> 必须在:证明页内脚本**跑完了**,不是「文档里出现过 RESULT」。
//  ② 回来的条数必须恰等于 Node 侧静态数出的绑定处数:守「有元素整个没被读到」。
//  ③ 两档之间必须真有一批键读出不同的字:守「lang 根本没生效,两次跑的都是中文」。
//  ④ window.onerror 抓到的一条都不许有:那段运行期是 fail-fast 的(未知键当场 throw),
//     它一 throw 就会停在半路 —— 而半路停下的页面看着像「有些字没翻」,不像出错。
//
// 用法:node scripts/check-site-i18n-render.mjs   (要本机有 Chrome;CHROME=<路径> 可指定)
// ⚠ 非发版门禁,是 check-i18n-drift 官网那一份的回归网(照 check-contrast-xcheck 的定位)。

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "site/index.html";
const NL = "\n";

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
    console.error("找不到 Chrome。这只工装靠真浏览器跑那段运行期,没有它就没有校验 —— 用 CHROME=<路径> 指一个。");
    process.exit(2);
  }
  return hit;
}

// ---- Node 侧:独立解析字典与绑定(与页面里那份 var M 同源同文件,但由这里自己读) ----

const raw = readFileSync(resolve(root, SITE), "utf8");

const ENTRY_LINE =
  /^\s*"([A-Za-z0-9.]+)"\s*:\s*\{\s*zh\s*:\s*"((?:[^"\\\n]|\\.)*)"\s*,\s*en\s*:\s*"((?:[^"\\\n]|\\.)*)"\s*\}\s*,\s*$/;

function dictOf() {
  const a = raw.indexOf("⟦i18n-dict⟧");
  const b = raw.indexOf("⟦/i18n-dict⟧");
  if (a === -1 || b === -1 || b < a) throw new Error(`${SITE} 找不到成对的内联字典标记`);
  const body = raw.slice(raw.indexOf("\n", a) + 1, raw.lastIndexOf("\n", b) + 1);
  const out = new Map();
  for (const line of body.split("\n")) {
    if (/^\s*$/.test(line) || /^\s*\/\*.*\*\/\s*$/.test(line)) continue;
    const m = ENTRY_LINE.exec(line);
    if (!m) throw new Error(`${SITE} 字典行不合形:${line.trim().slice(0, 60)}`);
    out.set(m[1], { zh: JSON.parse(`"${m[2]}"`), en: JSON.parse(`"${m[3]}"`) });
  }
  if (!out.size) throw new Error(`${SITE} 解析出 0 个键 —— 取块出错了`);
  return out;
}

function bindingsOf() {
  const m = /\bvar BIND = \{([^}]*)\};/.exec(raw);
  if (!m) throw new Error(`${SITE} 读不到 BIND 绑定表`);
  const pairs = [...m[1].matchAll(/"(data-i18n-[a-z-]+)"\s*:\s*"([a-z-]+)"/g)].map((x) => [x[1], x[2]]);
  if (!pairs.length) throw new Error(`${SITE} 的 BIND 表是空的`);
  return pairs;
}

const dict = dictOf();
const binds = bindingsOf();

/** 正控②的分母:静态数一遍「壳里到底挂了多少处绑定」(含 data-i18n 自己)。 */
function staticSites() {
  const out = [];
  for (const m of raw.matchAll(/<[a-zA-Z][^>]*>/g)) {
    for (const attr of ["data-i18n", ...binds.map((b) => b[0])]) {
      const hit = new RegExp(`(?:^|\\s)${attr}="([^"]*)"`).exec(m[0]);
      if (hit) out.push([attr, hit[1]]);
    }
  }
  return out;
}
const expectSites = staticSites();

// ---- 跑 ------------------------------------------------------------------------------

const CHROME = findChrome();
const work = mkdtempSync(join(tmpdir(), "zj-site-i18n-"));
let bad = 0;
const seen = {}; // lang -> Map(key#attr -> 读回来的字)

try {
  for (const lang of ["zh", "en"]) {
    // prelude:桩掉 localStorage(file:// 上它可能直接抛)、把系统语言顶成目标语言、挂 onerror。
    const prelude = [
      "<script>",
      "(function(){var mem={};Object.defineProperty(window,'localStorage',{value:{",
      "  getItem:function(k){return Object.prototype.hasOwnProperty.call(mem,k)?mem[k]:null;},",
      "  setItem:function(k,v){mem[k]=String(v);},removeItem:function(k){delete mem[k];}}});",
      `Object.defineProperty(navigator,'language',{value:'${lang === "zh" ? "zh-CN" : "en-US"}'});`,
      "window.__errs=[];window.onerror=function(m){window.__errs.push(String(m));};})();",
      "</" + "script>",
    ].join(NL);
    // 读回来:页内只报告,不判断
    const probe = [
      "<script>",
      "(function(){var res=[];var B=" + JSON.stringify(binds) + ";",
      "var t=document.querySelectorAll('[data-i18n]');",
      "for(var i=0;i<t.length;i++)res.push(['data-i18n',t[i].getAttribute('data-i18n'),t[i].textContent]);",
      "for(var b=0;b<B.length;b++){var n=document.querySelectorAll('['+B[b][0]+']');",
      "  for(var j=0;j<n.length;j++)res.push([B[b][0],n[j].getAttribute(B[b][0]),n[j].getAttribute(B[b][1])]);}",
      "var payload=JSON.stringify({errs:window.__errs,rows:res});",
      "document.title='RESULT';",
      "document.body.textContent='@@BEGIN@@'+payload+'@@END@@';})();",
      "</" + "script>",
    ].join(NL);

    // ⚠ 别用 String.replace 找标签:注释里写过一次 </body> 字面量,第一次就替到那儿去了
    // (360 判例)。开标签取**第一个真标签**、闭标签取**最后一处**,并各自自证只有一处。
    const open = /<body[^>]*>/.exec(raw);
    const close = raw.lastIndexOf("</body>");
    if (!open || close === -1 || close < open.index) throw new Error(`${SITE} 的 <body> 边界认不出来`);
    const html =
      raw.slice(0, open.index + open[0].length) + NL + prelude + raw.slice(open.index + open[0].length, close) + probe + NL + raw.slice(close);
    const file = join(work, `site-${lang}.html`);
    writeFileSync(file, html);
    const dom = execFileSync(
      CHROME,
      ["--headless=new", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=3000", "--dump-dom", file],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 },
    );

    // 正控①:title 这个**元素**必须在(RESULT 那几个字母在没跑的脚本源码里也有)
    // 官网的 <title> 自己挂着 data-i18n,故不能锚裸的 <title> —— 锚的是这个**元素**的文本
    if (!/<title[^>]*>RESULT<\/title>/.test(dom)) throw new Error(`${lang}:页内脚本没跑完(title 元素不是 RESULT)`);
    const seg = /@@BEGIN@@([\s\S]*?)@@END@@/.exec(dom);
    if (!seg) throw new Error(`${lang}:没有结果段`);
    const payload = JSON.parse(seg[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));

    // 正控④:那段运行期是 fail-fast 的,一 throw 就停在半路 —— 半路停下的页面看着只是「有些字没翻」
    if (payload.errs.length) throw new Error(`${lang}:页面报错 ${payload.errs.length} 条 —— ${payload.errs[0]}`);
    // 正控②:读回来的处数必须恰等于静态数出的绑定处数
    if (payload.rows.length !== expectSites.length) {
      throw new Error(`${lang}:读回 ${payload.rows.length} 处,静态数出 ${expectSites.length} 处 —— 有元素整个没被读到`);
    }

    seen[lang] = new Map();
    for (const [attr, key, got] of payload.rows) {
      const entry = dict.get(key);
      if (!entry) {
        console.log(`  ✗ ${lang}  ${attr}="${key}" 不在字典里`);
        bad++;
        continue;
      }
      seen[lang].set(`${key}#${attr}`, got);
      if (got !== entry[lang]) {
        console.log(`  ✗ ${lang}  ${attr}="${key}"  屏幕上「${got}」/ 字典「${entry[lang]}」`);
        bad++;
      }
    }
  }

  // 正控③:两档之间必须真有一批读出不同的字。全等 = lang 压根没生效,而那样上面每一条
  // 比对都会在 zh 那一轮过、在 en 那一轮全红…… 除非字典 zh/en 恰好相同。钉个下界更直接。
  const diff = [...seen.zh.keys()].filter((k) => seen.zh.get(k) !== seen.en.get(k)).length;
  if (diff < expectSites.length / 2) {
    throw new Error(`两档只有 ${diff} / ${expectSites.length} 处读出不同 —— 语言可能压根没切`);
  }
  console.log(`  两档差异 ${diff} / ${expectSites.length} 处(正控③)`);
} catch (e) {
  console.error(e.message);
  bad = -1;
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (bad === 0) {
  console.log(`官网双语渲染对拍通过:${dict.size} 键 / ${expectSites.length} 处绑定,zh 与 en 两档逐条与字典相同,页面零报错。`);
} else if (bad > 0) {
  console.error(`官网双语渲染对拍不过:${bad} 处对不上。`);
}
process.exit(bad === 0 ? 0 : 1);

#!/usr/bin/env node
// check-contrast 的**外部校验**:把它算出的「生效前景/背景」拿去和真 Chrome 的
// getComputedStyle 逐条对拍(337)。
//
// # 为什么需要它
//
// 337 起 check-contrast 不再只看「同一条规则里自带前后景」,而是自己实现了一小段
// **CSS 层叠**(选择器匹配 / 特异性 / 文档顺序)。那 ~120 行读代码看不出对错,而它算错
// 的方式是安静的:给出一个过期的答案,然后「全过」。所以另立这只对拍。
//
// **差别只可能出在层叠那一层** —— 两边的颜色值都交给同一个浏览器去解析:
// 一边照签名建出真 DOM 读 getComputedStyle,另一边把门禁选出的那两个声明原样写进
// 一枚探针 div 再读。所以 DIFF 一定是「谁该赢」判错了,不会是颜色算法的差异。
//
// # 手法:伪类换成同权重的类
//
// `:hover` 与一个类同为 (0,1,0),`:not(:disabled)` 换成 `:not(.NOT_DISABLED)` 同理,
// 文档顺序也原样不动 —— 于是层叠结果与真悬停**逐字相同**。这不是「照着抄一份规则」。
//
// # ⚠ 第一版是假绿,两道正控是它留下的
//
// 它报过「对拍 4334 组,不一致 0」:页内脚本有语法错**根本没跑**,而 `--dump-dom` 把
// script 源码当正文吐了回来 —— 一行 DIFF 都没有,于是「全过」。连我 grep 到的哨兵
// `RESULT` 都是脚本源码里的那五个字母。教训:**一只只会说 OK 的工装,和一只没跑的工装,
// 输出是一样的**;正控要钉「产出量」,不能只钉「有没有错」。
//   ① `<title>RESULT</title>` 这个**元素**必须在
//   ② OK/DIFF 行数必须**恰好**等于送进去的组数
//
// # 用法
//
//   node scripts/check-contrast-xcheck.mjs
//
// 需要本机有 Chrome(找不到就响亮报,不静默跳过)。要指别处:`CHROME=<路径>`。
// 全对上 = 退出 0。**改动 check-contrast.mjs 的层叠部分之后必跑**;它不是发版门禁
// (发版跑的是 check-contrast 自己),是那道门禁的回归网。
//
// # 338:一次层叠 = 一个**文档**
//
// 门禁按文档层叠(capture 窗 / notebook 窗各一份,各带内联 `<style>`)。这里必须跟着分,
// 否则拿「全并成一份」的 CSS 去校验分文档的层叠 —— **两边一起错**,还是一片 OK。
// 样式清单两边取同一件东西(`scripts/lib/css-docs.mjs` 的 sheetsOf),所以「比的是同一批
// 文件」是结构事实,不再是这里写一句注释请后人遵守。
//
// # 343:多对拍一格**字号**
//
// 门禁 343 起还要算每个签名的**生效字号**(§2.2 第二条那条小字底线靠它)。那一格与前后景
// 同源同险:也是自己算的层叠,也会「给个过期答案然后全过」。所以同一棵合成 DOM 上顺手把
// `getComputedStyle().fontSize` 一起比了 —— 门禁说定不出来的那些跳过(合成 DOM 里读到的
// 是从 html 默认 16px 继承来的,与真应用的祖先无关,拿它比等于比一个假答案),并加正控 ④
// 钉住「跳过的不许悄悄变多」。
//
// 阴性对照(337 实跑):把 `win()` 里取最高特异性改成取最低 → 32 组 DIFF;基线 0 组。

import { writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DOCS, sheetsOf, R } from "./lib/css-docs.mjs";

const NL = String.fromCharCode(10);

/** 找 Chrome。找不到一律响亮 —— 静默跳过的校验等于没有。 */
function findChrome() {
  const cands = [
    process.env.CHROME,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
  for (const c of cands) if (existsSync(c)) return c;
  console.error("找不到 Chrome。这只工装靠真浏览器算层叠,没有它就没有校验 —— 用 CHROME=<路径> 指一个。");
  console.error("试过:" + NL + cands.map((c) => "  " + c).join(NL));
  process.exit(2);
}
const CHROME = findChrome();

// ---- 读门禁的 --list(它红着也要读:要比的是「它算出了什么」,不是「它过没过」)----
let out;
try {
  out = execFileSync("node", [R("scripts/check-contrast.mjs"), "--list"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  });
} catch (e) {
  // 只吞「门禁自己红了」(那时 stdout 还在,正是要读的东西)。别的错误 —— 比如这只工装
  // 自身的 ReferenceError —— 一律抛:338 改这里时真把 `R` 删漏了,catch 把它变成空字符串,
  // 于是下面报的是「--list 的输出格式改了」,查错查到门禁那边去了。
  if (e.stdout === undefined) throw e;
  out = e.stdout;
}
const rows = [];
const lines = out.split(NL);
for (let i = 0; i < lines.length; i++) {
  const a = lines[i].trim().split(/\s{2,}/);
  // 343 起多一列字号(`12px` / `?px` = 门禁定不出来)
  if (a.length !== 7 || !/^\d+\.\d\d$/.test(a[0])) continue;
  const b = (lines[i + 1] ?? "").replace(/\s*\[已登记\]\s*$/, "").trim().split(/\s{2,}/);
  if (b.length !== 2) continue;
  rows.push({
    mode: a[1] === "暗" ? "dark" : "light", px: a[2] === "?px" ? null : a[2],
    source: a[3], doc: a[4], file: a[5], sel: a[6],
    fg: b[0].replace(/^前景\s*/, ""), bg: b[1].replace(/^背景\s*/, ""),
  });
}
if (!rows.length) {
  console.error("check-contrast --list 一行都没解析到 —— 要么它的输出格式改了,要么它压根没判到东西");
  process.exit(1);
}

/** 一个文档的 CSS,按门禁看到的同一个顺序拼(同一件东西,不是照抄一份)。 */
const cssOf = (doc) => sheetsOf(doc).map((s) => s.text).join(NL);

/** 签名 → DOM 描述。 */
function domFor(sel) {
  return sel.split(/\s+/).map((cp) => {
    const cls = [], attrs = [];
    let id = "";
    const t = /^[a-zA-Z][\w-]*/.exec(cp);
    for (const m of cp.matchAll(/\.([\w-]+)/g)) cls.push(m[1]);
    for (const m of cp.matchAll(/#([\w-]+)/g)) id = m[1];
    for (const m of cp.matchAll(/:(?!not\()([\w-]+)/g)) cls.push(m[1].toUpperCase());
    // 属性选择器要**真的把属性设上**,否则建出来的元素根本不被那条规则命中,拿到的是
    // UA 默认样式 —— 那是工装的错,却会被误读成「门禁算错了」(337 真栽过一次)。
    for (const m of cp.matchAll(/\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g))
      attrs.push([m[1], m[2] ?? m[3] ?? m[4] ?? ""]);
    return { tag: t ? t[0] : "div", cls, id, attrs };
  });
}

const PSEUDO = ["hover", "focus-visible", "focus-within", "focus", "active", "disabled", "checked"];
const work = mkdtempSync(join(tmpdir(), "zj-xcheck-"));
let checked = 0, bad = 0, fsChecked = 0;

// ⚠ 这一段里的失败一律 `throw`,**不许 `process.exit()`** —— exit 会跳过下面的 finally,
// 把工作目录留在 %TEMP% 里(337 收尾时真留了一个;同族见 323-326 那次 30 GB 的堆积)。
try {
  for (const doc of DOCS) {
    const source = `${doc.source}·${doc.name}`;
    const mine = rows.filter((r) => r.source === doc.source && r.doc === doc.name);
    if (!mine.length) continue;
    let css = cssOf(doc);
    for (const p of PSEUDO) {
      css = css.split(":not(:" + p + ")").join(":not(.NOT_" + p.toUpperCase() + ")");
      css = css.split(":" + p).join("." + p.toUpperCase());
    }
    for (const mode of ["light", "dark"]) {
      const set = mine.filter((r) => r.mode === mode);
      if (!set.length) continue;
      const sig = JSON.stringify(
        set.map((r) => ({ sel: r.sel, fg: r.fg, bg: r.bg, px: r.px, dom: domFor(r.sel) })),
      );
      // 页内脚本用数组 join 拼,别用模板字面量 —— 337 那次假绿就是模板字面量把 \n
      // 变成了真换行、整段脚本语法错。
      const js = [
        "const SIG=" + sig + ";",
        'const H=document.getElementById("H"),P=document.getElementById("P"),res=[];',
        "for(const s of SIG){",
        '  H.textContent="";let cur=H,leaf=null;',
        '  for(const c of s.dom){var e=document.createElement(c.tag);e.className=c.cls.join(" ");',
        "    if(c.id)e.id=c.id;for(const a of (c.attrs||[]))e.setAttribute(a[0],a[1]);",
        "    cur.appendChild(e);cur=e;leaf=e;}",
        '  const cs=getComputedStyle(leaf);const real=cs.color+" | "+cs.backgroundColor;',
        '  P.textContent="";const p=document.createElement("div");',
        "  p.style.color=s.fg;p.style.background=s.bg;P.appendChild(p);",
        '  const ps=getComputedStyle(p);const want=ps.color+" | "+ps.backgroundColor;',
        // 343:字号那一格同样对拍。门禁说「定不出来」的跳过 —— 那种在这棵合成 DOM 里读到的
        // 是从 html 默认的 16px 继承下来的值,与真应用里的祖先无关,拿它比等于比一个假答案。
        '  var fs=s.px?(cs.fontSize===s.px?"FSOK":"FSDIFF["+cs.fontSize+" vs "+s.px+"]"):"FSSKIP";',
        '  res.push((real===want?"OK":"DIFF")+"  "+s.sel+"   BROWSER["+real+"]   GATE["+want+"]   "+fs);',
        "}",
        'document.title="RESULT";',
        'document.body.textContent="@@BEGIN@@"+String.fromCharCode(10)+res.join(String.fromCharCode(10))',
        '  +String.fromCharCode(10)+"@@END@@";',
      ].join(NL);
      const file = join(work, `xc-${doc.source}-${doc.name}-${mode}.html`);
      writeFileSync(
        file,
        '<!doctype html><html data-theme="' + mode + '"><meta charset="utf-8"><style>' + css + "</style>" + NL +
          '<body><div id="H"></div><div id="P"></div><script>' + NL + js + NL + "</" + "script></body></html>",
      );
      const dom = execFileSync(
        CHROME,
        ["--headless=new", "--disable-gpu", "--virtual-time-budget=3000", "--dump-dom", file],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 },
      );
      // 正控 ①:title 这个**元素**必须在(不是「文档里出现过 RESULT」——那五个字母
      // 在没跑的脚本源码里也有,第一版就是这么绿的)
      if (!/<title>RESULT<\/title>/.test(dom))
        throw new Error(`${source}/${mode}:页内脚本没跑完(没有 <title>RESULT</title>)`);
      const seg = /@@BEGIN@@([\s\S]*?)@@END@@/.exec(dom);
      if (!seg) throw new Error(`${source}/${mode}:没有结果段`);
      const marks = seg[1].split(NL).map((l) => l.trim()).filter((l) => /^(OK|DIFF)\s/.test(l));
      // 正控 ②:行数必须**恰好**等于送进去的组数
      if (marks.length !== set.length)
        throw new Error(`${source}/${mode}:回来 ${marks.length} 行,送进去 ${set.length} 组`);
      for (const line of marks) {
        checked++;
        if (line.includes("FSOK") || line.includes("FSDIFF")) fsChecked++;
        if (line.startsWith("DIFF") || line.includes("FSDIFF")) {
          bad++;
          console.log("  " + source + "/" + mode + "  " + line);
        }
      }
    }
  }
  // 正控 ③(338):对拍过的组数必须**恰好**等于门禁判出的组数。②守的是「送进一个文档的
  // 都回来了」,守不住「有整个文档没被送进去」—— 338 分文档之后,`--list` 那一列解析歪了
  // 就会让某个文档一组都不进 set,而输出只是个更小的数字后面跟着「不一致 0」。
  if (checked !== rows.length) {
    throw new Error(`对拍了 ${checked} 组,而门禁判出 ${rows.length} 组 —— 有文档整个没送进去`);
  }
  // 正控 ④(343):字号对拍过的组数必须**恰好**等于门禁声称算出了字号的组数。
  // 这一层失灵的形状是「门禁把字号全判成不知道」——那样它自己全绿、这里也一片 FSSKIP,
  // 两边一起安静。所以拿门禁自己报的那个数反着钉住。
  const claimed = rows.filter((r) => r.px !== null).length;
  if (fsChecked !== claimed) {
    throw new Error(`字号对拍了 ${fsChecked} 组,而门禁声称算出字号的有 ${claimed} 组`);
  }
  if (claimed === 0) throw new Error("门禁一组字号都没算出来 —— 343 那一层塌了,而它塌得很安静");
} catch (e) {
  console.error(e.message);
  bad = -1; // 非零退出,且不假装「对拍过了」
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (bad >= 0) {
  console.log(
    `对拍 ${checked} 组(其中字号那一格 ${fsChecked} 组,另 ${checked - fsChecked} 组门禁自己就说定不出来),` +
      `不一致 ${bad} 组` + (bad ? "" : " —— 门禁算的层叠与真 Chrome 逐条相同"),
  );
}
process.exit(bad === 0 ? 0 : 1);

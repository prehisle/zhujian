#!/usr/bin/env node
// 「做完了但还没发出去」这本账,按端切面现算(703 立;backlog 测试与工装 114)。
//
//   node scripts/unreleased.mjs                   三端全算
//   node scripts/unreleased.mjs --desktop         只算一端(--android / --ohos 同理,可叠加)
//   node scripts/unreleased.mjs --notes "一句话"  只核这句 notes 会不会被客户端吞掉,不算账
//   node scripts/unreleased.mjs --commits         连每端的提交清单一起印(默认只印轮次)
//
// ⭐ **为什么要有它**:发版降到一周一次左右之后(701),「哪端欠发、欠哪几轮」从「当天现算一小把」
//    变成五到七倍的量,而 699 那次**发版当天现算就漏了当天刚做完的两轮**。
//    ⛔ 但它**算的是候选,不是 notes** —— 见下面「这支脚本不做什么」。
//
// ── 判据从哪儿来(⛔ 别按印象改) ──────────────────────────────────────────────
// 归档 `backlog-archive.md#user-102` 那条「发版前重算」的两步,本脚本只机械化第 ①、② 步:
//   ①从上次发版那轮往下扫 progress-log 圈候选;②拿真 diff 判「该端的面上动没动」,**面空 = 不进**。
// 「该端的面」三份(⛔ 不是各自一个目录 —— 673 起 `shared/` 两端同 import,两边都算):
//   桌面 = src/ src-tauri/ core/ sync-proto/ shared/
//   安卓 = android/ core/ mobile/ sync-proto/ shared/
//   鸿蒙 = ohos/ android/src/ android/index.html core/ mobile/ sync-proto/ shared/   ← 699 现算的
//          (⚠ `ohos/` 的 vite root 指向 `android/`,两只手机壳共用同一棵前端树)
//
// ── 基准取哪一笔(这是本脚本唯一的近似,⚠ 别把它当权威) ──────────────────────
// 取「该端 `tauri.conf.json` 里 version **最后一次变成当前值**的那笔提交」(= 上次发版的 bump)。
//   ⛔ 别用 `git log -S'"version"'` —— pickaxe 数的是**该串出现次数的变化**,而 `"version"` 这个**键**
//      每次 bump 都在,次数不变 ⇒ 它只会答「初始化仓库那一笔」(703 第一版真栽在这,答了 2026-06-29)。
//      ⇒ 必须拿**完整的 `"version": "x.y.z"`** 去 -S,那串才是从 0 变 1。
//   ⚠ **bump 提交 ≠ 发出去的那棵树**:bump 之后到打 tag 之间还可能有提交。⇒ 本脚本的答案是
//      **下界**(「至少欠这些」)。权威:桌面 / 安卓看**公开仓**的 tag(`v*` / `android-v*`),
//      鸿蒙看 AGC 上架的那个包。⛔ 工作仓里那个 `v0.2.16` 是过期的,别拿它当基准。
//   ⚠ **鸿蒙自成一条线、不打 tag**(651 起),它的基准只有这一条路可走 —— 这也正是它最容易积压的原因
//      (699 逮到它积压了四轮共用树的改动,而此前的账一格都没记)。
//
// ── ⛔ 这支脚本不做什么(⛔ 别给它加) ────────────────────────────────────────
// **它不生成 notes,也不替你判某一笔进不进 notes。** 那一步是人判的,三条判例都不可机械化:
//   · 628「整端拿不到」:改在 `core/`,而该端前端压根没画那个东西(697 的卡片颜色 = 安卓面非空、
//     `android/` 一个字没碰 ⇒ 不进安卓 notes)。
//   · 688「行为零差」:673 搬家 / 683 撤埋点,改动面非空但用户那儿一模一样。
//   · 699「按机型分」:696 那三处复制钮修的是旧 WebView,而用户那台 Chrome 151 本来就好
//     ⇒ 判不进(他对不上号,位置该让给所有人都拿得到的那几件)。⛔ 这不是 628 的照搬,同形要重新判。
// ⇒ 本脚本把**面算全**、把候选连轮次标题一起端上来,**判断留给人**。
//    ⛔ 别给它加「自动写 notes」——那是拿一个代餐判据去糊一件本来就要人拍的事(memory `proxy-predicate-fails-both-ways`)。

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

const ENDS = {
  desktop: {
    label: "桌面",
    conf: "src-tauri/tauri.conf.json",
    surface: ["src/", "src-tauri/", "core/", "sync-proto/", "shared/"],
    tag: "公开仓 `v*`",
  },
  android: {
    label: "安卓",
    conf: "android/src-tauri/tauri.conf.json",
    surface: ["android/", "core/", "mobile/", "sync-proto/", "shared/"],
    tag: "公开仓 `android-v*`",
  },
  ohos: {
    label: "鸿蒙",
    conf: "ohos/src-tauri/tauri.conf.json",
    surface: ["ohos/", "android/src/", "android/index.html", "core/", "mobile/", "sync-proto/", "shared/"],
    tag: "⛔ 不打 tag(651 起自成一条线),权威 = AGC 上架的那个包",
  },
};

function git(...args) {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

// ⛔ fail-fast:读不到就抛,别回落一个「看着合理」的版本号
function currentVersion(conf) {
  const raw = readFileSync(join(REPO, conf), "utf8");
  const v = JSON.parse(raw).version;
  if (typeof v !== "string" || !v) throw new Error(`${conf} 里没有 version`);
  return v;
}

function bumpCommit(conf, version) {
  // ⛔ 完整的 `"version": "x.y.z"` —— 理由见头注
  const out = git("log", "-1", "--format=%H%x09%ad%x09%s", "--date=short", "-S", `"version": "${version}"`, "--", conf);
  if (!out) {
    throw new Error(
      `找不到把 ${conf} 的 version bump 成 ${version} 的那笔提交。\n` +
        `  可能的原因:①这个版本号是手改的(⛔ 发版一律走 bump-version.mjs)②历史被重写过。\n` +
        `  ⇒ 自己定基准:git log --format='%h %ad %s' --date=short -- ${conf}`,
    );
  }
  const [hash, date, subject] = out.split("\t");
  return { hash, date, subject };
}

// 提交信息里的轮次号:`docs(702):` / `feat(668):` / `tooling+docs(701 补):` / `docs(701 补2):`
function roundOf(subject) {
  const m = subject.match(/\(\s*(\d{2,4})\s*(?:补\d*)?\s*\)/);
  return m ? m[1] : null;
}

let progressLog = null;
function roundTitle(round) {
  progressLog ??= readFileSync(join(REPO, "docs/progress-log.md"), "utf8").split("\n");
  // 形:`## 701(2026-09-17,win-desk/工装+节奏):标题`  —— 只取正条目,`## 701 补` 那种跳过
  const head = progressLog.find((l) => l.startsWith(`## ${round}(`));
  if (!head) return null;
  const i = head.indexOf("):");
  return i < 0 ? head.slice(3) : head.slice(i + 2).trim();
}

function unreleased(key, end, wantCommits) {
  const version = currentVersion(end.conf);
  const base = bumpCommit(end.conf, version);
  const log = git("log", `${base.hash}..HEAD`, "--format=%h%x09%s", "--", ...end.surface);
  const commits = log ? log.split("\n").map((l) => { const [hash, ...rest] = l.split("\t"); return { hash, subject: rest.join("\t") }; }) : [];

  const rounds = [];
  for (const c of commits) {
    const r = roundOf(c.subject);
    if (r && !rounds.includes(r)) rounds.push(r);
  }
  rounds.sort((a, b) => Number(a) - Number(b));

  console.log(`\n## ${end.label} ${version}`);
  console.log(`   基准 ${base.hash.slice(0, 7)} · ${base.date} · ${base.subject}`);
  console.log(`   面   ${end.surface.join(" ")}`);
  console.log(`   权威 ${end.tag}`);

  if (commits.length === 0) {
    console.log(`   ⇒ ✅ **空** —— 这一端的面上,基准之后一笔没动。`);
    return { key, version, rounds: [], commits: 0 };
  }

  console.log(`   ⇒ ⭐ **${commits.length} 笔提交,涉及 ${rounds.length} 轮**:`);
  for (const r of rounds) {
    const t = roundTitle(r);
    console.log(`      ${r}  ${t ?? "⚠ progress-log 里没有这一轮的正条目(可能是「补」轮或号写错了)"}`);
  }
  const orphan = commits.filter((c) => !roundOf(c.subject));
  if (orphan.length) {
    console.log(`      ⚠ 另有 ${orphan.length} 笔提交信息里没有轮次号,⛔ 别漏判:`);
    for (const c of orphan) console.log(`         ${c.hash} ${c.subject}`);
  }
  if (wantCommits) {
    console.log(`      ── 提交清单 ──`);
    for (const c of commits) console.log(`         ${c.hash} ${c.subject}`);
  }
  return { key, version, rounds, commits: commits.length };
}

// ── notes 核对:⛔ 不手搓替身判据,把两端**真源码**里的 meaningfulNotes 抠出来各跑一次 ──
// 归档那条写的是「推 tag 前喂两端真源码的 meaningfulNotes 核『原样显』」,以前每次做一次性件;
// 这里把它固化。⚠ 两端是独立工程、判据逐字孪生(源码注释自己写着「改一处要同改」)
// ⇒ **两端结果不一致本身就是要报的红**,别取其中一份当答案。
const NOTES_SOURCES = ["src/update.ts", "android/src/main.ts"];

function loadMeaningfulNotes(file) {
  const src = readFileSync(join(REPO, file), "utf8");
  const start = src.indexOf("export function meaningfulNotes");
  if (start < 0) throw new Error(`${file} 里找不到 meaningfulNotes —— ⛔ 判据搬家了就来改本脚本,别绕过它`);
  // 从函数名后的第一个 { 起做括号配平
  let i = src.indexOf("{", start);
  if (i < 0) throw new Error(`${file}:meaningfulNotes 的函数体起始括号都没有`);
  let depth = 0, end = -1;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (depth === 0) { end = j; break; } }
  }
  if (end < 0) throw new Error(`${file}:meaningfulNotes 的函数体括号不配平`);
  const body = src.slice(i + 1, end);
  // ⛔ **参数名从签名里解析,别假设** —— 703 第一版写死了 `notes`,而桌面那份的第一个参数叫 `body`
  //    ⇒ 两端都当场 `ReferenceError` 炸掉。两份逻辑逐字孪生、**只有参数名不同**,
  //    源码注释那句「改一处要同改」说的是判据不是签名。⚠ 响亮地炸比默默取错值好,但没必要炸。
  const sigRaw = src.slice(src.indexOf("(", start) + 1, i);
  const params = sigRaw
    .slice(0, sigRaw.lastIndexOf(")"))           // 去掉 `): string` 那截返回类型
    .split(",")
    .map((p) => p.split(":")[0].trim())          // ⚠ TS 类型注解在 JS 里是语法错误,只留参数名
    .filter(Boolean);
  if (params.length !== 2) {
    throw new Error(`${file}:meaningfulNotes 现在是 ${params.length} 个参数(${params.join(", ")}),本脚本按 (正文, 版本号) 喂 ⇒ 去改本脚本`);
  }
  return new Function(...params, body);
}

function checkNotes(text, version) {
  console.log(`\n## notes 核对`);
  console.log(`   原文 「${text}」`);
  console.log(`   字数 ${[...text].length} 字 / ${Buffer.byteLength(text, "utf8")} 字节`);
  console.log(`   ⚠ 699 实测的容量:桌面 39 字装两行、安卓 37 字装三行;关键词别放句尾。`);

  const seen = [];
  for (const f of NOTES_SOURCES) {
    const fn = loadMeaningfulNotes(f);
    const out = fn(text, version);
    seen.push({ f, shown: out !== "" });
    console.log(`   ${out === "" ? "⛔ 吞掉不显" : "✅ 原样显"}  ← ${f}(喂的是真源码)`);
  }
  if (new Set(seen.map((s) => s.shown)).size > 1) {
    console.log(`   ⛔⛔ **两端判据打架** —— 源码注释写着「改一处要同改」,现在它们不一致,先去核对那两份。`);
    process.exitCode = 1;
    return;
  }
  if (!seen[0].shown) {
    console.log(`   ⇒ ⛔ 这句会被客户端**吞掉**(剥掉「朱简」「安卓版」「${version}」与标点后什么都不剩)`);
    console.log(`      ⇒ 写点真内容:用户看到的是「有新版 vX」紧跟着这一行,只把版本号又说一遍等于没写。`);
    process.exitCode = 1;
  } else {
    console.log(`   ⇒ ✅ 这句会**原样显**给用户。⚠ 打完 tag 仍要回读逐字比(workflow 只取 tag message 第一行)。`);
  }
}

// ── main ──
const argv = process.argv.slice(2);
const notesAt = argv.indexOf("--notes");
if (notesAt >= 0) {
  const text = argv[notesAt + 1];
  if (!text) { console.error("⛔ --notes 后面要跟一句话:node scripts/unreleased.mjs --notes \"卡片可标七色\""); process.exit(2); }
  // 核哪个版本号无所谓——判据只拿它当噪音剥;取桌面的当代表,并明说
  const v = currentVersion(ENDS.desktop.conf);
  console.log(`(拿桌面 ${v} 当被剥的版本串;安卓版本不同但判据一样)`);
  checkNotes(text, v);
  process.exit(process.exitCode ?? 0);
}

const wantCommits = argv.includes("--commits");
const picked = Object.keys(ENDS).filter((k) => argv.includes(`--${k}`));
const keys = picked.length ? picked : Object.keys(ENDS);

console.log(`朱简 未发账 —— ${new Date().toISOString().slice(0, 10)} 现算(HEAD ${git("rev-parse", "--short", "HEAD")})`);
console.log(`⚠ 基准 = 各端 version 最后一次变成当前值的那笔 bump ⇒ 答案是**下界**;权威见每端的「权威」行。`);

const results = keys.map((k) => unreleased(k, ENDS[k], wantCommits));

console.log(`\n## ⛔ 候选 ≠ notes —— 下面三条判例要你逐笔判(脚本判不了)`);
console.log(`   628 整端拿不到:改在 core/,而该端前端压根没画那个东西`);
console.log(`   688 行为零差  :搬家 / 撤埋点,面非空但用户那儿一模一样`);
console.log(`   699 按机型分  :修的是旧机型上的毛病,用户那台本来就好 ⇒ 判不进`);
console.log(`   ⇒ 挑定之后 \`node scripts/unreleased.mjs --notes "<草稿>"\` 核一遍会不会被吞掉。`);

const dirty = results.filter((r) => r.commits > 0);
if (dirty.length === 0) console.log(`\n✅ 三端都空 —— 没有「做完了还没发」的东西。`);
else console.log(`\n⭐ 欠发的端:${dirty.map((r) => `${ENDS[r.key].label}(${r.rounds.length} 轮)`).join(" · ")}`);

#!/usr/bin/env node
// 非发版门禁(441 立):压 scripts/lib/build-tools.mjs 那把「用哪一版 build-tools」的尺。
// 跑法:node scripts/check-build-tools-pick.mjs
//
// **它为什么存在**:两处调用点(build-android.mjs 核 versionCode、
// gen-android-update-manifest.mjs 的 aapt + **签名证书闸**)原本各写一句
// `readdirSync(btDir).sort().at(-1)` = 字典序。⚠ **挑错不一定报错**——它可能只是换了一版
// 工具、换了输出格式,而那正是 416 栽的病:签名闸把 signer 那行的头写死成 35 的形,
// CI 装的是 36 ⇒ 那道闸在真 CI 上第一次执行就读不到指纹、拒发。
// 来源:backlog「测试与工装 16①」。
//
// ⭐ 纪律一(样本的来路要写清):下面只有**两个版本号**是真量到的 ——
//   · `35.0.1` = Windows 那台本机(check-apksigner-parse.mjs 头注记的真实路径,2026-08-17);
//   · `36.0.0` = 两条安卓 CI workflow 里 `sdkmanager` **显式装的那个**。
//   ⛔ 「两者并存」这件事本身、以及别的所有目录名,都是**合成的**——GitHub runner 预装了
//   哪几版,这台(Linux,无 SDK)问不到,别把它写成"真实样本"。
//
// ⭐ 纪律二(每一格都要能分胜负):每条用例额外带一格 `oldWrong` ——
//   **旧尺(字典序)在这条输入上到底错不错**。挑错那几格必须 `true`(证明它逮的是真东西,
//   不是被别的判据兜着的空测,440 判例),回归那几格必须 `false`(证明这次修没把今天对的弄坏)。

import { pickBuildTools, describeBuildToolsPick } from "./lib/build-tools.mjs";

/** 修之前那把尺,逐字照抄 —— 只用来证明每条用例真的分得出胜负。 */
const oldRuler = (names) => [...names].sort().at(-1);

const CASES = [
  // [标题, 目录项, 期望挑中, 期望跳过项数, 旧尺是否会挑错]
  ["回归 · 本机只装了 35.0.1(真实版本号)", ["35.0.1"], "35.0.1", 0, false],
  ["回归 · 35.0.1 与 36.0.0 并存(两个版本号真实,并存是合成的)", ["35.0.1", "36.0.0"], "36.0.0", 0, false],
  ["回归 · 常见的一串两位主版本", ["33.0.1", "34.0.0", "35.0.0", "36.0.0"], "36.0.0", 0, false],

  // ── 三种真会挑错的形(账里点名的两种 + rc) ──
  ["挑错 · 双位补丁号:35.0.10 比 35.0.9 新", ["35.0.9", "35.0.10"], "35.0.10", 0, true],
  ["挑错 · 双位次版本号:36.10.0 比 36.9.0 新", ["36.9.0", "36.10.0"], "36.10.0", 0, true],
  ["挑错 · 三位主版本:100.0.0 比 36.0.0 新", ["36.0.0", "100.0.0"], "100.0.0", 0, true],
  ["挑错 · 单位主版本:36.0.0 比 9.0.0 新", ["9.0.0", "36.0.0"], "36.0.0", 0, true],
  ["挑错 · 预览版不许赢正式版(输出格式高发地)", ["36.0.0", "36.0.0-rc1"], "36.0.0", 0, true],

  // ── 认不出的目录项:不挑、但要报出来,⛔ 不许静默吞 ──
  ["杂项 · 非版本号目录项跳过并报数(⭐ 旧尺会挑中它:ASCII 里字母排在数字之后)", ["35.0.1", "source.properties"], "35.0.1", 1, true],
  ["杂项 · 半截下载目录混在里面(旧尺会挑中它)", ["36.0.0", "36.0.0.tmp"], "36.0.0", 1, true],
  ["杂项 · 隐藏文件不影响结果", [".DS_Store", "35.0.1"], "35.0.1", 1, false],

  // ── 只剩预览版:挑它,但要标出来(有总比判不了强,而"它是预览版"必须说) ──
  ["边界 · 只有预览版 → 挑它并标 prerelease", ["36.0.0-rc2", "36.0.0-rc1"], "36.0.0-rc2", 0, false],

  // ── fail-closed:一个都认不出 ⇒ null,调用方必须拒 ──
  ["fail-closed · 空目录 → null", [], null, 0, false],
  ["fail-closed · 全是认不出的名字 → null", ["docs", "readme.txt"], null, 2, false],
  ["fail-closed · 版本号缺一段(35.0)→ 不认,回 null", ["35.0"], null, 1, false],
];

let fail = 0;
for (const [title, names, want, wantSkipped, oldWrong] of CASES) {
  const got = pickBuildTools(names);
  const okPick = got.name === want;
  const okSkip = got.skipped.length === wantSkipped;
  // 旧尺那格:空目录/全跳过时旧尺回 undefined 或一个非版本名,一律算"不挑错"以免自欺——
  // 只有「旧尺挑中了一个合法版本号、却不是该挑的那个」才算它真错。
  const oldPick = oldRuler(names);
  const oldReallyWrong = want !== null && oldPick !== want;
  const okOld = oldReallyWrong === oldWrong;
  const ok = okPick && okSkip && okOld;
  if (!ok) fail++;
  console.log(`${ok ? "✅" : "❌"} ${title}`);
  if (!okPick) console.log(`     期望挑中 ${JSON.stringify(want)},实得 ${JSON.stringify(got.name)}`);
  if (!okSkip) console.log(`     期望跳过 ${wantSkipped} 项,实得 ${got.skipped.length}(${got.skipped.join(", ")})`);
  if (!okOld) {
    console.log(
      oldWrong
        ? `     ⚠ 这格本该分出胜负,但旧尺也挑中了 ${JSON.stringify(oldPick)} —— 它是空测,换个输入`
        : `     ⚠ 这格本不该分胜负,旧尺却挑了 ${JSON.stringify(oldPick)} —— 标注写错了`,
    );
  }
}

// ── 最后两格压的不是"挑谁",是**调用方看得见什么** ──
const quiet = describeBuildToolsPick(pickBuildTools(["35.0.1"]));
if (quiet.length !== 1 || !quiet[0].includes("35.0.1")) {
  fail++;
  console.log("❌ 正常一格也要如实说「挑中了谁」——发版日志里那一行是复盘时唯一的地面事实");
} else {
  console.log("✅ 正常路径也印「挑中了谁」(416 复盘时想找却找不到的那一行)");
}

const noisy = describeBuildToolsPick(pickBuildTools(["36.0.0-rc1", "junk"]));
const saysPreview = noisy.some((l) => l.includes("预览版"));
const saysSkipped = noisy.some((l) => l.includes("junk"));
if (!saysPreview || !saysSkipped) {
  fail++;
  console.log(`❌ 预览版与被跳过的项必须都说出来(实得:${JSON.stringify(noisy)})`);
} else {
  console.log("✅ 预览版与被跳过的项都点名报出(⛔ 不许静默吞)");
}

console.log(
  fail === 0
    ? `\n${CASES.length + 2} 格全过:按数字段比、正式版赢预览版、认不出的报出来、一个都没有就 fail-closed。`
    : `\n${fail} 格不符。`,
);
process.exit(fail === 0 ? 0 : 1);

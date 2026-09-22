#!/usr/bin/env node
// 给公开仓已有的 tag 补 GitHub Release 页(713 立)。
//
// **为什么要它**:发版链只推 tag(`android-release.yml` / `release.yml` 听的是 `push: tags`),
// 而 GitHub 的 Releases 页要另外建 —— 713 之前那一页是**空的**,12 个桌面版 + 28 个安卓版
// 一个都没露面。而每条 tag 的注解里**本来就写着那一版的一行人话**(发版时喂给两端
// `meaningfulNotes` 的同一句,更新提示条上显的就是它)⇒ 这支脚本只做「搬」,⛔ 不写文案。
//
// ⛔ **notes 一字不改地用 tag 注解原文**:另写一句就是同一件事的第二个家(712 判例)。
// ⛔ **不往 notes 里加安装包链接**:旧版的包在发版收尾时就清掉了,加了就是一页 404
//    (248 判例的同一形)。GitHub 自带的源码包足够。
// ⚠ 幂等:已有 Release 的 tag 跳过并印出来 ⇒ 每次发版后再跑一趟就补上新那一条。
//    ⛔ 已存在的 Release **不改**(改了会覆盖人后来手工补的正文)。
// ⚠ 没有 workflow 听 `release` 事件(713 查过:只有 `push: tags`)⇒ 建 Release 不起构建。

import { execFileSync } from "node:child_process";

const REPO = "prehisle/zhujian";
const DRY = process.argv.includes("--dry");

const gh = (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 << 20 });
const api = (path) => JSON.parse(gh(["api", path, "--paginate"]));
/* ⚠ `--jq` 出来的是**裸字符串**,不是 JSON ⇒ ⛔ 别拿 JSON.parse 接它(713 当场栽过一次)。 */
const apiText = (path, jq) => gh(["api", path, "--jq", jq]);

/* 版本线:tag 名决定它是哪一端。⛔ 别按「有没有 android- 前缀」之外的判据猜。 */
function line(tag) {
  if (tag.startsWith("android-v")) return { end: "安卓", ver: tag.slice("android-v".length) };
  if (/^v\d/.test(tag)) return { end: "桌面", ver: tag.slice(1) };
  return null;
}

const refs = api(`repos/${REPO}/git/refs/tags`);
const existing = new Set(JSON.parse(gh(["release", "list", "--repo", REPO, "--limit", "300", "--json", "tagName"])).map((r) => r.tagName));

/* 最新的那一条桌面版才挂 latest(仓库页顶上的「Latest」只有一个位置;
   官网首屏推的是桌面包 ⇒ 给桌面)。⚠ 按版本号排,⛔ 不按 tag 的创建时间
   —— 补建的顺序与发布顺序无关。 */
const cmpVer = (a, b) => a.localeCompare(b, undefined, { numeric: true });
const desktopTags = refs.map((r) => r.ref.replace("refs/tags/", "")).filter((t) => line(t)?.end === "桌面");
const newestDesktop = desktopTags.sort(cmpVer).at(-1);

let made = 0;
let skipped = 0;
const problems = [];

for (const r of refs) {
  const tag = r.ref.replace("refs/tags/", "");
  const l = line(tag);
  if (!l) {
    problems.push(`${tag}:认不出是哪一端(既不是 v* 也不是 android-v*)`);
    continue;
  }
  if (existing.has(tag)) {
    skipped += 1;
    continue;
  }
  /* 注解原文只有**带注解的** tag 才有;轻量 tag 的 object.type 是 commit ⇒ 没正文可搬。 */
  if (r.object.type !== "tag") {
    problems.push(`${tag}:轻量 tag,没有注解正文 ⇒ 不替它编一句`);
    continue;
  }
  const msg = apiText(`repos/${REPO}/git/tags/${r.object.sha}`, ".message").trim();
  if (!msg) {
    problems.push(`${tag}:注解是空的 ⇒ 不替它编一句`);
    continue;
  }
  const title = `${l.end} ${l.ver}`;
  if (DRY) {
    console.log(`  (dry) ${tag} → 「${title}」${tag === newestDesktop ? " [latest]" : ""}\n         ${msg.split("\n")[0]}`);
    made += 1;
    continue;
  }
  gh([
    "release", "create", tag,
    "--repo", REPO,
    "--title", title,
    "--notes", msg,
    `--latest=${tag === newestDesktop ? "true" : "false"}`,
    "--verify-tag",
  ]);
  console.log(`  ✓ ${tag} → 「${title}」`);
  made += 1;
}

console.log(`\n${DRY ? "(dry)" : ""} 建 ${made} 条 · 跳过已有 ${skipped} 条 · tag 共 ${refs.length} 个`);
if (problems.length) {
  /* ⛔ 不当失败退出:这几条是「说清楚了的空白」,不是坏。但**必须印出来** ——
     安静跳过就等于那几个版本从此不在 Releases 页上,而没有任何一处会红。 */
  console.log("\n⚠ 这几个没建(逐条说明):");
  for (const p of problems) console.log("  · " + p);
}

#!/usr/bin/env node
// 挑活「认领位」:开工前插一面看得见的小旗,别让两个环境撕同一条账(534 立,用户点头要)。
//
//   node scripts/claim-work.mjs list             谁在做什么(⭐ 挑活前先跑这一条)
//   node scripts/claim-work.mjs take <账号>       认领:tooling-50 / user-57 这样的形
//   node scripts/claim-work.mjs drop [账号]       撤:不给账号 = 撤掉本环境全部
//
// ── 要治的是什么(2026-08-29 实撞,不是设想)──────────────────────────────────
// `win-min-home` 与 `win-desk` **同一上午挑中同一条**(测试与工装 46),各自写完、各推一条闸分支
// (07:06:55 / 07:09:00),**各烧一趟 CI,只有一份能用**。⭐ 529 那枚检查工作了,但它只管**编号**
// (对端让掉 530 取了 531)—— **选题那格它管不着**:闸分支上没有 progress-log(docs 不导出),
// 它只数得出「有几笔在飞」、答不出「那笔在做什么」。
// ⛔ **靠「开工前多看一眼闸分支」防不住**:两条分支差 2 分钟,先动手那台取号时远端上一条别人的
// 分支都没有。要防得更早 —— 挑活那一刻,而那时对端连提交都还没有。
//
// ── 它与那条已拍的板 ─────────────────────────────────────────────────────────
// dev-and-testing 多环境那节开头写死:「⛔ 别立『两台互相知道对方在干嘛』那类纪律 —— 那正是
// 并行下唯一**不可观测**的东西」。⭐ **本脚本不违反它,它照着办**:那条禁的是**依赖不可观测的
// 意图**,而这里是**把意图造成一个可观测物**(一条真分支)。
// ⭐ **529 在同一根轴上破过同样的题**:「哪条闸分支是谁推的」原本也不可观测,解法不是立纪律,
//    是**给它造一个可观测的名字**。本脚本是同一手法的第二次使用。
// ⚠ 用户 2026-08-29 听完取舍后拍「试试」⇒ 这是**试用**,不是定论;不好用就删,别硬留。
//
// ── ⛔⛔ 承重的那一格:它**绝不动 master** ────────────────────────────────────
// 最直觉的做法是「往 backlog 写一行认领、提交推上去」—— **那会把对端害惨**:私有 master 一动,
// 对端那笔正飞在闸里的树立刻变成「落后」,`land` 当场拒,对端得 rebase + 重跑 29 分钟。
// ⇒ **认领反而制造了它要防的那种损失。** 本脚本推的是一条**指向 `origin/master` 的分支**:
// 不产生任何提交、不传任何新对象、master 一个字不动。⛔ **别把它改成"提交一行到 backlog"。**
//
// ── 三处诚实边界,⛔ 别读大了 ────────────────────────────────────────────────
// ①**不是锁**:两个环境在同一个「fetch → push」窗口里同时认领,照样撞(窗口从一整轮缩到几秒,
//   与 531 那道落后检查同形)。②**靠人真的去认**,忘了认就没有信号 —— ⛔ **别给它加机器闸**
//   (383 那条停止扩张线:这根轴最坏后果是「一趟 CI 白烧 + 一份实现白写」,不是数据面)。
//   ③它治**选题撞车**,不治**编号撞车** —— 后者归 `claim-entry.mjs`,两件事别混。
//
// ⚠ **放私有仓不放公开仓**:认领是内部工作状态,没必要进公开快照(而闸分支非进不可 —— CI 在那儿)。

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { devEnv } from "./lib/dev-env.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cmd = process.argv[2];
const arg = process.argv[3];

// ⛔ 形要收窄:它进分支名。⚠ 不许带 `/` —— 清理时按前缀 `claim/<env>/` 匹配,多一层会认错人
//    (同 529 那条「连字符会让名叫 win 的环境误匹配 gate/win-desk-…」的教训)。
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
// 建议的写法(⚠ 只是建议,脚本不强制 —— 强制它就得跟着 backlog 分区名走,那是会变的东西)
const HINT = "建议 `<区>-<号>`:tooling-50 / user-57 / code-12";

function die(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}
const git = (args, opts = {}) =>
  execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", ...opts }).trim();

let env;
try {
  env = devEnv(repoRoot);
} catch (e) {
  die(e.message);
}

/** 远端现有的认领旗。⛔ fail-closed:问不到就停,别拿空表当「没人认领」。 */
function listClaims() {
  let out;
  try {
    out = git(["ls-remote", "--heads", "origin", "refs/heads/claim/*"]);
  } catch (e) {
    die(
      `问不到私有仓的认领旗(git ls-remote 失败)—— ⛔ 不拿空表当「没人认领」:\n` +
        `  ${String(e.stderr || e.message).trim().slice(0, 200)}`,
    );
  }
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const ref = line.split("\t")[1].replace(/^refs\/heads\//, "");
      // claim/<env>/<YYYY-MM-DD>-<slug>
      const m = /^claim\/([^/]+)\/(\d{4}-\d{2}-\d{2})-(.+)$/.exec(ref);
      return m ? { ref, env: m[1], date: m[2], slug: m[3] } : { ref, env: null, date: null, slug: null };
    });
}

function printClaims(claims) {
  if (!claims.length) {
    console.log(`✅ 现在没有人认领任何账。`);
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  console.log(`现在有 ${claims.length} 面旗:`);
  for (const c of claims) {
    if (!c.env) {
      console.log(`  ? ${c.ref}  ⚠ 形不对、认不出是谁的 —— ⛔ 不碰,手动处置`);
      continue;
    }
    const mine = c.env === env ? " ← 本环境" : "";
    const stale = c.date && c.date < today ? `  ⚠ ${c.date} 插的,不是今天` : "";
    console.log(`  · ${c.slug}   ${c.env}${mine}${stale}`);
  }
}

if (cmd === "list") {
  printClaims(listClaims());
  console.log(`\n⚠ 它不是锁:同一个几秒窗口里两边同时认领照样撞。⛔ 也别指望人人都记得插旗。`);
} else if (cmd === "take") {
  if (!arg || !SLUG.test(arg)) die(`账号形不对(要 [a-z0-9-],40 位内,小写开头,⛔ 不许带 /)。${HINT}`);
  const claims = listClaims();
  // ⛔ 别人认过同一条 ⇒ fail-closed 拒,**别静默覆盖**:那等于把这面旗的意义抹掉。
  const other = claims.find((c) => c.slug === arg && c.env && c.env !== env);
  if (other) {
    die(
      `\`${arg}\` 已经被 \`${other.env}\` 认领了(${other.date})—— ⛔ 换一条,别两边同时做。\n` +
        `  ⚠ 真要接手,先跟对方说清楚,再让**它**跑 \`drop\`;⛔ 本脚本不替你抢。`,
    );
  }
  const mineSame = claims.find((c) => c.slug === arg && c.env === env);
  if (mineSame) {
    console.log(`✅ \`${arg}\` 本环境已经认过了(${mineSame.date})—— 什么都没做。`);
    process.exit(0);
  }
  // ⛔⛔ 指向 origin/master,**不产生提交、不动 master**(整个脚本的价值就在这一行)。
  git(["fetch", "-q", "origin"]);
  const ref = `claim/${env}/${new Date().toISOString().slice(0, 10)}-${arg}`;
  git(["push", "-q", "origin", `origin/master:refs/heads/${ref}`]);
  console.log(`✅ 插旗:${ref}`);
  console.log(`   ⚠ 收口(或弃坑)时记得撤:node scripts/claim-work.mjs drop ${arg}`);
  const others = claims.filter((c) => c.env && c.env !== env);
  if (others.length) {
    console.log(`\n⚠ 顺带:别的环境手上还有 ${others.length} 条 —— ${others.map((c) => `${c.slug}(${c.env})`).join(" / ")}`);
  }
} else if (cmd === "drop") {
  if (arg && !SLUG.test(arg)) die(`账号形不对。${HINT}`);
  // ⛔ 只碰 `claim/<本环境>/*` —— 同 529 `sweep` 那条:够不着别人的旗。
  const mine = listClaims().filter((c) => c.env === env && (!arg || c.slug === arg));
  if (!mine.length) {
    console.log(`✅ 本环境(${env})没有${arg ? ` \`${arg}\` 这面` : ""}旗要撤。`);
    process.exit(0);
  }
  for (const c of mine) {
    try {
      git(["push", "-q", "origin", "--delete", c.ref]);
      console.log(`  · ${c.ref}  已撤`);
    } catch {
      console.log(`  · ${c.ref}  ⚠ 没撤掉(手动:git push origin --delete ${c.ref})`);
    }
  }
} else {
  console.log(`用法:
  node scripts/claim-work.mjs list           谁在做什么(⭐ 挑活前先跑这一条)
  node scripts/claim-work.mjs take <账号>     认领(${HINT})
  node scripts/claim-work.mjs drop [账号]     撤;不给账号 = 撤掉本环境全部

本环境:${env}`);
  process.exit(cmd ? 1 : 0);
}

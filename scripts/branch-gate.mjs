#!/usr/bin/env node
// 分支闸:**私有仓 master 只接收「公开 CI 已经绿过」的树**(520 立,用户点名要)。
//
//   node scripts/branch-gate.mjs verify    把当前这棵树推到公开仓的一条闸分支,CI 就跑起来
//   node scripts/branch-gate.mjs status    问那棵树的 CI 绿了没(⛔ 别前台等,过会儿再问)
//   node scripts/branch-gate.mjs land      fail-closed:绿了才落地(私有 master + 公开 main)
//   node scripts/branch-gate.mjs abandon   放弃这一趟,把公开仓本地 main 退回 origin/main
//
// ── 为什么是这个形,不是 GitHub 的 PR 闸 ────────────────────────────────────────
// ⛔ **私有仓在 Free 计划上没有分支保护**(520 实测:`branches/master/protection` 回
//    `403 Upgrade to GitHub Pro or make this repository public`)⇒ GitHub 强制的那种闸买不到。
// ⭐ 但更要紧的一格是:**即便买了 Pro 也不够** —— CI 跑在**公开仓**(ci-plan §6 拍板 A,
//    私有仓跑全矩阵估 $30–60/月已被否),而 GitHub 原生的 required status check
//    **够不着另一个仓的结论**。⇒ 「这棵树的公开 CI 绿没绿」这段判据**无论如何都得自己写**。
//    本脚本就是它;哪天真买了 Pro,把 `ciVerdict()` 挪进私有仓的一支小 workflow 即可
//    (公开仓的 Actions 数据**匿名可读**,不需要任何 token)。
//
// ── 承重的那一格:绑定 ────────────────────────────────────────────────────────
// ⭐ **公开仓那份 clone 始终留在 `main` 上提交,只是先把那笔提交推到闸分支**;CI 绿之后
//    推上 main 的**是同一笔提交(同一个 sha)**。⛔ 不是「合并后再导出一次,希望它一样」——
//    那属于 memory `verify-artifact-predates-fix` 那族:失灵时不报错,只给一个看着合理的错答案。
// ⭐ **一律不存状态文件**,闸分支名从私有 HEAD 推导(`gate/<短 sha>`)。私有 HEAD 一动,
//    推导出来的名字就对不上 ⇒ 当场 fail-closed。**状态文件会腐烂,推导不会。**
//
// ⚠ **两处诚实边界,别读大了**:
//   ①**这是脚本闸不是平台闸** —— 谁直接敲 `git push origin master` 都绕得过去。它与
//     dev-and-testing 那六条规矩同级:绑在可观测的东西上的纪律,不是不可逾越的墙。
//   ②**落地会比以前慢** —— 整趟 CI 约 29 分钟(493 实测),`land` 之前 master 是不动的。
//     ⛔ 但**别前台等**(memory `dont-block-on-ci`):verify 完就去做别的,回来再 land。

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_REPO = "prehisle/zhujian";
const proxy = process.env.ZJ_GIT_PROXY ?? "socks5h://127.0.0.1:10808";
const target = resolve(join(repoRoot, "..", "zhujian-public"));

const cmd = process.argv[2];

function die(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}
function git(cwd, args, opts = {}) {
  return execFileSync("git", args, { cwd, encoding: "utf8", ...opts }).trim();
}
function gitProxy(cwd, args) {
  return execFileSync("git", ["-c", `http.proxy=${proxy}`, ...args], { cwd, encoding: "utf8" }).trim();
}

if (!existsSync(join(target, ".git"))) die(`公开仓工作副本不在:${target}(它是独立 clone,不是本仓的子目录)`);

// 闸分支名 = 私有 HEAD 的短 sha 推导出来的。⛔ 别改成随机名 / 时间戳:那样就不再"树一动就对不上"了。
const headSha = git(repoRoot, ["rev-parse", "--short", "HEAD"]);
const gateBranch = `gate/${headSha}`;

// ── 判 CI ─────────────────────────────────────────────────────────────────────
// 三态,⛔ 别塌成两态:`cancelled` **既不是绿也不是红**(518 那一课 —— 近 14 趟里占 4,
// 而"看了也白看"正是它造成的)。`in_progress` 同理:没有结论就是没有结论。
function ciVerdict(sha) {
  let raw;
  try {
    raw = execFileSync(
      "gh",
      ["api", `repos/${PUBLIC_REPO}/actions/runs?head_sha=${sha}&per_page=50`, "--jq",
       ".workflow_runs[] | {name, status, conclusion, url: .html_url} | tostring"],
      { encoding: "utf8" },
    );
  } catch (e) {
    return { state: "unknown", why: `问不到公开仓的 CI(gh api 失败):${String(e.stderr || e.message).trim().slice(0, 200)}` };
  }
  const runs = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const ci = runs.filter((r) => r.name === "ci");
  if (!ci.length) {
    return { state: "unknown", why: `公开仓 ${sha.slice(0, 7)} 上没有 \`ci\` 的 run —— 推上去了吗?还是刚推、run 还没建?` };
  }
  // 同一个 sha 可能有多趟(手动重跑)。⭐ 只要**有一趟绿**就算绿:重跑是为了排除抖动,
  // 而一趟真绿是正面字据。⛔ 但"没有绿的"时别报最后一趟的结论了事,要说清有几趟、都是什么。
  const green = ci.find((r) => r.conclusion === "success");
  if (green) return { state: "green", why: `${ci.length} 趟里有绿的`, url: green.url };
  const running = ci.find((r) => r.status !== "completed");
  if (running) return { state: "running", why: `还在跑(${running.status})`, url: running.url };
  const last = ci[0];
  return { state: "red", why: `${ci.length} 趟全非绿,最近一趟 = ${last.conclusion}`, url: last.url };
}

// ── verify ────────────────────────────────────────────────────────────────────
function verify() {
  const dirty = git(repoRoot, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty) die(`工作仓有未提交的改动 —— 闸绑的是「哪一笔提交」,先提交:\n${dirty}`);

  console.log(`本轮闸分支:${gateBranch}(私有 HEAD ${headSha})\n`);
  try {
    execFileSync(process.execPath, ["scripts/sync-public.mjs", "--to-branch", gateBranch], {
      cwd: repoRoot, stdio: "inherit",
    });
  } catch {
    die("sync-public 非零退出(上面就是理由)—— 什么都没推。");
  }
  console.log(`\n⭐ 去做别的(⛔ 别前台等,整趟约 29 分钟)。回来跑:`);
  console.log(`   node scripts/branch-gate.mjs status`);
}

// ── status ────────────────────────────────────────────────────────────────────
function statusCmd() {
  const publicSha = git(target, ["rev-parse", "HEAD"]);
  const v = ciVerdict(publicSha);
  console.log(`闸分支:${gateBranch}`);
  console.log(`公开仓那笔:${publicSha.slice(0, 7)}`);
  console.log(`CI:${v.state} —— ${v.why}`);
  if (v.url) console.log(`     ${v.url}`);
  if (v.state === "green") console.log(`\n⇒ 可以落地:node scripts/branch-gate.mjs land`);
  if (v.state === "red") console.log(`\n⇒ 修完再 verify 一趟(闸分支会强推覆盖,那是设计内的)。`);
  process.exit(v.state === "green" ? 0 : 1);
}

// ── land ──────────────────────────────────────────────────────────────────────
function land() {
  // ①私有仓仍须干净:verify 之后又改了东西 ⇒ 落地的就不是验过的那棵树。
  const dirty = git(repoRoot, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty) die(`工作仓有未提交的改动 —— 验过的不是这棵树。要么提交后重跑 verify,要么先 stash:\n${dirty}`);

  // ②公开仓本地那笔必须还在,且**尚未**在 origin/main 上(否则这趟早就落过了)。
  const publicSha = git(target, ["rev-parse", "HEAD"]);
  console.log(`→ 问公开仓远端(代理 ${proxy})…`);
  try {
    gitProxy(target, ["fetch", "origin", "main", gateBranch]);
  } catch {
    die(`fetch 公开仓失败 —— 代理不通?或者闸分支 ${gateBranch} 不在远端(先跑 verify)。`);
  }
  const gateRemote = git(target, ["rev-parse", `origin/${gateBranch}`]);
  if (gateRemote !== publicSha) {
    die(
      `绑定对不上 —— 公开仓本地 HEAD 是 ${publicSha.slice(0, 7)},而闸分支上是 ${gateRemote.slice(0, 7)}。\n` +
        `  ⇒ 这两棵树不是同一棵。重跑一趟 verify。`,
    );
  }

  // ③CI 必须绿,且绿的是**这个 sha**。
  const v = ciVerdict(publicSha);
  if (v.state !== "green") {
    die(`CI 不是绿的:${v.state} —— ${v.why}${v.url ? `\n  ${v.url}` : ""}\n  ⛔ 闸不放行(这正是它存在的理由)。`);
  }
  console.log(`✅ CI 绿:${v.url}`);

  // ④私有仓不许落后(另一台推过) —— 落后就先 rebase,别在这里覆盖。
  console.log(`→ 问私有仓远端…`);
  git(repoRoot, ["fetch", "-q", "origin"]);
  const branch = git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const behind = git(repoRoot, ["rev-list", "--count", "HEAD..origin/master"]);
  if (behind !== "0") {
    die(
      `私有仓落后 origin/master ${behind} 笔 —— 另一台推过。\n` +
        `  ⇒ 先 \`git rebase origin/master\`,然后**重跑 verify**(树变了,旧的绿不算数)。`,
    );
  }

  // ⑤落地:公开 main(快进,同一笔提交)+ 私有 master。
  console.log(`→ 公开仓 main ← ${publicSha.slice(0, 7)}(同一笔提交,快进)…`);
  gitProxy(target, ["push", "origin", "HEAD:main"]);
  console.log(`→ 删掉闸分支 ${gateBranch} …`);
  try {
    gitProxy(target, ["push", "origin", "--delete", gateBranch]);
  } catch {
    console.log(`  ⚠ 闸分支没删掉(不致命,手动 \`git -C ${target} push origin --delete ${gateBranch}\`)。`);
  }

  if (branch !== "master") {
    console.log(`→ 私有仓 ${branch} → master(快进)…`);
    git(repoRoot, ["checkout", "-q", "master"]);
    try {
      git(repoRoot, ["merge", "--ff-only", branch]);
    } catch {
      git(repoRoot, ["checkout", "-q", branch]);
      die(`${branch} 不能快进合进 master —— 先 \`git rebase master\`,然后**重跑 verify**。`);
    }
  }
  git(repoRoot, ["push", "-q", "origin", "master"]);
  console.log(`\n✅ 落地完成。私有 master 与公开 main 都到 ${headSha}${branch !== "master" ? `(并已合掉 ${branch})` : ""}。`);
  console.log(`⭐ 这棵树的公开 CI 是绿的,而落上去的**就是被验的那一笔**。`);
}

// ── abandon ───────────────────────────────────────────────────────────────────
function abandon() {
  console.log(`→ 公开仓本地 main 退回 origin/main …`);
  gitProxy(target, ["fetch", "origin", "main"]);
  git(target, ["reset", "--hard", "origin/main"]);
  try {
    gitProxy(target, ["push", "origin", "--delete", gateBranch]);
    console.log(`→ 闸分支 ${gateBranch} 已删。`);
  } catch {
    console.log(`  ⚠ 闸分支 ${gateBranch} 没删掉(可能本来就不在)。`);
  }
  console.log(`\n✅ 已放弃这一趟。⛔ 私有仓一个字没动 —— 你的提交都还在。`);
}

const table = { verify, status: statusCmd, land, abandon };
if (!table[cmd]) {
  console.error("用法:node scripts/branch-gate.mjs verify|status|land|abandon");
  console.error("  verify   把这棵树推到公开仓闸分支,CI 跑起来");
  console.error("  status   问 CI 绿了没(三态:green / running / red / unknown)");
  console.error("  land     fail-closed:绿了才落地(公开 main + 私有 master)");
  console.error("  abandon  放弃这一趟,公开仓本地退回;私有仓不动");
  process.exit(1);
}
table[cmd]();

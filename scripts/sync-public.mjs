#!/usr/bin/env node
// 同步公开仓 = 导出 + 提交 + 推送,一条命令(448 立,ci-plan 阶段 2)。
//
// 用法:
//   node scripts/sync-public.mjs                 # 全套:导出 → 提交 → push
//   node scripts/sync-public.mjs --dry-run       # 到「要提交什么」为止,不 commit 不 push
//   node scripts/sync-public.mjs -m "同步 v0.2.36"
//   node scripts/sync-public.mjs --accept-exclusions   # 排除清单变了、确认过了,落新基线
//
// ⭐ **为什么值得有这一条命令**:§6 拍板 = per-push CI 跑在**公开仓**(免费无限、含 Windows
// 与 macOS runner)⇒「推公开仓」从**发版时才做一次**变成**每轮都做**。手抄那三条命令
// (导出 / add-commit / 带代理 push)每轮一遍,漏一步的方式还不少(忘了带代理会挂到超时、
// 忘了先看导出结果会把 fail-closed 的红当没看见)。
//
// ⛔ **三道 fail-closed,一道都别绕**:
//   ①**工作仓必须干净**(跟踪文件零改动)—— 导出拷的是**工作树**,带着未提交的改动推出去,
//     公开仓那棵树在私有仓里**找不到对应的提交**,以后对不上账;
//   ②**公开仓不许落后 / 分叉** —— 421 那一课:`git push` 被拒是双机并行下唯一会响的铃,
//     那就别等到 push 才响,开跑前先问一句;
//   ③**导出脚本非零退出即停**(内容红线 / 排除清单漂移)。
//
// ⚠ **提交说明刻意不抄工作仓的**:私有仓的 commit subject 里是轮次号、内部文档名、
//    backlog 条目号 —— 那些正是 161 定「白名单导出快照」时要挡在外面的东西,而**提交说明
//    不在内容红线的扫描面里**(那道只扫被导出的文件内容)。默认给一句中性的,要写别的用 `-m`。
//
// ⚠ **推公开仓 = 对外动作**:每轮推一次这件事本身已由用户 2026-08-19 拍板(ci-plan §6,
//    且 deploy §10 的原话本就是「发版同轮**或代码有值得公开的进展时**」);
//    ⛔ 但**打 tag 发版**是另一回事,不在本脚本里,照旧单独确认。
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const acceptExclusions = argv.includes("--accept-exclusions");
const msgIdx = argv.findIndex((a) => a === "-m" || a === "--message");
const customMsg = msgIdx >= 0 ? argv[msgIdx + 1] : null;
if (msgIdx >= 0 && !customMsg) die("`-m` 后面要跟一句提交说明。");
// ⭐ 分支闸用(`branch-gate.mjs`):**本地照旧在 main 上提交,只把这一笔推到另一条 ref**。
// 这样做的理由是绑定 —— CI 跑的那笔提交与日后落上 main 的那笔是**同一个 sha**,
// ⛔ 不是「再导出一次,希望它一样」(那属于 memory `verify-artifact-predates-fix` 那一族:
// 它失灵时不报错,只给一个看着合理的错答案)。
const toBranchIdx = argv.findIndex((a) => a === "--to-branch");
const toBranch = toBranchIdx >= 0 ? argv[toBranchIdx + 1] : null;
if (toBranchIdx >= 0 && !toBranch) die("`--to-branch` 后面要跟分支名。");
if (toBranch === "main") die("`--to-branch main` 就是默认行为,别绕这一圈。");
// ⚠ **`msgIdx < 0` 那一格 450 在 Linux 那台真撞上**:没给 `-m` 时 `msgIdx` 是 **-1**,
// 而下面原本写的是 `i !== msgIdx + 1` ⇒ `i !== 0` ⇒ **第 0 个位置参数(也就是目标目录)
// 被自己排除掉了**,于是 `node scripts/sync-public.mjs /exworkspace/zhujian` 静默退回默认路径,
// 报「公开仓工作副本不在 ../zhujian-public」。⛔ 那一条排除只在**真有 `-m`** 时才该生效。
// ⭐ 与 `export-public.mjs` 那道闸同族:**这两支至今只在一台机器上、只按默认路径跑过**。
// ⚠ 位置参数的挑法要把**所有**「跟在开关后面的值」排掉,不然 `--to-branch gate/x` 那个
// 分支名会被当成目标目录(与 `-m` 那条同一个坑,原注在下面几行)。
const valueIdxs = new Set([msgIdx + 1, toBranchIdx + 1].filter((i) => i > 0));
const target = resolve(
  argv.find((a, i) => !a.startsWith("-") && !valueIdxs.has(i)) ??
    join(repoRoot, "..", "zhujian-public"),
);
// 走代理(GitHub 直连不稳);要换端口设 ZJ_GIT_PROXY。
const proxy = process.env.ZJ_GIT_PROXY ?? "socks5h://127.0.0.1:10808";

function die(msg) {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}
function git(cwd, args, opts = {}) {
  return execFileSync("git", args, { cwd, encoding: "utf8", ...opts }).trim();
}

// ---- ① 工作仓必须干净(只看跟踪文件;`.zjshots/` 这类未跟踪的不算)----------------
const dirty = git(repoRoot, ["status", "--porcelain", "--untracked-files=no"]);
if (dirty) {
  console.error("工作仓有未提交的改动:");
  console.error(dirty);
  die("先提交(或 stash)。导出拷的是工作树 —— 带着未提交的改动推出去,公开仓那棵树在私有仓里找不到对应的提交。");
}
const headSha = git(repoRoot, ["rev-parse", "--short", "HEAD"]);

// ---- ② 公开仓不许落后 / 分叉 ------------------------------------------------------
if (!existsSync(join(target, ".git"))) die(`公开仓工作副本不在:${target}(它是独立 clone,不是本仓的子目录)`);
const branch = git(target, ["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch !== "main") die(`公开仓当前分支是 ${branch},不是 main —— 先切回去(公开仓的默认分支是 main,不是 master)。`);
console.log(`→ 问一下公开仓的远端(代理 ${proxy})…`);
try {
  git(target, ["-c", `http.proxy=${proxy}`, "fetch", "origin", "main"], { stdio: ["ignore", "pipe", "inherit"] });
} catch {
  die(`fetch 公开仓失败 —— 代理不通?(ZJ_GIT_PROXY 现在是 ${proxy})`);
}
const behind = git(target, ["rev-list", "--count", "HEAD..origin/main"]);
if (behind !== "0") {
  die(`公开仓本地落后远端 ${behind} 笔 —— 别人(或另一台机器)推过。先 \`git -C ${target} pull --ff-only\`,别在这里覆盖它。`);
}

// ---- ③ 导出(fail-closed:内容红线 / 排除清单漂移)--------------------------------
console.log(`→ 导出到 ${target} …\n`);
const exportArgs = ["scripts/export-public.mjs", target];
if (acceptExclusions) exportArgs.push("--accept-exclusions");
try {
  execFileSync(process.execPath, exportArgs, { cwd: repoRoot, stdio: "inherit" });
} catch {
  die("导出脚本非零退出(上面就是理由)—— 什么都没推。");
}

// ---- ④ 有没有要推的 --------------------------------------------------------------
git(target, ["add", "-A"]);
const staged = git(target, ["status", "--porcelain"]);
if (!staged) {
  console.log("\n✅ 公开仓与工作仓已经一致,没有要推的。");
  process.exit(0);
}
const stat = git(target, ["diff", "--cached", "--stat"]);
console.log(`\n要推的改动:\n${stat}`);

// 默认给中性的一句(理由见头注)。日期用工作仓 HEAD 那笔提交的日期,别用「现在」——
// 同一棵树重推两次该得同一句话。
const headDate = git(repoRoot, ["log", "-1", "--format=%cs"]);
const message = customMsg ?? `sync: ${headDate} (${headSha})`;
console.log(`\n提交说明:${message}`);

if (dryRun) {
  console.log("\n(--dry-run:到此为止,没有 commit、没有 push。改动已 `add -A` 暂存在公开仓里。)");
  process.exit(0);
}

// ---- ⑤ 提交 + 推 -----------------------------------------------------------------
git(target, ["commit", "-m", message]);
// ⛔ `--to-branch` 时**强推**那条闸分支:同一个题目重跑一趟很常见(改一行再验),
//    而闸分支是**一次性**的,没有任何人以它为基础工作 ⇒ 非快进是常态,不是事故。
//    ⚠ main 那条**绝不强推**,它的非快进正是规则 ② 要拦的东西。
const refspec = toBranch ? `HEAD:refs/heads/${toBranch}` : "main";
const pushArgs = ["-c", `http.proxy=${proxy}`, "push", ...(toBranch ? ["--force"] : []), "origin", refspec];
console.log(`→ push${toBranch ? ` → 闸分支 ${toBranch}(强推)` : ""} …`);
try {
  execFileSync("git", pushArgs, { cwd: target, stdio: "inherit" });
} catch {
  die(`push 失败 —— 提交已在公开仓本地(${git(target, ["rev-parse", "--short", "HEAD"])}),修好网络后 \`git -C ${target} -c http.proxy=${proxy} push origin ${refspec}\` 即可。`);
}
const pushedSha = git(target, ["rev-parse", "HEAD"]);
if (toBranch) {
  console.log(`\n✅ 已推到闸分支 \`${toBranch}\`(公开仓 sha ${pushedSha.slice(0, 7)})。`);
  console.log(`   CI 会在那条分支上跑(ci.yml 的 \`branches: ["gate/**"]\`,535 起从 ["**"] 收窄,per-push 那层已关掉)。`);
  console.log(`   ⛔ **本地 main 现在领先 origin/main 一笔,还没落地** —— 回来跑 \`branch-gate.mjs land\`。`);
} else {
  console.log(`\n✅ 已推到公开仓。CI:https://github.com/prehisle/zhujian/actions`);
}

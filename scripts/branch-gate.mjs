#!/usr/bin/env node
// 分支闸:动了产品面就送公开 CI 验,但落地不等裁决 —— 「先落地、红了再修」(541 用户拍板翻掉 520 的「绿了才落地」)。
// 形、判据、为什么不是 GitHub 的 PR 闸(要换成平台闸得先解决「required check 够不着另一个仓」那格)、退回同步闸的门:
// 全文在 dev-and-testing「分支闸」;判例 520 / 521 / 529 / 541 / 544。
//
//   node scripts/branch-gate.mjs gate      ⭐ 日常一条 = verify → land
//   node scripts/branch-gate.mjs verify    把当前这棵树推到公开仓的一条闸分支,CI 就跑起来
//   node scripts/branch-gate.mjs land      落地(私有 master + 公开 main);先本地跑十道静态门禁,⛔ 已知红拒、未出结论不等
//   node scripts/branch-gate.mjs status    问那棵树的 CI 结论
//   node scripts/branch-gate.mjs abandon   放弃这一趟,公开仓本地 main 退回 origin/main;私有仓不动
//   node scripts/branch-gate.mjs sweep     清掉**本环境**留下的孤儿闸分支
//
// 承重的两格,⛔ 一个字别动:
//   ① **绑定**:公开仓那份 clone 始终在 `main` 上提交,先推成闸分支,之后推上 main 的是**同一个 sha**
//      —— ⛔ 不是「合并后再导出一次,希望它一样」(memory `verify-artifact-predates-fix`:失灵时不报错,只给一个看着合理的错答案)。
//   ② **闸分支名 `gate/<环境名>/<短 sha>`**:sha 推导不存(私有 HEAD 一动就对不上 ⇒ fail-closed;状态文件会腐烂,推导不会,521);
//      环境名存在 `.git/config`(身份不是状态,529)—— 有了前缀 `sweep` 才够不着对端正在验的那笔。
// ⛔ 「不等」不是「无视」:land 那一刻 gh 已答 red 就拒;不等的只是还没出的结论。
// ⚠ 诚实边界:这是脚本闸不是平台闸(直接 `git push origin master` 绕得过);541 起红树进 master 的窗口 ≤ 一趟 CI,
//    兑现靠失败邮件 + 开工前 `gh run list` 那一眼(505)+ 当晚夜跑 —— 三样一样都别当成可省。

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_REPO, devEnv, listGateBranches, proxy } from "./lib/dev-env.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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

// 闸分支名 = 环境名 + 私有 HEAD 短 sha(承重格 ②)。⛔ sha 那半别改成随机名 / 时间戳(521);
// ⛔ 环境名那半别改成推导、也别改成「一台一条固定分支」(丢的是「验的是哪棵树」的绑定,529);
// ⭐ 分段用斜杠不用连字符:按前缀 `gate/<env>/` 匹配无歧义,连字符会让 `win` 误匹配 `gate/win-desk-…`(删错人的分支)。
const headSha = git(repoRoot, ["rev-parse", "--short", "HEAD"]);
let env;
try {
  env = devEnv(repoRoot);
} catch (e) {
  die(e.message);
}
const gateBranch = `gate/${env}/${headSha}`;

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

// ── 「这一轮有没有东西进公开仓」────────────────────────────────────────────────
// 纯文档轮次导不出任何东西(`docs/` / `CLAUDE.md` 不在导出白名单,451)⇒ 没有 CI 可跑,闸不能因此把人卡死(521 补第一版真卡住过)。
// ⚠ 判据靠解析 sync-public 那句话,两句都没匹配上就 fail-closed,⛔ 别兜底成「那就当它没东西要推吧」—— 那会让一棵没验过的树从这个洞里落地。
function exportDelta() {
  let out;
  try {
    out = execFileSync(process.execPath, ["scripts/sync-public.mjs", "--dry-run"], {
      cwd: repoRoot, encoding: "utf8",
    });
  } catch (e) {
    return { state: "error", why: String(e.stdout || e.stderr || e.message).trim().slice(-400) };
  }
  if (out.includes("已经一致,没有要推的")) return { state: "none" };
  if (out.includes("要推的改动:")) return { state: "some" };
  return { state: "unknown", why: out.trim().slice(-400) };
}

// ── sweep(529 立,治测试与工装 43):清掉**我这个环境**留下的孤儿闸分支 ──────────
// 闸分支名由 HEAD 推导 ⇒ 一轮里 amend / rebase 后再 verify 推的是新分支,旧那条成孤儿、它那趟 CI 还在烧(522)。
// 判据只问「是不是我这个环境推的、且不是当前这条」,不问「是不是同一轮」(amend 后旧 sha 不再是祖先,`merge-base` 答不出;529)。
// ⛔ 顺序:先 cancel,后删分支 —— 「`gh run cancel` 对分支已删的那趟还灵不灵」没验过,排到根本不需要问的位置。
// ⚠ 老形 `gate/<sha>`(529 前推的)一律不碰:认不出是谁的。
// cancelRuns:`sweep` 与 `abandon` 共用(收纳格 51(a);此前 abandon 光删分支、run 照烧,522)。
// ⚠ `head_sha` 过滤器要完整 40 位 —— 短 sha 会**安静地返回空表**(534 实测对拍),⛔ 别在这儿截短,调用处一律传 `ls-remote` 读回的完整 sha。
// 返回取消掉几趟;问不到 / 取消不了答 null(不致命,调用方照旧往下走)。
function cancelRuns(sha, tag) {
  try {
    const raw = execFileSync(
      "gh",
      ["api", `repos/${PUBLIC_REPO}/actions/runs?head_sha=${sha}&per_page=50`,
       "--jq", ".workflow_runs[] | select(.status != \"completed\") | .id"],
      { encoding: "utf8" },
    ).trim();
    const ids = raw.split("\n").filter(Boolean);
    for (const id of ids) {
      execFileSync("gh", ["run", "cancel", id, "-R", PUBLIC_REPO], { stdio: "ignore" });
      console.log(`   · ${tag}  取消了还在跑的 run ${id}`);
    }
    return ids.length;
  } catch {
    console.log(`   · ${tag}  ⚠ 问不到/取消不了它的 run(不致命,继续)`);
    return null;
  }
}

function sweep({ quiet = false } = {}) {
  let branches;
  try {
    branches = listGateBranches();
  } catch (e) {
    console.log(`  ⚠ 问不到公开仓的闸分支,这次没清:${String(e.stderr || e.message).trim().slice(0, 150)}`);
    return;
  }
  const mine = branches.filter((b) => b.env === env && b.ref !== gateBranch);
  // ⚠ 剩下的分两种,**别混成一句**:认得出是别的环境的 / 老形认不出是谁的。
  //    两种都不碰,但**理由不一样** —— 说成「别的环境的」会让人以为对端正在验一笔,
  //    而它可能就是自己上一轮留下的老形分支(529 自己第一次跑就撞见这一格)。
  const others = branches.filter((b) => b.env && b.env !== env);
  const legacy = branches.filter((b) => !b.env);
  const note = () => {
    if (others.length) console.log(`   (另有 ${others.length} 条**别的环境**的:${others.map((b) => b.ref).join(" / ")} —— ⛔ 不碰)`);
    if (legacy.length) console.log(`   (另有 ${legacy.length} 条**老形 \`gate/<sha>\`**、认不出是谁推的:${legacy.map((b) => b.ref).join(" / ")} —— ⛔ 不碰,手动处置)`);
  };
  if (!mine.length) {
    if (!quiet) console.log(`✅ 没有 ${env} 的孤儿闸分支要清。`);
    note();
    return;
  }
  console.log(`\n→ 清掉 ${mine.length} 条 ${env} 的孤儿闸分支(⛔ 只碰自己这个前缀下的):`);
  for (const b of mine) {
    // ① 先取消还在跑的那趟 —— 贵的是这个(runner 分钟数),不是分支本身。
    cancelRuns(b.sha, b.ref);
    // ② 再删分支。
    try {
      gitProxy(target, ["push", "origin", "--delete", b.ref]);
      console.log(`   · ${b.ref}  已删`);
    } catch {
      console.log(`   · ${b.ref}  ⚠ 没删掉(手动:git -C ${target} push origin --delete ${b.ref})`);
    }
  }
  note();
}

// ── 「这一轮要不要走闸」(535 立;用户 2026-08-29 点名 CI 太影响效率,数据与取舍在 progress-log 535)──
// 判据不是「碰了哪个目录」,是「只有 CI 答得出的是什么」:十道门禁本机 3 秒、六套 cargo 本机按 crate 跑得了,
// 只有跨平台那半(cfg 分支 / 平台 API 语义,425)与 Linux e2e(没有一台开发机跑得了)非 CI 不可 ⇒ 产品面与测试面那几个目录。
// `scripts/` 与 `docs/` 不在内。
// ⚠ 诚实边界:①改坏一支门禁脚本当轮没有机器会说话,靠既有纪律 + 夜跑兜底;②`sync-public` / `export-public` 改坏导出当场就响,故不列;
//   ③这份清单是白名单式的反面 —— 漏列一个真产品目录 = 那类改动从此不走闸,⛔ 新增一只 crate / 一棵前端树时必须回来加一行(同 `export-public.mjs` 的 ALLOW)。
const GATED_PATHS = [
  "core/", "src/", "e2e/", "src-tauri/", "mobile/", "sync-proto/", "server/",
  "android/src/", "android/src-tauri/", "ohos/", "index.html", "notebook.html",
  // 544 补:与 `android/src/` 同一棵前端树,此前漏列(543 只改它就没走闸)。
  "android/index.html",
  // ⭐ `.github/` 在里头不是因为它是产品面:改了 CI 自己的定义,就该让 CI 当场证明它还会跑 ——
  //    触发条件写错的失灵方式是**安静地不跑**(448 第一版把 `branches` 写成 `tags-ignore`,run 一趟都没建),
  //    唯一能证伪它的动作是真推一条闸分支。
  ".github/",
];

/**
 * 本地 HEAD 相对 `origin/master` 动过、且落在 `GATED_PATHS` 里的路径。
 * ⛔ fail-closed:`git diff` 问不出来就当**要走闸**(宁可多走一趟,也别安静地跳过)。
 */
function gatedDelta() {
  let out;
  try {
    out = git(repoRoot, ["diff", "--name-only", "origin/master...HEAD"]);
  } catch (e) {
    console.log(`  ⚠ 问不出改动面(${String(e.message).trim().slice(0, 120)})—— fail-closed,当作动了产品面。`);
    return ["<问不出来>"];
  }
  const files = out.split("\n").filter(Boolean);
  return files.filter((f) => GATED_PATHS.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p)));
}

// ── 「这一轮是不是纯版本号 bump」(541 立,测试与工装 56)─────────────────────
// bump 那笔恒命中 `src-tauri/` 与 `android/src-tauri/`,白烧一趟 CI(539);那棵树 = 上一棵 + 版本串,发版的安全判据在 release 线的 preflight。
// 判定是内容级的:①动过的 gated 文件 ⊆ 下面这张实测白名单(539/491 两笔 bump 逐字相同);②那几个文件 diff 里每条 +/- 行都是版本串行。
// ⛔ fail-closed 的方向:判不准 ⇒ 照常走闸(代价只是多一趟不等的警报 CI);要防的是判宽了把真代码放进免闸路,
//   所以 ② 对 lock 也**按整行**核 —— 按「含不含那个串」核会被 `pkg-config` 恰好同版本那种行骗过(539)。
const BUMP_FILES = new Set([
  "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock",
  "android/src-tauri/tauri.conf.json", "android/src-tauri/Cargo.toml", "android/src-tauri/Cargo.lock",
]);
const BUMP_LINE = /^[+-]\s*(?:"version":\s*"\d+\.\d+\.\d+",?|version\s*=\s*"\d+\.\d+\.\d+")\s*$/;

function versionBumpOnly(gatedFiles) {
  if (!gatedFiles.length || !gatedFiles.every((f) => BUMP_FILES.has(f))) return false;
  let diff;
  try {
    diff = git(repoRoot, ["diff", "-U0", "origin/master...HEAD", "--", ...gatedFiles]);
  } catch {
    return false; // 问不出 diff ⇒ 当不是纯 bump,照常走闸(fail-closed 的便宜方向)。
  }
  const changed = diff.split("\n").filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
  return changed.length > 0 && changed.every((l) => BUMP_LINE.test(l));
}

// ── 「私有仓落后了吗」(测试与工装 46;527 实撞)────────────────────────────
// ⛔ 承重的不只是这道检查,还有它的位置:**这条路上任何一次远端写之前**。527 排在最后,推上公开 main 的是一棵没有对端 526 的导出,
//   之后半小时里 CI 验的都是少一笔的树(私有仓没坏,坏的是公开快照)。今天它叫三次:verify 导出前 / land 问闸分支前 /
//   landPrivateOnly 第二道(只兜前一次检查到推上去之间那几秒;救不了已推出去的公开 main,留着因为免费)。
// ⛔ 别顺手改成「落后就自动 rebase」:rebase 会冲突(527 那次 progress-log 就冲突了),工装不该替人解冲突。
function assertNotBehind() {
  // ⛔ fetch 失败就停:拿过期的远端状态算出来的「没落后」错得很安静(同 claim-entry 取号那格)。
  try {
    git(repoRoot, ["fetch", "-q", "origin"], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    die(
      `问不到私有仓远端(git fetch 失败)—— fail-closed,⛔ 不猜「大概没落后吧」:\n` +
        `  ${String(e.stderr || e.message).trim().slice(0, 200)}`,
    );
  }
  const behind = git(repoRoot, ["rev-list", "--count", "HEAD..origin/master"]);
  if (behind !== "0") {
    die(
      `私有仓落后 origin/master ${behind} 笔 —— 另一个环境推过。\n` +
        `  ⇒ 先 \`git rebase origin/master\`,然后**重跑 verify**(树变了,旧的绿不算数)。`,
    );
  }
}

// ── 「公开仓本地 main 上有没有悬着的导出」(536 立,测试与工装 52;534 实撞)────────
// 洞的形:verify 在公开仓本地 main 上多一笔导出 → 私有 HEAD 一动闸分支名跟着变 → `exportDelta()` 比的是「导出 vs 本地 main」恒答「一致」
//   → land 走「无导出面」那条路核的是对端那笔的 CI、只推私有 master ⇒ 一棵含新代码的树落地而它自己的 CI 一次没被问过。
// ⭐ 修法是 fail-closed 前置,⛔ 不是把 `exportDelta()` 改成跟 origin/main 比 —— 那只修一句答案,悬着的那笔仍躺在本地 main 上,
//   下一趟 535 那条「不走闸直接推公开 main」的路照样把它推上去。它宁可停也不猜(同 46)。
// ⛔ 「本地 main 领先」本身不是错误态(verify 之后本来就该领先);要分的是「绑在当前这棵树的闸分支上」(正常)/「对不上」(拦)。
/**
 * @returns {{state:"even"|"bound", ahead:number, sha:string}} —— 另两种(落后 / 悬空)当场 die
 */
// ⚠ 数不出来就停：`Number("")` 是 **0**，而 0 恰好等于「没落后 / 没领先」
//   ⇒ 它会把一个问不出来的状态安静地翻成「一切正常」。⛔ 同本文件里每一处 fail-closed。
function count(cwd, range) {
  const raw = git(cwd, ["rev-list", "--count", range]);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    die(`数不出这个区间有几笔(${range})—— git 答的是「${raw}」,fail-closed。`);
  }
  return n;
}

function assertPublicMainBound() {
  // ⛔ 这道绑定的根是「公开仓那份 clone 始终在 main 上提交」(见文件头「承重的那一格」)
  //    ⇒ 不在 main 上时下面每一句都在算别的东西,先停。
  const branch = git(target, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== "main") {
    die(`公开仓那份 clone 当前在 ${branch},不是 main —— 承重的绑定就是「始终在 main 上提交」。\n` +
        `  ⇒ 先 \`git -C ${target} checkout main\`。`);
  }
  // ⛔ fetch 失败就停:拿过期的远端状态算出来的「没悬着」错得很安静(同 assertNotBehind)。
  try {
    gitProxy(target, ["fetch", "origin", "main"]);
  } catch (e) {
    die(`问不到公开仓远端(fetch 失败)—— fail-closed,⛔ 不猜「大概没悬着吧」:\n` +
        `  ${String(e.stderr || e.message).trim().slice(0, 200)}`);
  }
  // ⚠ 落后这一格 `sync-public.mjs` 的规则 ② 本来就会拒,**这里只是把它前移** ——
  //    别等到远端写那一步才响(46 那一课);而且从那边冒出来的是「问不出导出面(error)」,
  //    看不出真正发生了什么。
  const behind = count(target, "HEAD..origin/main");
  if (behind > 0) {
    die(`公开仓本地 main 落后 origin/main ${behind} 笔 —— 对端推过。\n` +
        `  ⇒ 先 \`git -C ${target} pull --ff-only\`(⚠ 若同时还领先,那就是分叉:先跑 \`abandon\`)。`);
  }
  const localHead = git(target, ["rev-parse", "HEAD"]);
  const ahead = count(target, "origin/main..HEAD");
  if (ahead === 0) return { state: "even", ahead, sha: localHead };

  // 领先 ⇒ 只剩一问:领先的那几笔,是不是**这一轮** verify 推上闸分支的那一笔。
  let branches;
  try {
    branches = listGateBranches();
  } catch (e) {
    die(`公开仓本地 main 领先 ${ahead} 笔,而**问不到远端的闸分支** —— fail-closed,⛔ 不猜它绑没绑上:\n` +
        `  ${String(e.stderr || e.message).trim().slice(0, 200)}`);
  }
  const mine = branches.find((b) => b.ref === gateBranch);
  if (mine && mine.sha === localHead) return { state: "bound", ahead, sha: localHead };

  const what = mine
    ? `闸分支 \`${gateBranch}\` 在远端,但它指向 ${mine.sha.slice(0, 7)},而公开仓本地 main 是 ${localHead.slice(0, 7)}`
    : `远端**没有** \`${gateBranch}\` 这条闸分支`;
  die(
    `公开仓本地 main 领先 origin/main ${ahead} 笔,而${what}。\n` +
      `  ⇒ **那几笔导出是悬着的:没有任何一趟 CI 在验它**,而下一句判断会被它带偏\n` +
      `     (534 实撞的那个洞 —— \`exportDelta()\` 会因此恒答「一致」;backlog 测试与工装 52)。\n` +
      `  两种来路,处置一样:\n` +
      `    ①上一趟 \`verify\` 之后又 amend / 补了一笔 ⇒ 闸分支名跟着变,旧那条成了孤儿;\n` +
      `    ②上一趟 \`verify\` 的 push 没推成(网络)。\n` +
      `  ⇒ \`node scripts/branch-gate.mjs abandon\`(公开仓本地退回 origin/main,⛔ 私有仓一个字不动),\n` +
      `     然后重跑 \`verify\`。`,
  );
}

// ── 本地十道静态门禁(544 立)────────────────────────────────────────────────
// 「改了哪道门禁就跑那道」只是印出来的提醒,失守过两次(512 一道在干净树上红了十一天;544 前一轮改了 android/index.html 没跑 CSS 那几道)
// ⇒ 十道全跑只要几秒,接到 land 这个自动边界上(385:加新检查前先问已有的接上没)。
// ⚠ 诚实边界:①只有这十道 —— 「非发版门禁」那族(要 Chrome / 样本冻结的)不在内,512 那支恰属后者,仍靠既有纪律 + 夜跑;
//   ②清单与 preflight.yml 那十道同口径(以 dev-and-testing「命令、测试计数与门禁速记」为准),两处要同改;③红了拒 land,没有「不等」可言。
const LOCAL_GATES = [
  "lock-drift", "theme-drift", "contrast", "hardcoded-colors", "timing-drift",
  "radius-drift", "fs-drift", "filter-parity", "hit-zone", "i18n-drift",
];

// ── CLAUDE.md 字节闸(586 立)──────────────────────────────────────────────
// CLAUDE.md 每个会话整份进系统提示,四次瘦身四次长回(根因与量法在 progress-log 586);接到 land 上:超了拒落地。
// ⛔ 不是新开门禁(停止扩张线):没有 parser / 登记表 / 阴性刀,就一个数。预算 12 KB = ≈ 2.7 B/token × 目标 4k token + 1 KB 指针余量。
// ⚠ 诚实边界:①只证明文件变小,证明不了启动上下文变小(挪进无 `paths:` 的 rules 或 `@import` 照样绿;判据 = 干净新会话看 `/context`,测试与工装 72);
//   ②只核仓内这一份;本机 MEMORY.md 是各环境私有面,走 `scripts/check-memory-index-budget.mjs`(SessionStart hook),不进这儿。
const CLAUDE_MD_BUDGET = 12 * 1024;
function assertClaudeMdBudget() {
  const size = statSync(join(repoRoot, "CLAUDE.md")).size;
  if (size <= CLAUDE_MD_BUDGET) return;
  die(
    `CLAUDE.md 已 ${(size / 1024).toFixed(1)} KB,超过预算 ${CLAUDE_MD_BUDGET / 1024} KB —— ⛔ 不落地。\n` +
      `  它每个会话整份进上下文。规矩(CLAUDE.md 末节):本文件只改指针与一行状态短语;\n` +
      `  当前态 → docs/handoff.md,每轮事实 → progress-log,操作与坑 → dev-and-testing,代码地图 → architecture。`,
  );
}

// ── backlog 队列闸(586/1a 立)────────────────────────────────────────────────
// backlog 是「挑活只看这一份」,曾 19 天从 7.8 KB 长到 534 KB,大头是销号叙事与 `<details>` 里的立账原文;1a 把它们搬进
// backlog-archive(销号只留一行),这里把「别再长回去」接到 land 上。⛔ 不是新开门禁:两个数 + 一个字面量。
// 预算 240 KB = 拆完实测 193.4 KB + 24% 余量;⭐ 到顶的处置不是抬闸,是再归档一批(⚠ 别拿改造前的增速反推「够几轮」)。
// `<details>` 那格治的是另一件事:折叠块里的立账原文与真条目逐字同形,是「判活账别用 grep」那条纪律的根(458/464/560);
// 全搬走后 `grep "^~~"` 数销号、其余顶层条目头数活账才作准。⚠ 它只认队列里的**标签**,行文里反引号引用那个词不算(472)。
const BACKLOG_BUDGET = 240 * 1024;
function assertBacklogBudget() {
  const file = join(repoRoot, "docs/backlog.md");
  const size = statSync(file).size;
  if (size > BACKLOG_BUDGET) {
    die(
      `docs/backlog.md 已 ${(size / 1024).toFixed(1)} KB,超过预算 ${BACKLOG_BUDGET / 1024} KB —— ⛔ 不落地。\n` +
        `  它是「挑活只看这一份」。⇒ 把销号条目搬进 docs/backlog-archive.md(队列里留一行:\n` +
        `  标题 + 销于哪轮 + 归档锚),⛔ 别抬这个数。`,
    );
  }
  const text = readFileSync(file, "utf8").replace(/`[^`]*`/g, "");
  if (text.includes("<details")) {
    die(
      `docs/backlog.md 里又出现了 <details> —— ⛔ 不落地。\n` +
        `  折叠块里的立账原文与真条目逐字同形,grep "^~~" 会把它们一起捞出来(458/464/560 三次)。\n` +
        `  ⇒ 原文放 docs/backlog-archive.md,队列里留一行指过去。`,
    );
  }
  // 「门」槽(679 立,backlog 纪律 ⑧):「记账不做」之前每条零缩进活账的头行必须以六种槽之一
  // 开头,挑活才能只读头行(679 量过:读正文才知道门在谁手里那一趟 70 KB,头行合计 14 KB)。
  // 同一道闸里多一个正则,⛔ 不是新门禁;阴性刀在假 origin 沙箱 gate-sandbox-doc-gates.mjs 第 ④ 把。
  const SLOT = /^[0-9A-Za-z][^ .]*\. 〔(可开工|等用户|要|门|顺路|备查)([::  ][^〕]{1,40})?〕 /;
  const raw = readFileSync(file, "utf8").split("\n");
  const stop = raw.findIndex((l) => l.startsWith("## ⛔ 记账不做"));
  const heads = raw.slice(0, stop < 0 ? raw.length : stop).filter((l) => /^[0-9A-Za-z][^ .]*\. /.test(l));
  const noSlot = heads.filter((l) => !SLOT.test(l));
  if (noSlot.length) {
    die(
      `docs/backlog.md 里有 ${noSlot.length} 条活账头行没开「门」槽(或槽不是六种之一)—— ⛔ 不落地:\n` +
        noSlot.slice(0, 5).map((l) => `    ${l.slice(0, 60)}…`).join("\n") +
        `\n  ⇒ 头行写成 NN. 〔可开工 | 等用户:… | 要 … | 门:… | 顺路:… | 备查〕 **标题**(backlog 纪律 ⑧)。`,
    );
  }
}

// ── 参考文档字节闸(测试与工装 85 ③ 立;一张表,加下一份就是加一行)──────────────
// dev-and-testing 曾 30 天从 48 KB 长到 218 KB 而没有边界看着它(同 CLAUDE.md / backlog 的病);85② 压完接到 land 上。
// ⛔ 不是新开门禁(停止扩张线):一张名字 → 字节数的表,阴性对照只一把、住在假 origin 沙箱里。
// 预算 = 压完实测 + 约 10% 余量(同 SKILL_BUDGETS 的形,⛔ 不是拍的数);⭐ 到顶的处置是再蒸馏一节,不是抬这个数。
// ⚠ 只证明文件变小;自动装载的 `.claude/rules/*.md` 另有账(backlog 测试与工装 86)。
const DOC_SIZE_BUDGETS = {
  "docs/dev-and-testing.md": 230 * 1024,
  // handoff 是接手的人每次通读的那份,自定「目标 ≤ 8 KB」却长到 23 KB 无人拦(测试与工装 95,679 堵上):
  // 债节一轮一行、约束节只留一句 + 指针,叙事各回 progress-log / deploy / skill —— 到顶的处置是再搬,不是抬闸。
  "docs/handoff.md": 8 * 1024,
};
function assertDocSizeBudgets() {
  const bad = [];
  for (const rel of Object.keys(DOC_SIZE_BUDGETS)) {
    const budget = DOC_SIZE_BUDGETS[rel];
    const size = statSync(join(repoRoot, rel)).size;
    if (size > budget) {
      bad.push(`    ${rel} 已 ${(size / 1024).toFixed(1)} KB,超过预算 ${(budget / 1024).toFixed(0)} KB`);
    }
  }
  if (!bad.length) return;
  die(
    `参考文档超预算 —— ⛔ 不落地:\n${bad.join("\n")}\n` +
      `  ⇒ 挑一节按「判例 → 规则 + progress-log 条目号」压掉(590 压 skill、85② 压这份的手法),\n` +
      `  叙事留在 progress-log 同号条目里。⛔ 别抬这个数。`,
  );
}

// ── skill 字节闸(586/1b 立)──────────────────────────────────────────────────
// 六份 SKILL.md 曾长到 213 KB(最大一份 ≈ 30k token);1b 压成「规则 + progress-log 条目号」+ `ls` 代花名册,这里把「别再长回去」接到 land 上。
// ⛔ 不是新开门禁(停止扩张线):一张名字 → 字节数的表。预算逐份 = 1b 拆完实测 + 8-10% 余量,⛔ 不给统一数(会让最小那份有 5 倍长空间)。
// ⚠ 新 skill 落 `DEFAULT`(12 KB):新写的就该是「步骤 + 最贵的几条坑」;真需要更大来表里加一行并写明凭什么,⛔ 别抬 DEFAULT。
// ⚠ 诚实边界:①只证明文件变小(skill 可 `@import` / 指向大文件);②`.claude/` 不进公开仓 ⇒ 只有本地 land 跑得到,CI 永远看不见。
// ⭐ 到顶的处置是再蒸馏一批,不是抬数。
const SKILL_BUDGETS = {
  "codex-review": 20 * 1024,
  "fake-origin-sandbox": 11 * 1024,
  "mutation-check": 29 * 1024,
  "run-ys-notebook": 23 * 1024,
  "zhujian-android-verify": 56 * 1024,
  "zhujian-ops": 33 * 1024,
};
const SKILL_BUDGET_DEFAULT = 12 * 1024;
function assertSkillBudgets() {
  const dir = join(repoRoot, ".claude/skills");
  if (!existsSync(dir)) return;
  const bad = [];
  for (const name of readdirSync(dir)) {
    const file = join(dir, name, "SKILL.md");
    if (!existsSync(file)) continue;
    const size = statSync(file).size;
    const budget = SKILL_BUDGETS[name] ?? SKILL_BUDGET_DEFAULT;
    if (size > budget) {
      bad.push(
        `    .claude/skills/${name}/SKILL.md 已 ${(size / 1024).toFixed(1)} KB,` +
          `超过预算 ${(budget / 1024).toFixed(0)} KB` +
          (SKILL_BUDGETS[name] ? "" : "(未登记,走 DEFAULT)"),
      );
    }
  }
  if (!bad.length) return;
  die(
    `skill 超预算 —— ⛔ 不落地:\n${bad.join("\n")}\n` +
      `  skill 是「用之前要整份读」的文件。⇒ 判例叙事压成一行规则 + progress-log 条目号;\n` +
      `  会腐烂的花名册换成一句 \`ls\`;历史快照删掉。⛔ 别抬这个数(到顶 = 再蒸馏一批)。`,
  );
}

// ── 文档新增行的长度闸(586/1a 立)────────────────────────────────────────────
// 同一族的另一个症状:一行写到几千字,grep 是一堵墙、diff 整行全红。只管**本轮新增的行**,存量那批是史料,⛔ 别在这道闸里顺手重排。
// ⚠ 判据是字符数不是字节;只看 `origin/master...HEAD` 的加行(本地 ref,不用网络;没有就 die)。
const LONG_LINE_MAX = 1500;
const LONG_LINE_PATHS = ["CLAUDE.md", "docs/", ".claude/rules/"];
function assertNoLongDocLines() {
  let diff;
  try {
    diff = git(repoRoot, ["diff", "-U0", "origin/master...HEAD", "--", ...LONG_LINE_PATHS]);
  } catch (e) {
    die(`问不出 origin/master...HEAD 的文档 diff(${String(e.message).trim().slice(0, 120)})—— ⛔ 不落地。`);
  }
  let file = "";
  const bad = [];
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++ b/")) { file = l.slice(6); continue; }
    if (!l.startsWith("+") || l.startsWith("+++")) continue;
    const len = l.length - 1;
    if (len > LONG_LINE_MAX) bad.push(`${file}:${len} 字符 —— ${l.slice(1, 60)}…`);
  }
  if (!bad.length) return;
  die(
    `本轮往文档里新写了 ${bad.length} 行超过 ${LONG_LINE_MAX} 字符的 —— ⛔ 不落地:\n` +
      bad.slice(0, 5).map((b) => `    ${b}`).join("\n") +
      `\n  ⇒ 折行(中文文档一行 80-100 字),或者把那段该进 progress-log / 归档的搬走。`,
  );
}

function runLocalGates() {
  assertClaudeMdBudget();
  assertBacklogBudget();
  assertDocSizeBudgets();
  assertNoLongDocLines();
  assertSkillBudgets();
  console.log(`→ 本地十道静态门禁(几秒量级)…`);
  for (const g of LOCAL_GATES) {
    try {
      execFileSync(process.execPath, [`scripts/check-${g}.mjs`], {
        cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      const out = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim();
      die(
        `门禁 check-${g} 红了 —— ⛔ 不落地(它是本机几秒就答得出的红,没有「不等」可言):\n\n` +
          `${out.slice(-1500)}\n\n  ⇒ 修绿(或按那道闸的说法登记签字)后重跑 land。`,
      );
    }
  }
  console.log(`  ✅ 十道全绿。`);
}

// ── 生成物与源是否还一致(576 之后立)──────────────────────────────────────────
// 576 起 `site-cool/` 整个是产物(真相源 = `site/index.html` + `store-assets/harmonyos/0{3,4,5}-*.md`;曾核的 `site-app-docs/`
// 备案后按 deploy §8.1a 撤了);`build-site-cool.mjs --check` 现成却没有任何自动边界跑它 ⇒ 接到这儿(385;⛔ 不是新开门禁)。
// ⚠ 诚实边界:①只能在本机跑 —— `site-cool/` 与那支脚本都在 `.export-excluded.json` 里,CI 永远看不见;
//   ②只核「产物 == 拿今天的源重新生成」,不核源本身;③不是十道静态门禁之一,preflight.yml 不必跟着改。
function runGeneratedArtifactChecks() {
  try {
    execFileSync(process.execPath, ["scripts/build-site-cool.mjs", "--check"], {
      cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim();
    die(
      `生成物与源不一致(site-cool)—— ⛔ 不落地:\n\n${out.slice(-1200)}\n\n` +
        `  ⇒ 跑 \`node scripts/build-site-cool.mjs\` 重新生成(⛔ 别手改 site-cool/ 里的 HTML),再重跑 land。`,
    );
  }
  console.log(`  ✅ 生成物(site-cool)与源一致。`);
}

// ── 导出树上再跑一遍那十道(测试与工装 69 立;577 实撞)────────────────────
// `runLocalGates()` 跑的是工作树,CI 跑的是导出之后那棵;凡判据与「仓里有哪些文件」有关的闸(`lib/css-docs.mjs` 的 DOCS、
// `git ls-files` 那几道)两棵树答案本来就不同 —— 577 本机十道全绿,推上去当趟 CI 那格 ENOENT 硬崩(run 33728218326)。
// ⇒ 任何一次推之前,拿导出树那份脚本再跑同样的十道。
// ⭐ 跑的必须是 `<导出树>/scripts/check-*.mjs`:那几支的扫描根从脚本自己所在位置推出来,拿工作仓那份换 cwd 答的还是同一棵树,⛔ 别改成「换 cwd」。
// ⚠ `check-filter-parity` 是十道里唯一有 npm 依赖的(esbuild),公开仓 clone 没有 `node_modules`(在它的 `.gitignore` 里;导出时的 `rmSync`
//   删的是链接本身、指向的目录不动)⇒ 每趟按需重建一条指向工作仓的链接,不是「要人记得先装一次」的前置。
// ⚠ 只答「十道在那棵树上绿不绿」,答不了 CI 上另外那几格(cargo / e2e 的输入不因导出而变)。
let ranExportGates = false;
function ensureExportTreeNodeModules() {
  const nm = join(target, "node_modules");
  if (existsSync(nm)) return; // 真装了、或上一趟留下的链接还好使
  // 走到这儿要么没有,要么是断链残骸(工作仓搬过家)—— 后者 `existsSync` 答 false 而 `symlink` 会 EEXIST。
  try {
    rmSync(nm, { recursive: true, force: true });
  } catch {
    /* 删不掉就让下面那句原样报出来 */
  }
  const src = join(repoRoot, "node_modules");
  if (!existsSync(src)) {
    die(`工作仓没有 \`node_modules\` —— 导出树上那道 check-filter-parity 要 esbuild。先 \`npm i\`。`);
  }
  try {
    symlinkSync(src, nm, "junction");
  } catch (e) {
    die(
      `给导出树补 node_modules 链接失败(${String(e.message).trim().slice(0, 160)})。\n` +
        `  ⇒ 手动:在 ${target} 里建一条指向 ${src} 的目录链接(Windows \`mklink /J\`),或直接 \`npm i\`。`,
    );
  }
}
function runGatesOnExportedTree(what) {
  if (ranExportGates) return;
  ranExportGates = true;
  ensureExportTreeNodeModules();
  console.log(`→ **导出树**上再跑一遍那十道(${what})…`);
  for (const g of LOCAL_GATES) {
    try {
      execFileSync(process.execPath, [join(target, "scripts", `check-${g}.mjs`)], {
        cwd: target, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      const out = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim();
      die(
        `门禁 check-${g} 在**导出树**上红了 —— ⛔ 什么都没推(69;577 那趟 CI 红的就是这一格):\n\n` +
          `${out.slice(-1500)}\n\n` +
          `  ⚠ **本机工作树上它是绿的** ⇒ 差别来自「这棵树上有哪些文件」:\n` +
          `     公开快照是白名单导出的,\`.export-excluded.json\` 里那些文件在那边**根本不存在**。\n` +
          `  ⇒ 要么把那份文件加进导出白名单(\`export-public.mjs\` 的 ALLOW),\n` +
          `     要么在闸的登记表里把它标成「只在工作仓里有」(见 scripts/lib/css-docs.mjs 的 privateOnly)。`,
      );
    }
  }
  console.log(`  ✅ 导出树上十道也全绿。`);
}

// ── verify ────────────────────────────────────────────────────────────────────
function verify() {
  const dirty = git(repoRoot, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty) die(`工作仓有未提交的改动 —— 闸绑的是「哪一笔提交」,先提交:\n${dirty}`);

  // ⛔ **落后就直接拒**(backlog 46 的第二半)——⛔ 别兜底成「先验着,land 再说」:
  //    land 那道拒绝在**收口**才说话,那时 29 分钟已经烧掉了。
  assertNotBehind();

  // ⭐ **536:悬着的导出要在任何一句判断之前拦下** —— 它会把下面 `exportDelta()` 那一问答坏
  //    (534 那个洞;判据与两种领先的分法焊在 `assertPublicMainBound()` 头上)。
  const pub = assertPublicMainBound();
  if (pub.state === "bound") {
    console.log(`⚠ **这棵树已经在闸上了** —— \`${gateBranch}\` 指向公开仓 ${pub.sha.slice(0, 7)},与本地 main 同一笔。`);
    console.log(`   ⇒ 去问结论:node scripts/branch-gate.mjs status`);
    console.log(`   ⛔ 想再跑一趟 CI 排抖动**别重跑 verify**(那只会原样强推一次同样的树),`);
    console.log(`      用 \`gh run rerun <id> -R ${PUBLIC_REPO}\` —— \`ciVerdict\` 那句「只要有一趟绿就算绿」正是为它写的。`);
    // ⚠ 别把原来那一下漏了：此前第二趟 `verify` 推完是会顺手 sweep 一次的。
    sweep({ quiet: true });
    return;
  }

  // ⭐ 535:没动那几面就不走闸(判据与诚实边界在 `gatedDelta()` 头上)。⛔ 别读成「跳过验证」:十道门禁与 cargo 本机跑得了
  //    (而且本来就该跑)、夜跑每天一趟兜底、真想立刻要一趟 ⇒ `gh workflow run ci.yml`。
  const pd = gatedDelta();
  if (!pd.length) {
    console.log(`⚠ **这一轮没动要走闸的那几面** ⇒ 不走闸(535 起的形)。`);
    console.log(`   本地该跑的别省:改了哪道门禁/它扫的那份东西就跑那道、动了哪只 crate 就跑它。`);
    console.log(`   ⇒ 直接 \`node scripts/branch-gate.mjs land\`,它会导出 + 推公开 main + 推私有 master。`);
    return;
  }
  // ⭐ 541:纯版本号 bump 轮不为它烧一趟 CI(判据与 fail-closed 方向在 versionBumpOnly 头上)。
  if (versionBumpOnly(pd)) {
    console.log(`⚠ **走闸的面只有版本号 bump**(${pd.join(" / ")},且 diff 逐行都是版本串)⇒ 不走闸(541 起)。`);
    console.log(`   发版的安全判据在 release 线的 preflight(打 tag 全跑、fail-closed),这里省的只是一趟警报。`);
    console.log(`   ⇒ 直接 \`node scripts/branch-gate.mjs land\`。`);
    return;
  }
  console.log(`本轮动了要走闸的面 ${pd.length} 处(${pd.slice(0, 4).join(" / ")}${pd.length > 4 ? " …" : ""})⇒ 走闸。\n`);

  // ⛔⛔ 这一问必须排在 sync 之前(521 补二):放在后面,东西已被 sync 提交掉,它恒答「没有」——
  //    一句与事实相反的收尾话正是最该修的那类,下一个人会照它办事。
  const d = exportDelta();
  if (d.state === "none") {
    console.log(`⚠ **这一轮没有任何东西进公开仓**(纯文档 / 全在导出排除单里)⇒ 没有 CI 可跑。`);
    console.log(`   ⇒ 直接 \`land\` 即可,它会走「无导出面」那条路:核公开仓 main 当前那笔的 CI`);
    console.log(`     仍是绿的(代码面一个字没动),然后只推私有 master。`);
    return;
  }
  if (d.state !== "some") {
    die(`问不出「这一轮有没有东西要进公开仓」(${d.state})—— fail-closed,⛔ 不猜。\n  ${d.why ?? ""}`);
  }

  // ⭐ 69:`exportDelta()` 那趟 `--dry-run` 已经把导出树铺进 target 了 ⇒ 这一刻问「那棵树上十道绿不绿」最省。
  //    ⛔ 别挪到 push 之后:577 那趟红的代价是一趟 CI + 一封要人回头看的失败邮件。
  runGatesOnExportedTree("闸分支要推的就是这棵");

  console.log(`本轮闸分支:${gateBranch}(私有 HEAD ${headSha})\n`);
  try {
    execFileSync(process.execPath, ["scripts/sync-public.mjs", "--to-branch", gateBranch], {
      cwd: repoRoot, stdio: "inherit",
    });
  } catch {
    die("sync-public 非零退出(上面就是理由)—— 什么都没推。");
  }
  // ⭐ 推完再清 —— 当前这条已经在远端了,`sweep` 按名字把它排掉,剩下的就都是孤儿。
  sweep({ quiet: true });

  console.log(`\n⭐ CI 跑起来了(警报,541 起**不必等它**)。接着就落地:`);
  console.log(`   node scripts/branch-gate.mjs land`);
  console.log(`   (它红了会发失败邮件;想看结论:node scripts/branch-gate.mjs status)`);
}

// ── status ────────────────────────────────────────────────────────────────────
function statusCmd() {
  const publicSha = git(target, ["rev-parse", "HEAD"]);
  const v = ciVerdict(publicSha);
  console.log(`闸分支:${gateBranch}`);
  console.log(`公开仓那笔:${publicSha.slice(0, 7)}`);
  console.log(`CI:${v.state} —— ${v.why}`);
  if (v.url) console.log(`     ${v.url}`);
  if (v.state === "red") console.log(`\n⇒ **修**(「先落地、红了再修」的后半句就是这儿)。已 land 的话修完走正常轮次;`);
  if (v.state === "red") console.log(`   还没 land 的话修完重跑 verify(闸分支会强推覆盖,那是设计内的)。`);
  if (v.state !== "red") console.log(`\n(541 起 land 不等这个结论 —— 这条命令是给「红了要修」和「想安心」用的。)`);
  process.exit(v.state === "green" ? 0 : 1);
}

// ── land ──────────────────────────────────────────────────────────────────────
function land() {
  // ①私有仓仍须干净:verify 之后又改了东西 ⇒ 落地的就不是验过的那棵树。
  const dirty = git(repoRoot, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty) die(`工作仓有未提交的改动 —— 验过的不是这棵树。要么提交后重跑 verify,要么先 stash:\n${dirty}`);

  // ①b ⭐ 544:十道静态门禁本地全跑,红了拒(排在任何一次远端写之前;理由在 runLocalGates 头上)。
  runLocalGates();
  runGeneratedArtifactChecks();

  // ②⛔ 落后检查排在任何一次远端写之前(46 的修法;理由在 assertNotBehind 头上)。
  assertNotBehind();

  // ③⭐ 536:同一道前置(判据在 `assertPublicMainBound()` 头上)。正常闸路走到这儿必然 `bound`;`even` = 这一轮没走闸
  //    (纯文档 / 535 那条路)。两种都放行,第三种在函数里当场停。
  const pub = assertPublicMainBound();

  // ③b ⭐ 69:`bound` ⇒ 公开仓本地 main 上躺着的就是要推上去的导出树 ⇒ 在那棵树上把十道再跑一遍。
  //    verify 那趟跑过同一棵,这里是**落地这个自动边界**上的那一次(verify 不是每轮都走,land 是)。
  if (pub.state === "bound") runGatesOnExportedTree("公开仓本地 main = 送验的那一笔");

  // ④⭐ 535:没动那几面 ⇒ 不走闸直接落地(判据在 `gatedDelta()` 头上);541 起纯版本号 bump 轮走同一条路(`versionBumpOnly()`)。
  //    ⚠ 与下面「纯文档轮」不是同一条路,别合并:那条压根没东西进公开仓 ⇒ 只推私有;这条有东西但不值得烧 CI ⇒ 照样推公开 main。
  //    ⛔ 别为了省事改成「也不推公开仓」:快照会一直落后,而夜跑验的正是它。
  const pd = gatedDelta();
  const bumpOnly = pd.length > 0 && versionBumpOnly(pd);
  if (!pd.length || bumpOnly) {
    const d0 = exportDelta();
    if (d0.state === "none") {
      console.log(`⚠ 这一轮**没动那几面、也没有东西进公开仓**(纯文档)⇒ 只推私有 master。`);
    } else if (d0.state === "some") {
      console.log(bumpOnly
        ? `⚠ 这一轮走闸的面**只有版本号 bump** ⇒ 不烧 CI,直接导出并推公开 main(541 起;发版判据在 release preflight)。`
        : `⚠ 这一轮**没动那几面** ⇒ 直接导出并推公开 main(535 起的形)。`);
      console.log(`   ⛔ 这不等于「验过了」:兑现物是**今晚那趟夜跑**(19:30Z),红了会发邮件。`);
      // ⭐ 69:这条路不走闸、没有 CI 的即时反馈,导出树上那十道只有夜跑会说话;`d0` 那趟 `--dry-run` 已把导出树铺好
      //    ⇒ 就在推之前跑掉它(这条路比闸那条更需要它)。
      runGatesOnExportedTree("这一轮要推上公开 main 的就是这棵");
      try {
        execFileSync(process.execPath, ["scripts/sync-public.mjs"], { cwd: repoRoot, stdio: "inherit" });
      } catch {
        die("sync-public 非零退出(上面就是理由)—— 公开仓没推成,私有仓也一个字没动。");
      }
    } else {
      die(`问不出「这一轮有没有东西要进公开仓」(${d0.state})—— fail-closed,⛔ 不猜。\n  ${d0.why ?? ""}`);
    }
    // ⭐ 顺手清掉本环境的孤儿闸分支(上一轮 amend/rebase 留下的);⛔ 只碰自己那个前缀。
    sweep({ quiet: true });
    landPrivateOnly();
    return;
  }

  // ⑤闸分支在不在?不在有两种可能,**必须分开处理**,别一律报「先跑 verify」。
  console.log(`→ 问公开仓远端(代理 ${proxy})…`);
  let gateExists = true;
  try {
    gitProxy(target, ["ls-remote", "--exit-code", "origin", `refs/heads/${gateBranch}`]);
  } catch {
    gateExists = false;
  }

  if (!gateExists) {
    // 可能①:这一轮压根没有东西进公开仓(纯文档轮)⇒ 代码面没动,main 上那笔的绿仍然作数。
    // 可能②:你真的忘了 verify ⇒ fail-closed。
    const d = exportDelta();
    if (d.state !== "none") {
      die(
        `闸分支 ${gateBranch} 不在远端,而这一轮**确实有东西要进公开仓**(${d.state}${d.why ? `:${d.why}` : ""})。\n` +
          `  ⇒ 先跑 \`node scripts/branch-gate.mjs verify\`。`,
      );
    }
    gitProxy(target, ["fetch", "origin", "main"]);
    const mainSha = git(target, ["rev-parse", "origin/main"]);
    // 541:与 ⑥ 同一把尺 —— **已知红才拒**(green / running / unknown 都放行)。
    // 这儿问的是 main 当前那笔 = 当前代码面:它红着就先修它,别往红树上继续摞。
    const v0 = ciVerdict(mainSha);
    if (v0.state === "red") {
      die(`公开仓 main 当前那笔(${mainSha.slice(0, 7)})的 CI **已经红了**:${v0.why}${v0.url ? `\n  ${v0.url}` : ""}\n  ⛔ 「先落地、红了再修」的「修」就是现在 —— 先把它修绿。`);
    }
    console.log(`⚠ 这一轮**没有东西进公开仓**(纯文档 / 全在排除单里)⇒ 代码面一个字没动。`);
    console.log(v0.state === "green"
      ? `✅ 公开 main ${mainSha.slice(0, 7)} 的 CI 是绿的:${v0.url}`
      : `⚠ 公开 main ${mainSha.slice(0, 7)} 的 CI 尚无结论(${v0.state})—— 541 起不等;红了会有邮件。`);
    landPrivateOnly();
    return;
  }

  const publicSha = git(target, ["rev-parse", "HEAD"]);
  gitProxy(target, ["fetch", "origin", "main", gateBranch]);
  const gateRemote = git(target, ["rev-parse", `origin/${gateBranch}`]);
  if (gateRemote !== publicSha) {
    die(
      `绑定对不上 —— 公开仓本地 HEAD 是 ${publicSha.slice(0, 7)},而闸分支上是 ${gateRemote.slice(0, 7)}。\n` +
        `  ⇒ 这两棵树不是同一棵。重跑一趟 verify。`,
    );
  }

  // ⑥ 541 起**不等裁决**(用户拍板「先落地、红了再修」;520 原形是「必须绿」)。
  //    ⛔ 但**已知红不落地** —— 这一刻 gh 已经答了 red,落下去就不是「不等」是「无视」。
  //    问的仍是**这个 sha**(绑定那格一个字没动);green / running / unknown 都放行。
  const v = ciVerdict(publicSha);
  if (v.state === "red") {
    die(`CI **已经红了**:${v.why}${v.url ? `\n  ${v.url}` : ""}\n  ⛔ 「不等裁决」不等于「无视已出的红」—— 修完重跑 verify 再来。`);
  }
  console.log(v.state === "green"
    ? `✅ CI 绿:${v.url}`
    : `⚠ CI 尚无结论(${v.state}${v.url ? `,${v.url}` : ""})—— 541 起不等;红了会发失败邮件 + 开工前那一眼(505)+ 今晚夜跑兜底。`);

  // ⑦公开 main ← 那一笔(快进,同一个 sha)+ 删闸分支。
  console.log(`→ 公开仓 main ← ${publicSha.slice(0, 7)}(同一笔提交,快进)…`);
  gitProxy(target, ["push", "origin", "HEAD:main"]);
  console.log(`→ 删掉闸分支 ${gateBranch} …`);
  try {
    gitProxy(target, ["push", "origin", "--delete", gateBranch]);
  } catch {
    console.log(`  ⚠ 闸分支没删掉(不致命,手动 \`git -C ${target} push origin --delete ${gateBranch}\`)。`);
  }

  landPrivateOnly();
  console.log(v.state === "green"
    ? `⭐ 这棵树的公开 CI 是绿的,而落上去的**就是被验的那一笔**。`
    : `⭐ 落上去的就是送验的那一笔;CI 结论还没出(541 起不等)—— 红了以失败邮件为号,修就是了。`);
}

// 私有仓那半 —— 两条路(正常闸 / 无导出面)共用。
// ⛔ 那道落后检查承重:对端推过 ⇒ 树变了 ⇒ 旧的绿不算数(dev-and-testing「分支闸」);它是第二道(46 之后),
//    真正挡住 527 那笔损失的是 `land` 开头那次,这次只兜两次之间那几秒 —— ⛔ 别因为「上面查过了」删掉,它免费。
function landPrivateOnly() {
  console.log(`→ 问私有仓远端…`);
  assertNotBehind();
  const branch = git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
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
  console.log(`\n✅ 落地完成。私有 master 到 ${headSha}${branch !== "master" ? `(并已合掉 ${branch})` : ""}。`);
}

// ── abandon ───────────────────────────────────────────────────────────────────
function abandon() {
  console.log(`→ 公开仓本地 main 退回 origin/main …`);
  gitProxy(target, ["fetch", "origin", "main"]);
  git(target, ["reset", "--hard", "origin/main"]);
  // ⛔ 顺序与 sweep 同:先 cancel,后删分支(529;「对分支已删的那趟 `gh run cancel` 灵不灵」没验过,排到不需要问的位置)。
  try {
    const mine = listGateBranches().find((b) => b.ref === gateBranch);
    if (mine) cancelRuns(mine.sha, gateBranch);
    else console.log(`   · ${gateBranch} 不在公开仓上(没推成 / 已删过)⇒ 没有 run 要取消。`);
  } catch (e) {
    console.log(`   ⚠ 问不到公开仓的闸分支,这趟没取消 run —— 手动:gh run list -R ${PUBLIC_REPO}` +
      `(${String(e.stderr || e.message).trim().slice(0, 120)})`);
  }
  try {
    gitProxy(target, ["push", "origin", "--delete", gateBranch]);
    console.log(`→ 闸分支 ${gateBranch} 已删。`);
  } catch {
    console.log(`  ⚠ 闸分支 ${gateBranch} 没删掉(可能本来就不在)。`);
  }
  console.log(`\n✅ 已放弃这一趟。⛔ 私有仓一个字没动 —— 你的提交都还在。`);
}

// ── gate = verify → land(测试与工装 85 ①)─────────────────────────────────
// 纯别名,**零语义变化**:541 起 `land` 不等 CI 结论 ⇒ 两条之间没有要人判断的那一步,
// 而 `verify` 每条非致命返回路径的收尾话本来就是「⇒ 直接 land」。die() 会当场退出,
// 所以「verify 拒了还接着 land」不可能发生。⛔ 别在这里加任何新判断 —— 加了它就不是别名了。
function gateCmd() {
  verify();
  console.log("");
  land();
}

const table = { gate: gateCmd, verify, status: statusCmd, land, abandon, sweep };
if (!table[cmd]) {
  console.error("用法:node scripts/branch-gate.mjs gate|verify|land|status|abandon|sweep");
  console.error("  gate     ⭐ 日常走这一条 = verify 跑完接着 land(零语义变化的别名)");
  console.error("  verify   把这棵树推到公开仓闸分支,CI 跑起来(末尾自动 sweep 一次)");
  console.error("  land     落地(公开 main + 私有 master);先本地跑十道静态门禁(红拒),不等 CI 结论,⛔ 已知红拒");
  console.error("  status   问 CI 结论(green / running / red / unknown;红了要修)");
  console.error("  abandon  放弃这一趟,公开仓本地退回;私有仓不动");
  console.error("  sweep    清掉**本环境**留下的孤儿闸分支(先取消它的 run,再删分支)");
  process.exit(1);
}
table[cmd]();

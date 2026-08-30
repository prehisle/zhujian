#!/usr/bin/env node
// 分支闸:**动了产品面就送公开 CI 验,但落地不等裁决 —— 「先落地、红了再修」**。
//
// ⚠⚠ **541(2026-08-30)用户拍板把 520 的原形翻掉了**,别照旧读成「绿了才落地」:
//   ·520 立的原形 = `land` 等 CI 绿(用户点名要「私有 master 只接收公开 CI 绿过的树」);
//   ·541 改成 = `verify` 照旧推闸分支触发 CI(它从此是**警报**),`land` **不等结论**;
//     红了靠三样兜底:**失败邮件** + **开工前 `gh run list` 那一眼**(505)+ **今晚夜跑**。
//   ·判据、样本边界(闸同步等待期间拦下真坏树 0 次,但样本里产品代码几乎没动)、
//     以及**退回同步闸的门**,都在 dev-and-testing「分支闸」那节 —— ⛔ 要翻回去先读它。
// ⛔ **「不等」不是「无视」**:`land` 那一刻 CI 已经答了 **red** 就拒 —— 不等的是
//   还没出的结论,不是已经出了的红。红了修完再来,这是「红了再修」的「修」被强制执行的挂点。
//
//   node scripts/branch-gate.mjs verify    把当前这棵树推到公开仓的一条闸分支,CI 就跑起来
//   node scripts/branch-gate.mjs land      落地(私有 master + 公开 main);⛔ 已知红拒;
//                                          544 起先本地跑十道静态门禁,红了拒(几秒)
//   node scripts/branch-gate.mjs status    问那棵树的 CI 结论(不用等它才 land;红了要修)
//   node scripts/branch-gate.mjs abandon   放弃这一趟,把公开仓本地 main 退回 origin/main
//   node scripts/branch-gate.mjs sweep     清掉**本环境**留下的孤儿闸分支(529 加,见下面 sweep())
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
// ⭐ **闸分支名 = `gate/<环境名>/<短 sha>`,两半的来源刻意不同**(529 起):
//    ·`<短 sha>` **推导,不存** —— 私有 HEAD 一动,名字就对不上 ⇒ 当场 fail-closed。
//      **状态文件会腐烂,推导不会。**(521 承重的那格,⛔ 一个字没动)
//    ·`<环境名>` **存**在各自的 `.git/config` 里(`scripts/lib/dev-env.mjs`)—— 它**不随树变**,
//      是身份不是状态,存下来不会腐烂。⇒ **会变的推导,不会变的存。**
//    有了前缀,`sweep` 才敢删:只碰 `gate/<我这个环境>/*`,够不着对端正在验的那笔。
//
// ⚠ **两处诚实边界,别读大了**:
//   ①**这是脚本闸不是平台闸** —— 谁直接敲 `git push origin master` 都绕得过去。它与
//     dev-and-testing 那六条规矩同级:绑在可观测的东西上的纪律,不是不可逾越的墙。
//   ②**541 起「红树进 master」从「不可能」变成「窗口 ≤ 一趟 CI」** —— land 时结论未出的
//     那棵树若最终红了,它已经在两仓里。这是用户知情接受的取舍(换掉的是每笔 29 分钟等待);
//     兑现「红了再修」靠上面头注那三样,⛔ 别把其中任何一样当成可省。

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
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

// 闸分支名 = **环境名** + 私有 HEAD 的短 sha。
// ⛔ sha 那半别改成随机名 / 时间戳:那样就不再"树一动就对不上"了(521 承重的那格)。
// ⭐ 环境名那半是 529 加的,为的是让 `sweep` 认得出「哪条是我推的」——⛔ 别把它也改成推导,
//    也别改成「一台一条固定分支」(那会把「验的是哪棵树」这个绑定弄丢)。
// ⭐ 用**斜杠**分段不用连字符:清理时按前缀 `gate/<env>/` 匹配,斜杠天然无歧义;
//    连字符的话名叫 `win` 的环境会误匹配到 `gate/win-desk-<sha>` —— 那正好是删错人的分支。
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
// ⛔ **纯文档轮次导不出任何东西**(`docs/` 与 `CLAUDE.md` 本就不在导出白名单里,451 查实)
//    ⇒ 那种轮次**没有 CI 可跑**,而闸不能因此把人卡死(521 补:第一版真卡住了 —— `verify`
//    正确地什么都没推,`land` 却去找一条不存在的闸分支、报「先跑 verify」,而它明明跑过了)。
// ⚠ **判据靠解析 sync-public 的那句话,是有耦合的** ⇒ 两句都没匹配上就 fail-closed,
//    ⛔ 别兜底成「那就当它没东西要推吧」—— 那会让一棵没验过的树从这个洞里落地。
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

// ── sweep(529 立):清掉**我这个环境**留下的孤儿闸分支 ─────────────────────────
// **要治的**(backlog 43):闸分支名由当前 HEAD 推导 ⇒ 一轮里 amend / 补一笔 / rebase 之后
// 再 `verify`,推的是**新**分支,旧那条成孤儿,而四条命令没有一条够得着它。两个后果:
// ①公开仓上攒 `gate/*`;②⭐ **孤儿那趟 CI 还在跑**(522 实测手动取消时已烧约 10 分钟 runner,
// 而那趟结论永远不会有人看)。
//
// ⭐ **环境名把 43 那三条候选的死结一次解开**:
//   - 「推新的之前把 `gate/*` 全删了」原本不行(会掐掉对端正在验的那笔)—— 加了前缀就**够不着别人**。
//   - 「只删同一轮那几条」原本难在:amend 之后旧 sha **不再是**新 HEAD 的祖先,
//     `merge-base --is-ancestor` 恰好答不出。⇒ **那个判据整个不需要了**:不问「是不是同一轮」,
//     只问「是不是我这个环境推的、且不是当前这条」,两个条件当场都算得出来。
//   - 「交给人手动 sweep」最省,但把责任交回给人(而人正是会忘的那个)⇒ 挂在 `verify` 里自动跑。
//
// ⛔ **顺序:先 cancel,后删分支。** 43 里问的「`gh run cancel` 对分支已删的那趟还灵不灵」
//    是**没验过**的 —— 与其去验一个不确定的行为,不如排到根本不需要问的位置。
// ⚠ **老形 `gate/<sha>`(529 之前推的)一律不碰**:它认不出是谁推的,删了可能是别人的。
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
    try {
      const raw = execFileSync(
        "gh",
        ["api", `repos/${PUBLIC_REPO}/actions/runs?head_sha=${b.sha}&per_page=50`,
         "--jq", ".workflow_runs[] | select(.status != \"completed\") | .id"],
        { encoding: "utf8" },
      ).trim();
      for (const id of raw.split("\n").filter(Boolean)) {
        execFileSync("gh", ["run", "cancel", id, "-R", PUBLIC_REPO], { stdio: "ignore" });
        console.log(`   · ${b.ref}  取消了还在跑的 run ${id}`);
      }
    } catch {
      console.log(`   · ${b.ref}  ⚠ 问不到/取消不了它的 run(不致命,继续删分支)`);
    }
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

// ── 「这一轮要不要走闸」(535 立)─────────────────────────────────────────────
// ⭐ **闸从「每轮都走」改成「按需」**,判据就是这个函数(用户 2026-08-29 点名:
//    「CI 要 30 分钟…现在太影响效率」;数据与取舍在 progress-log 535)。
//
// ⭐ **判据不是「碰了哪个目录」,是「只有 CI 答得出的是什么」** —— 逐格算过:
//   · **十道门禁** → 本机 3 秒跑完 ⇒ CI 答不出新东西(而且「改了那道闸或它扫的那份东西
//     就跑它」这条纪律早就在,见 CLAUDE.md「非发版门禁」);
//   · **六套 cargo** → 本机按 crate 跑得了;**只有跨平台那半**(Windows vs Linux 的
//     `cfg` 分支、平台 API 语义差)非 CI 不可 —— 425 那支缺陷就长在这儿;
//   · **Linux e2e** → **今天没有一台开发机跑得了它**(Windows 两台都是 WebKitGTK 之外的
//     引擎;`win-min-home` 连 GUI e2e 都跑不了[语言 + WebView2 151,backlog 27/28])。
//  ⇒ 真正只有 CI 能答的,是**产品面与测试面**那几个目录。`scripts/` 与 `docs/` 不在内。
//
// ⚠ **诚实边界(⛔ 别读大了)**:①改坏一支门禁脚本,从此**当轮没有机器会说话** ——
//   靠的是上面那条既有纪律 + 夜跑兜底(最多晚一天);②`scripts/` 里也有 `sync-public` /
//   `export-public`,改坏它们**导出当场就会响**(每轮都跑),故不列入;③这份清单是**白名单式
//   的反面** —— 漏列一个真产品目录 = 那类改动从此不走闸。⛔ 新增一只 crate / 一棵前端树时
//   **必须回来加一行**(与 `export-public.mjs` 的 ALLOW 同一类维护负担,那份已经栽过)。
const GATED_PATHS = [
  "core/", "src/", "e2e/", "src-tauri/", "mobile/", "sync-proto/", "server/",
  "android/src/", "android/src-tauri/", "ohos/", "index.html", "notebook.html",
  // ⚠ 544 补:它与 `android/src/` 是同一棵前端树(样式与静态壳都在这份里),此前漏列
  //    —— 543 那轮只改它,于是没走闸。「编辑 src/ 走闸、编辑它不走」没有道理。
  "android/index.html",
  // ⭐ **`.github/` 在里头,而它不是「产品面」** —— 判据是本函数头上那句「只有 CI 答得出的
  //    是什么」的一个特例:**改了 CI 自己的定义,就该让 CI 当场证明它还会跑**。
  //    ⛔ 这不是洁癖:触发条件写错的失灵方式是**安静地不跑**(448 第一版把 `branches` 写成
  //    `tags-ignore`,「文件语法对 + 已登记 active」全成立,而 run 一趟都没建)。
  //    ⇒ 唯一能证伪它的动作,就是真推一条闸分支、看 run 出不出来。
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

// ── 「这一轮是不是纯版本号 bump」(541 立,backlog 测试与工装 56 的落点)────────────
// 发版 bump 那笔(七处版本串 + 四份 lock)恒命中 `src-tauri/` 与 `android/src-tauri/`
// ⇒ 539 实测它一定触发闸,白烧一趟 CI 还可能收一封 e2e 抖动的假红邮件。
// 而那棵树 = 上一棵树 + 版本串,发版的安全判据在 release 线的 preflight(它全跑、fail-closed)。
//
// ⭐ **判定是内容级的,不只看文件名**:两层都过才免 ——
//   ①动过的 gated 文件 ⊆ 下面这张实测白名单(539/491 两笔 bump 的 `git show --name-only`,
//     两笔逐字相同;package.json / site 那几处不在 GATED_PATHS,轮不到这儿管);
//   ②那几个文件的 diff 里,每一条 +/- 行都是版本串行(`"version": "x.y.z"` / `version = "x.y.z"`)。
// ⛔ **fail-closed 的方向要读对**:判不准 ⇒ **照常走闸**,代价只是多跑一趟不等的警报 CI,零风险;
//   反过来(判宽了把真代码改动放进免闸路)才是要防的,所以 ② 对 lock 也逐行核 ——
//   ⚠ 539 那格判例:`android/src-tauri/Cargo.lock` 里 `pkg-config` 的版本恰好也是 0.3.33,
//   **按行模式核**(整行是不是版本串)不会被它骗,按「含不含那个串」核就会。
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

// ── 「私有仓落后了吗」─────────────────────────────────────────────────────────
// ⛔ **承重的不只是这道检查本身,还有它排在第几位**(backlog 46;527 实撞,不是推断)。
//    527 那趟 `land` 的顺序是「①推公开 main → ②删闸分支 → ③**这才**问私有仓」,而 ① 推上去的
//    是一棵**没有对端 526** 的导出 ⇒ 公开 main 上 `compose-recovery-blob.e2e.js` 被删、
//    `src/item-images.ts` 被回退,直到重跑一趟闸(约 30 分钟)才补回来。
//    ⚠ **私有仓(唯一真相源)全程没坏**,坏的是公开那份快照 —— 而**公开仓正是 CI 跑的地方**:
//    那半小时里别人推上去的任何一趟 CI,验的都是一棵少了 526 的树。
// ⇒ **今天它叫三次,前两次的位置都是「这条路上任何一次远端写之前」**:
//    ·`verify`:导出之前 —— 否则那 29 分钟验的是一棵**注定要被 rebase 掉的树**(527 白跑一趟)。
//    ·`land`:问闸分支之前 —— 那正是上面那笔损失的落点。
//    ·`landPrivateOnly`:**第二道**,只兜「前一次检查之后、推上去之前那几秒里对端刚好推了」。
//      ⚠ 它救不了已经推出去的公开 main(窗口从整趟 land 缩到几秒,**不是缩到零**);
//      留着是因为它免费,且比 git 自己那句 non-fast-forward 说得清楚。
// ⛔ **别顺手改成「落后就自动 rebase」**:rebase 会有冲突(527 那次 `progress-log` 就冲突了),
//    工装不该替人解冲突 —— 拒了、让人自己 rebase 再来,是对的。
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

// ── 「公开仓本地 main 上有没有悬着的导出」(536 立,backlog 测试与工装 52)─────────
// ⛔⛔ **这道闸曾经有一个洞,而它打的正是闸自己的承诺**(534 收口时实撞,逐格在 backlog):
//   ①`verify` 一趟 ⇒ 公开仓**本地** main 上多一笔导出、并推成闸分支;
//   ②私有 HEAD 一动(amend / 补一笔)⇒ 闸分支名跟着变,在飞那条成了孤儿;
//   ③再问 `exportDelta()` —— 它比的是「工作仓导出 **vs 公开仓本地 main**」,而本地 main 上
//     **已经躺着 ① 那笔** ⇒ 恒答「一致」⇒ `land` 走「无导出面」那条路:核的是 `origin/main`
//     当前那笔的 CI(**对端的树**,当然绿),然后**只推私有 master、不推公开 main**。
//   ⇒ **一棵含新代码的树落进了私有 master,而它自己那趟 CI 的结论一次都没被问过。**
//
// ⭐ **修法选的是「fail-closed 前置」,不是「把 `exportDelta()` 改成跟 origin/main 比」** ——
//    ⛔ 后者只把那**一句答案**修对,而**悬着的那笔导出仍然躺在本地 main 上**:下一趟 `land`
//    走 535 那条「没动那几面 ⇒ 直接推公开 main」的路时,照样会把它一起推上去。
//    前置把这个**状态**整个拦住,与这道闸的性格一致:**它宁可停也不猜**(同 46:判据比错了参照物)。
// ⛔ **别把「本地 main 领先」本身当成错误状态** —— `verify` 之后到 `land` 之前它**本来就该领先**,
//    那是正常态。要分的是两种领先:**绑在当前这棵树的闸分支上**(正常)/ **对不上**(要拦的)。
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
// **要治的**:「改了哪道门禁 / 它扫的那份东西就跑那道」此前只是一句印出来的提醒,已经
// 失守过两次(512:一道在干净树上红了十一天没人知道;544 前一轮:改了 android/index.html
// 收口时没跑 CSS 那几道,用户追问才补)。十道全跑一遍只要几秒 ⇒ 与其让人记「该跑哪道」,
// 不如把全套接到 land 这个自动边界上(385 那课:加新检查前先问「已有的接上了吗」)。
// ⚠ 诚实边界:①**只有这十道** —— 「非发版门禁」那一族(要 Chrome / 样本冻结的)不在内,
//   512 那支 `check-i18n-plural-render` 恰恰属于后者,它那类失守仍靠既有纪律 + 夜跑;
//   ②清单与 preflight.yml 那十道**同口径**(以 CLAUDE.md「怎么跑」为准),两处要同改;
//   ③红了拒 land,与「已知红拒」同一性格 —— 这里的红是本机 3 秒就能问出来的,没有「不等」可言。
const LOCAL_GATES = [
  "lock-drift", "theme-drift", "contrast", "hardcoded-colors", "timing-drift",
  "radius-drift", "fs-drift", "filter-parity", "hit-zone", "i18n-drift",
];
function runLocalGates() {
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

  // ⭐ **535:没动那几面就不走闸** —— 判据与三处诚实边界焊在 `gatedDelta()` 头上。
  //    ⛔ 别把这一格读成「跳过验证」:①十道门禁与那几套 cargo 本机跑得了(而且本来就该跑);
  //    ②夜跑每天一趟兜底(最多晚一天);③真想立刻要一趟 ⇒ `gh workflow run ci.yml`。
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

  // ⛔⛔ **这一问必须排在 sync 之前**(521 补二栽的就是这个):放在后面问,东西已经被
  //    sync 提交掉了,于是它**恒答「没有」** —— 而那句话与刚刚发生的事**正好相反**。
  //    ⚠ 那次没造成损失(`land` 先 `ls-remote`,照样走对路),但**一句与事实相反的收尾话**
  //    正是最该修的那类:下一个人会照它办事。
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

  // ②⛔ **落后检查排在这儿就是 backlog 46 的修法** —— 它必须在**任何一次远端写之前**,
  //    而不是像 527 那样排在最后(那时公开 main 已经被推回去了)。理由见 assertNotBehind 头注。
  assertNotBehind();

  // ③⭐ **536:同一道前置** —— 悬着的导出会让下面每一问都答错(backlog 测试与工装 52)。
  //    ⚠ 正常闸那条路走到这儿必然是 `bound`(verify 推过、树没变);`even` = 这一轮压根没走闸
  //    (纯文档 / 535 那条不走闸的路)。两种都放行,**第三种在函数里当场停**。
  assertPublicMainBound();

  // ④⭐ **535:没动那几面 ⇒ 不走闸,直接落地**(判据与三处诚实边界在 `gatedDelta()` 头上);
  //    **541 起纯版本号 bump 轮走同一条路**(判据在 `versionBumpOnly()` 头上)。
  //    ⚠ 与下面那条「纯文档轮」**不是同一条路,别合并**:那条是「压根没东西进公开仓」
  //    ⇒ 只推私有;这条是「有东西进公开仓、但不值得为它烧一趟 CI」⇒ **照样把公开 main 推上去**
  //    (公开快照该保持跟手 —— 它是 CI 与外部读者看到的那棵树)。
  //    ⛔ 别为了省事改成「也不推公开仓」:那会让快照一直落后,而夜跑验的正是它。
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
// ⛔ 那道**落后检查**是承重的:对端推过 ⇒ 树变了 ⇒ 旧的绿不算数,必须重跑 verify。
//    别为了快把它关掉(dev-and-testing「分支闸」那节明写)。
// ⚠ **这儿是第二道**(backlog 46 之后):真正挡住 527 那笔损失的是 `land` 开头那一次,
//    这次只兜两次之间那几秒。⛔ 别因为「上面已经查过了」把它删掉 —— 它免费。
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
  try {
    gitProxy(target, ["push", "origin", "--delete", gateBranch]);
    console.log(`→ 闸分支 ${gateBranch} 已删。`);
  } catch {
    console.log(`  ⚠ 闸分支 ${gateBranch} 没删掉(可能本来就不在)。`);
  }
  console.log(`\n✅ 已放弃这一趟。⛔ 私有仓一个字没动 —— 你的提交都还在。`);
}

const table = { verify, status: statusCmd, land, abandon, sweep };
if (!table[cmd]) {
  console.error("用法:node scripts/branch-gate.mjs verify|land|status|abandon|sweep");
  console.error("  verify   把这棵树推到公开仓闸分支,CI 跑起来(末尾自动 sweep 一次)");
  console.error("  land     落地(公开 main + 私有 master);先本地跑十道静态门禁(红拒),不等 CI 结论,⛔ 已知红拒");
  console.error("  status   问 CI 结论(green / running / red / unknown;红了要修)");
  console.error("  abandon  放弃这一趟,公开仓本地退回;私有仓不动");
  console.error("  sweep    清掉**本环境**留下的孤儿闸分支(先取消它的 run,再删分支)");
  process.exit(1);
}
table[cmd]();

#!/usr/bin/env node
// 在**当前这个 Windows 登录会话**里跑 Windows/WebView2 那趟 e2e —— 让它不再独占你的桌面。
//
// **它要解决的是一个量出来的问题**:450 之后两端共用面的债只剩「Windows/WebView2 那趟
// e2e」,而它今天压在人身上,且**跑动期间整台开发机动不了**(447 量的 5:22–10:28;
// CLAUDE.md 那条纪律原话:「跑动期间别在同一台机器上并行跑任何会起窗口 / 抢焦点的命令
// —— 包括你自己的『只读检查』」)。托管 runner 那条路是死的(backlog 测试与工装 27:
// runner 的 WebView2 151 把 `--remote-debugging-port` 丢掉了,453 定案 / 472 复问)。
//
// **做法**:开第二个 Windows 本地账户,在**它的会话**里跑这个脚本,然后切回你自己的会话
// 继续干活 —— Windows 的会话之间输入队列与桌面是隔离的,e2e 的点击与焦点落在那边。
// ⭐ 顺带一格白捡的:全局热键(`Ctrl+Alt+N`)是按会话注册的 ⇒ **生产朱简不必退**。
//
// ⚠⚠ **本文件是一次"验它行不行"的工装,不是已经成立的结论。** 唯一没被验证的那格是:
// 你切回自己的会话之后,那个会话变成 **disconnected**,WebView2 有头形在里头**起不起得来**。
// 推不出来,只能真跑一趟 —— 这就是 `--smoke` 那档存在的理由(它只问这一句,约一分钟)。
// 同 memory `test-negative-control` / ci-plan §8-3:「本机跑绿证明不了另一处跑得过」。
//
// 用法(在**第二个账户的会话里**跑):
//   node scripts/e2e-session.mjs --smoke   # 只问「会话建得起来吗」,一支 spec
//   node scripts/e2e-session.mjs           # 全量
//
// **形是 release 不是 fast**,这不是随手挑的,三条理由:
//   ①release 档 `onPrepare` 不跑 `cargo build` ⇒ 第二个账户**不需要装 Rust**;
//   ②release 档不要 vite ⇒ **不占 :1420**,你那边照常 `npm run dev`(fast 档会跟你抢端口,
//     那等于把「独占桌面」换成「独占端口」,没解决问题);
//   ③它本来就是「发版前的最终门禁」那一档(`wdio.conf.js:27`)。
//   ⇒ 代价:**exe 得由你那边先建好**(`npm run tauri build --no-bundle` 或 `cargo build --release`),
//     本脚本**只报它是什么、绝不替你判它新不新**(理由见下面「验的是哪棵树」)。

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync, createWriteStream } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const argv = process.argv.slice(2);
const smoke = argv.includes("--smoke");
// 只过前置闸就停 —— 给「这个账户配好了没有」用,不起任何窗口(⇒ 在**主账户**里跑也无害)。
const checkOnly = argv.includes("--check-only");

function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(2);
}
function ok(msg) {
  console.log(`  ✓ ${msg}`);
}

// ── 前置闸(全部 fail-closed;⛔ 一格都别改成"那就当它行吧") ──────────────────
console.log("── 前置检查 ──");

if (process.platform !== "win32") {
  die(
    `这个脚本只管 Windows/WebView2 那一趟(当前平台 ${process.platform})。` +
      "Linux 那半由公开仓 CI 兑现(ci-plan 阶段 3),不需要第二个会话。",
  );
}

// ① 显示语言。⚠ 这一格不是洁癖:整套 spec 的断言都是**中文串**,而 358 起语言「自动」档跟
//    `navigator.language` 走,在 WebView2 上那个值**跟 Windows 显示语言走**。新建的账户如果
//    落在英文界面上,e2e 会稳定红一大片,而**一个产品缺陷都没有**(machine-setup.md §6.1
//    最后一条:英文 locale 的机器上稳定 32/39 红)。⛔ 问不出来也判死 —— 未知 fail-closed,
//    因为它失灵的方式正是"看着像真缺陷的一片红"。
const langProbe = spawnSync(
  "powershell",
  [
    "-NoProfile",
    "-Command",
    "@((Get-ItemProperty 'HKCU:\\Control Panel\\Desktop' -EA 0).PreferredUILanguages) + " +
      "@((Get-WinSystemLocale).Name) -join ','",
  ],
  { encoding: "utf8" },
);
const langs = (langProbe.stdout || "").trim();
if (!langs) {
  die(
    "问不出这个账户的 Windows 显示语言(PowerShell 没回话)。⛔ 不给它兜底:" +
      "英文界面下这套 e2e 会红一大片而一个产品缺陷都没有,那种红比不跑更贵。",
  );
}
if (!/\bzh/i.test(langs)) {
  die(
    `这个账户的显示语言是 \`${langs}\`,不是中文 ⇒ 整套断言(中文串)会红一大片,` +
      "而那**不是产品缺陷**(machine-setup.md §6.1)。\n" +
      "  修法:以这个账户登录 → 设置 → 时间和语言 → 语言,把 Windows 显示语言换成中文,注销再登录。",
  );
}
ok(`显示语言 ${langs}`);

// ② 两只 driver。msedgedriver 本来就在仓里;tauri-driver 原本住 `~/.cargo/bin`(**按账户**),
//    而第二个账户没有 Rust ⇒ 从仓里那份复制过去。`/e2e/drivers/` 是 gitignore 的,
//    放在那儿既不进提交、也不必去碰主账户的家目录。
const nativeDriver = resolve(root, "e2e/drivers/msedgedriver.exe");
if (!existsSync(nativeDriver)) die(`缺 ${nativeDriver}(仓里那份 msedgedriver)`);
ok("msedgedriver 在");

const driverHome = resolve(homedir(), ".cargo/bin/tauri-driver.exe");
if (!existsSync(driverHome)) {
  const staged = resolve(root, "e2e/drivers/tauri-driver.exe");
  if (!existsSync(staged)) {
    die(
      `这个账户没有 tauri-driver,仓里也没有备份。\n` +
        `  在**主账户**里跑一次:cp ~/.cargo/bin/tauri-driver.exe ${staged}`,
    );
  }
  mkdirSync(dirname(driverHome), { recursive: true });
  copyFileSync(staged, driverHome);
  ok(`tauri-driver 已从仓里复制到 ${driverHome}`);
} else {
  ok("tauri-driver 在");
}

// ③ release exe。⛔ **不替你判它新不新** —— 415 那一课:`mtime 比 HEAD 新 ≠ 指纹新鲜`,
//    而唯一硬的判法是让 cargo 自己答,那要 Rust(本档刻意不装)。⇒ 这里只做两件诚实的事:
//    存在性判死 + 把「验的是哪棵树」原样印进日志头(规矩 2 / memory `verify-artifact-predates-fix`)。
const appExe = resolve(root, "src-tauri/target/release/app.exe");
if (!existsSync(appExe)) {
  die(
    "没有 release exe。这一档不建它(第二个账户不装 Rust)⇒ 在**主账户**里先建:\n" +
      "  cd src-tauri && cargo build --release   (或 npm run tauri build --no-bundle)",
  );
}
if (process.env.YS_E2E_FAST === "1") {
  die("YS_E2E_FAST=1 被设着 —— 本档刻意走 release(不占 :1420、不要 Rust),先把它去掉。");
}

const git = spawnSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], { encoding: "utf8" });
const head = git.status === 0 ? git.stdout.trim() : "(这个账户问不到 git)";
const dirty = spawnSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" });
const dirtyN = dirty.status === 0 ? dirty.stdout.trim().split("\n").filter(Boolean).length : "?";
const treeLine =
  `验的是哪棵树:HEAD=${head} · 工作树改动 ${dirtyN} 处 · ` +
  `release exe 时刻 ${statSync(appExe).mtime.toISOString()}`;
ok(treeLine);

if (checkOnly) {
  console.log("\n✓ 前置闸全过 —— 这个账户配好了。去掉 `--check-only` 就开跑。\n");
  process.exit(0);
}

// ── 跑 ────────────────────────────────────────────────────────────────────
const logDir = resolve(root, ".zjshots/e2e-session");
mkdirSync(logDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const logPath = resolve(logDir, `${smoke ? "smoke" : "full"}-${stamp}.log`);

// ⛔ `--specFileRetries=0`:常态配置里那个 `specFileRetries:1` 会吸收冷启假红,报「全绿」
//    前必须要么关掉它、要么看 `N retries` 那一格(CLAUDE.md 原话)。这里直接关掉,
//    并与 `e2e-verdict` 里数「实际有没有重试」的那半互为背书(那份文件头注写了为什么两半都要)。
const wdioArgs = [
  resolve(root, "node_modules/@wdio/cli/bin/wdio.js"),
  "run",
  resolve(root, "e2e/wdio.conf.js"),
  "--specFileRetries=0",
];
if (smoke) wdioArgs.push("--spec", resolve(root, "e2e/specs/idea-stats.e2e.js"));

console.log(`\n── 开跑(${smoke ? "冒烟:一支 spec" : "全量"})──`);
console.log(`日志:${logPath}\n`);

const log = createWriteStream(logPath);
log.write(`# ${treeLine}\n# 显示语言:${langs}\n# 档:release / ${smoke ? "smoke" : "full"}\n\n`);

const child = spawn(process.execPath, wdioArgs, { cwd: root });
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (b) => {
    process.stdout.write(b);
    log.write(b);
  });
}

child.on("close", (code) => {
  log.end();
  log.on("finish", () => {
    console.log("\n── 判读 ──");
    // 判绿走那把三态尺,⛔ 别看退出码、也别眼扫「看着都绿」(CLAUDE.md 那条纪律)。
    const verdict = spawnSync(
      process.execPath,
      [resolve(here, "e2e-verdict.mjs"), logPath, `--status=${code}`, "--label=Windows/WebView2(第二会话)"],
      { encoding: "utf8" },
    );
    process.stdout.write(verdict.stdout || "");
    process.stderr.write(verdict.stderr || "");

    if (smoke) {
      // ⭐ 冒烟这一档**要答的不是「断言绿没绿」**,是「**这个会话里 WebView2 起不起得来**」。
      //    27/28 那堵墙的形是固定的:`session not created`(拿不到 `DevToolsActivePort`)。
      //    ⇒ 单独把这一句挑出来报,免得被断言的红盖住真正的答案。
      const body = spawnSync(process.execPath, ["-e", `process.stdout.write(require("fs").readFileSync(${JSON.stringify(logPath)},"utf8"))`], { encoding: "utf8" }).stdout || "";
      const blocked = /session not created|DevToolsActivePort/i.test(body);
      console.log("\n── 冒烟要问的那一句 ──");
      console.log(
        blocked
          ? "✗ 会话没建起来(日志里有 `session not created` / `DevToolsActivePort`)\n" +
              "  ⇒ 这个会话里 WebView2 起不来。先查:这一趟你是**切走了**还是**留在这个会话里**?\n" +
              "    两种情形要分开报 —— 「留着能跑、切走就死」和「怎么都死」是两个不同的结论。"
          : "✓ 会话建起来了 ⇒ WebView2 在这个会话里能起。断言绿不绿看上面那把尺的读数。",
      );
    }
    process.exit(verdict.status ?? 1);
  });
});

#!/usr/bin/env node
// 判一趟 e2e 到底绿没绿 —— 给 CI 用的那把尺(450 立,ci-plan 阶段 3)。
//
// 用法:
//   node scripts/e2e-verdict.mjs <wdio 日志文件> --status=<跑手的退出码> [--label=<这趟是哪一端>]
//
// **为什么不是直接看退出码**:440 那轮把这件事查透了 —— 「这趟红没红」的判据本身会骗人,
// 而它骗人的方式是**安静的绿**。那把三态尺(`lib/test-verdict.mjs`,25 格回归网 + 六刀)
// 已经把核心判据焊死了:**绿必须有正面字据**(wdio 自己印的那行 `Spec Files: … (100% completed)`),
// 读不出就是 `unknown`,⛔ 不许退回「那就算它绿吧」。本文件是它的**跑手侧壳**,只多做三件事:
//
//   ①把 `unknown` 与 `red` 用**不同的退出码**报出来(2 / 1)—— 两者都让 CI 变红,但
//     「工装自己坏了」与「测试真红了」记进同一本账,正是 440 说的伪造证据;
//   ②数两样 wdio 汇总行里**没有**的东西,并把它们印成读数:**用例数**(`✓` 的个数,436 起
//     人跑收口就是这么数的)与**重试痕迹**;
//   ③把「零重试」这条判据落成真判据。⚠ **它与 `--specFileRetries=0` 互为背书,谁也不能单独成立**:
//     那个开关把「会不会重试」从配置里拿掉,而这里数的是「**实际有没有发生过重试**」——
//     开关哪天被 wdio 改名 / 被静默忽略,配置里那个常态的 `specFileRetries:1` 就会回来吸收假红,
//     那时**只有这半边**看得见(反过来,wdio 哪天改掉 `RETRYING` 那个词,就只剩开关那半边)。
//     ⛔ 别把任何一半当成多余的。
//
// ⛔ **不做的两件**(免得下一个人以为漏了):
//   · **不把「39 spec / 171 例」焊成断言** —— 那个数会随正常加测试变动,焊死它等于给每次
//     加一只测试添一道无谓的红,而它要防的那件事(**一个用例都没跑却报绿**)只需要
//     `cases > 0` 这一格就守住了(spec 数那一格 `test-verdict.mjs` 自己有)。读数照印,
//     对不对得上人跑的那趟由人比对(规矩 4:数字打架取实跑)。
//   · **不解析失败清单**(哪几支红、红在哪句)—— 那是日志本身的事,CI 里日志整份都在。
import { appendFileSync, readFileSync } from "node:fs";
import { wdioVerdict } from "./lib/test-verdict.mjs";

const argv = process.argv.slice(2);
const logPath = argv.find((a) => !a.startsWith("--"));
const statusArg = argv.find((a) => a.startsWith("--status="));
// 452:两格共用这把尺了(`linux-e2e` 与 `nightly-e2e`)⇒ job summary 那行标题不能再写死成
// 「Linux / WebKitGTK」。⚠ **不给它兜底成某一端** —— 没传就说「没说是哪一端」,
// 冒名顶替比缺名字难查得多(两格的结论会并排出现在同一个 Actions 页面上)。
const labelArg = argv.find((a) => a.startsWith("--label="));
const endLabel = labelArg ? labelArg.slice("--label=".length) : "没说是哪一端";

function die(msg) {
  console.error(`\n❌ ${msg}\n\n用法:node scripts/e2e-verdict.mjs <wdio 日志文件> --status=<跑手退出码>`);
  process.exit(2);
}
if (!logPath) die("没给日志文件。");
// ⚠ `--status` 是**必填**:退出码是三条红字据之一(见 test-verdict.mjs),缺了它这把尺就短一截。
// 事后读一份老日志时,把你当时真看到的退出码填进来;⛔ 别为了跑通随手填 0 —— 那是编字据。
if (!statusArg) die("没给 --status=<跑手退出码>。它是三条红字据之一,缺了判不出。");
const status = Number(statusArg.slice("--status=".length));
if (!Number.isInteger(status)) die(`--status 要一个整数,拿到的是 ${statusArg}`);

let text;
try {
  text = readFileSync(logPath, "utf8");
} catch (e) {
  die(`日志读不动:${logPath}\n  ${e.message}`);
}

const verdict = wdioVerdict(text, status);

// ---- 两样读数(观测,不是判据;只有 cases===0 与重试痕迹会翻脸,见头注)----------------
// 用例数:spec reporter 每过一只印一个 `✓`(436 起人跑收口就是数它:「`✓` 恰 171」)。
const cases = (text.match(/✓/g) ?? []).length;
// 重试痕迹:wdio 9 在**每支 spec 收尾那行**上印,两种形都要认(@wdio/cli build/index.js:605/634)——
//   `[cid] RETRYING - …`(重试发起那一刻)
//   `[cid] PASSED … (1 retries)`(重试之后过了)
const retryMarks = [...text.matchAll(/\bRETRYING\b|\(\d+ retries\)/g)].map((m) => m[0]);
// 墙钟:汇总行尾的 `in 00:10:11`。
const durMatch = text.match(/\((?:\d+)% completed\)\s*in\s*([0-9:]+)/);
const duration = durMatch ? durMatch[1] : "(读不出)";

const { counts } = verdict;
const reading =
  `${counts.total ?? "?"} spec / ${cases} 例 · ` +
  `重试痕迹 ${retryMarks.length} 处 · 墙钟 ${duration}`;

console.log("");
console.log("──────── e2e 判读 ────────");
console.log(`日志:${logPath}`);
console.log(`跑手退出码:${status}`);
console.log(`读数:${reading}`);

let state = verdict.state;
let why = verdict.why;

// 绿了还要过这两格 —— 它们守的是「汇总说全过、而那份汇总本身不该被信」的两种形。
if (state === "green" && cases === 0) {
  state = "unknown";
  why = "汇总说 spec 全过,但一个 `✓` 都没有 —— 39 支 spec 一只用例没跑也叫「全过」(mocha 里空 describe 就是绿的)";
}
if (state === "green" && retryMarks.length > 0) {
  state = "unknown";
  why =
    `汇总说全过,但日志里有 ${retryMarks.length} 处重试痕迹(${[...new Set(retryMarks)].join(" / ")})—— ` +
    "本形跑的时候带了 `--specFileRetries=0`,不该有任何一次重试。⇒ 那个开关没生效(被改名 / 被忽略?)," +
    "而配置里常态开着的 `specFileRetries:1` 正在吸收假红 ⇒ 这趟的「全过」证明不了这棵树是绿的";
}

const label = { green: "✅ 绿", red: "❌ 红", unknown: "⚠ 判不出(按红处理,但⛔别记进抖动账)" }[state];
console.log(`结论:${label} —— ${why}`);
console.log("─────────────────────────");

// GitHub Actions 的 job summary(有就写,没有就算 —— 本地跑没这个环境变量)。
if (process.env.GITHUB_STEP_SUMMARY) {
  try {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### e2e(${endLabel})\n\n${label}\n\n\`\`\`\n${reading}\n${why}\n\`\`\`\n`,
      "utf8",
    );
  } catch {
    // 写不进去不影响判读本身,别为它翻红。
  }
}

// 0 绿 / 1 红 / 2 判不出。⛔ 三者别合并:CI 只看非零,而人要看得出是哪一种。
process.exit(state === "green" ? 0 : state === "red" ? 1 : 2);

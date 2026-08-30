#!/usr/bin/env node
// 判一趟 `cargo test` 到底绿没绿 —— `e2e-verdict.mjs` 的同族,换个输入源(539 立)。
//
// 用法:
//   node scripts/cargo-verdict.mjs <cargo 日志文件> --status=<跑手的退出码> [--label=<这趟是哪一格>]
//
// **为什么需要它**:539 把 preflight 的 Windows 那格按 crate / 按 `core` 的模块**分了片**,
// 而分片是靠**给 libtest 传过滤串**实现的 —— 于是多了一种此前不存在的失灵方式:
//
//   过滤串打错一个字 ⇒ `test result: ok. 0 passed; 0 failed; … 1060 filtered out`,
//   **退出码 0**,那一格在 Actions 页面上是**绿的**,而它一只测试都没跑。
//
// 这正是 `lib/test-verdict.mjs` 头注里记的第 ② 种 fail-open,那把三态尺**已经把它焊死了**
// (`counts.passed === 0` → `unknown`,不是 green),且有 25 格冻结样本 + `check-test-verdict.mjs`
// 的阴性对照压着。⇒ ⛔ **别在这里重写一遍判据**(重写 = 自指的空测,292 判例),
// 本文件只做跑手侧那三件壳的事:读日志 / 印读数 / 用**不同退出码**把 red 与 unknown 分开报。
//
// ⚠ 它**不**回答「这一片该不该有这么多支」—— 那是分片划分的完整性,判据在 preflight.yml
//   那格注释里(三片计数之和 == 全量,附可复跑的一行命令)。这里只答「这一片真的跑了东西吗」。
import { readFileSync, appendFileSync } from "node:fs";

import { libtestVerdict } from "./lib/test-verdict.mjs";

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith("--"));
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const label = arg("label", "cargo test");

if (!file) {
  console.error("用法:node scripts/cargo-verdict.mjs <日志文件> --status=<退出码> [--label=…]");
  process.exit(2);
}

// ⛔ fail-closed:`--status` 缺席不许当 0 —— 退出码是这把尺的一半输入,少了它判不出。
const rawStatus = arg("status", null);
if (rawStatus === null) {
  console.error("✗ 必须显式给 --status=<跑手的退出码>(缺了它这把尺只剩一半输入)");
  process.exit(2);
}
const status = rawStatus === "null" || rawStatus === "" ? null : Number(rawStatus);

let out;
try {
  out = readFileSync(file, "utf8");
} catch (e) {
  console.error(`✗ 读不到日志 ${file}:${e.message}`);
  process.exit(2);
}

const { state, why, counts } = libtestVerdict(out, status);
const reading =
  `passed ${counts.passed} · failed ${counts.failed} · ` +
  `ignored ${counts.ignored} · filtered out ${counts.filtered} · 退出码 ${rawStatus}`;

const badge = {
  green: "✅ 绿",
  red: "❌ 红",
  unknown: "⚠ 判不出(按红处理,但⛔ 别读成「测试红了」)",
}[state];

console.log("─────────────────────────");
console.log(`${label}:${reading}`);
console.log(`结论:${badge} —— ${why}`);
console.log("─────────────────────────");

if (process.env.GITHUB_STEP_SUMMARY) {
  try {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### ${label}\n\n${badge}\n\n\`\`\`\n${reading}\n${why}\n\`\`\`\n`,
      "utf8",
    );
  } catch {
    // 写不进去不影响判读本身,别为它翻红。
  }
}

// 0 绿 / 1 红 / 2 判不出。⛔ 三者别合并:CI 只看非零,而人要看得出是哪一种。
process.exit(state === "green" ? 0 : state === "red" ? 1 : 2);

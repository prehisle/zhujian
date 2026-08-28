#!/usr/bin/env node
// 判一趟 Kotlin JVM 单测(`:app:testUniversalDebugUnitTest`)到底绿没绿 —— 给 CI 用的那把尺。
//
// 用法:
//   node scripts/kotlin-test-verdict.mjs <test-results 目录> --status=<gradle 退出码> [--label=<这趟是哪条线>]
//
// **为什么不是直接看 gradle 的退出码**:gradle 的 `test` 任务在**一支测试都没跑**的时候
// 照样是 `BUILD SUCCESSFUL`(源文件被挪走 / 任务名改了 / 变体改了名 —— 三种形都让它安静地绿)。
// 440 那轮已经把这件事在 e2e 那一端查透了:**绿必须有正面字据**。这把尺是同一条判据换个输入源
// (gradle 自己写的 JUnit XML),与 `scripts/e2e-verdict.mjs` 同形、同三态退出码:
//   0 = 绿 / 1 = 红 / 2 = 判不出。⛔ 三者别合并 —— CI 只看非零,而人要看得出是哪一种。
//
// ⛔ **不做的两件**(免得下一个人以为漏了):
//   · **不把「23 支」焊成断言** —— 那个数会随正常加测试变动,焊死它等于给每次加一只测试
//     添一道无谓的红;而它要防的那件事(**一支都没跑却报绿**)只需要 `tests > 0` 这一格就守住了。
//     读数照印,对不对得上人跑的那趟由人比对(规矩 4:数字打架取实跑)。
//   · **不解析失败清单**(哪几支红、红在哪句)—— 那在 gradle 自己的 HTML/XML 报告里,CI 里整份都在。
//
// ⚠ **本机跑的时候留神一格**:gradle 判 `testUniversalDebugUnitTest` 是 `UP-TO-DATE` 时**不重跑**,
//    这把尺读到的就是**上一趟**留下的 XML(读数看着很正常)。CI 上不会 —— 每趟都是干净检出、
//    `build/` 是空的,且没有给 gradle 挂任何跨趟缓存。本机要真跑一趟就带 `--rerun-tasks`。
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const dirPath = argv.find((a) => !a.startsWith("--"));
const statusArg = argv.find((a) => a.startsWith("--status="));
// ⚠ **不给它兜底成某一条线** —— 没传就说「没说是哪条线」。两条 workflow(nightly / release)
// 共用这把尺,冒名顶替比缺名字难查得多。
const labelArg = argv.find((a) => a.startsWith("--label="));
const lineLabel = labelArg ? labelArg.slice("--label=".length) : "没说是哪条线";

function die(msg) {
  console.error(
    `\n❌ ${msg}\n\n用法:node scripts/kotlin-test-verdict.mjs <test-results 目录> --status=<gradle 退出码>`,
  );
  process.exit(2);
}
if (!dirPath) die("没给 test-results 目录。");
// ⚠ `--status` 是**必填**:退出码是红字据之一,缺了这把尺就短一截。
// ⛔ 别为了跑通随手填 0 —— 那是编字据。
if (!statusArg) die("没给 --status=<gradle 退出码>。它是红字据之一,缺了判不出。");
const status = Number(statusArg.slice("--status=".length));
if (!Number.isInteger(status)) die(`--status 要一个整数,拿到的是 ${statusArg}`);

// ---- 读 XML ------------------------------------------------------------------
// ⚠ 按**属性名**取,不按属性顺序 —— gradle 换个版本重排属性,按顺序的正则会静静读空。
function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? Number(m[1]) : null;
}

let files = null;
try {
  files = readdirSync(dirPath).filter((f) => f.startsWith("TEST-") && f.endsWith(".xml"));
} catch (e) {
  files = null;
  var readErr = e.message; // eslint-disable-line no-var
}

let tests = 0;
let failures = 0;
let errors = 0;
let skipped = 0;
let suites = 0;
let unparsed = [];
if (files) {
  for (const f of files) {
    const text = readFileSync(join(dirPath, f), "utf8");
    const open = text.match(/<testsuite\b[^>]*>/);
    const t = open ? attr(open[0], "tests") : null;
    if (t === null) {
      unparsed.push(f);
      continue;
    }
    suites += 1;
    tests += t;
    failures += attr(open[0], "failures") ?? 0;
    errors += attr(open[0], "errors") ?? 0;
    skipped += attr(open[0], "skipped") ?? 0;
  }
}

const reading = files
  ? `${suites} 个测试类 / ${tests} 支 · 失败 ${failures} · 出错 ${errors} · 跳过 ${skipped}`
  : "(目录都读不动,没有读数)";

console.log("");
console.log("──────── Kotlin JVM 单测判读 ────────");
console.log(`结果目录:${dirPath}`);
console.log(`gradle 退出码:${status}`);
console.log(`读数:${reading}`);

// ---- 定态 --------------------------------------------------------------------
// 顺序有讲究:**先判「有没有正面字据」,再判红绿**。反过来的话,`status===0` + 空目录
// 会先被判成绿,那正是本文件存在的理由。
let state;
let why;
if (!files) {
  state = "unknown";
  why = `结果目录读不动(${readErr})—— 那一步是不是根本没跑到 / 任务名或变体改了名?`;
} else if (unparsed.length > 0) {
  state = "unknown";
  why = `有 ${unparsed.length} 份 XML 读不出 \`tests=\` 属性(${unparsed.join(" / ")})—— gradle 换格式了?`;
} else if (suites === 0) {
  state = "unknown";
  why = "目录在,但一份 `TEST-*.xml` 都没有 —— gradle 的 test 任务在一支都没跑时照样 BUILD SUCCESSFUL";
} else if (tests === 0) {
  state = "unknown";
  why = "有测试类、但一支测试都没有 —— 空类也是绿的,这不是「全过」";
} else if (skipped === tests) {
  state = "unknown";
  why = `${tests} 支**全被跳过**(@Ignore?)—— gradle 报绿,而实际一条判据都没执行`;
} else if (failures > 0 || errors > 0) {
  state = "red";
  why = `${failures} 支失败 / ${errors} 支出错`;
} else if (status !== 0) {
  // 测试全过而 gradle 仍非零 —— 编译错、任务外的步骤炸了、daemon 挂了…… 都归判不出。
  state = "unknown";
  why = `${tests} 支全过,但 gradle 退出码是 ${status} —— 红在测试以外的地方(编译?daemon?),别当绿放过去`;
} else {
  state = "green";
  why = `${tests} 支全过(其中跳过 ${skipped}),gradle 退出码 0`;
}

const label = { green: "✅ 绿", red: "❌ 红", unknown: "⚠ 判不出(按红处理)" }[state];
console.log(`结论:${label} —— ${why}`);
console.log("──────────────────────────────────");

// GitHub Actions 的 job summary(有就写,没有就算 —— 本地跑没这个环境变量)。
if (process.env.GITHUB_STEP_SUMMARY) {
  try {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Kotlin JVM 单测(${lineLabel})\n\n${label}\n\n\`\`\`\n${reading}\n${why}\n\`\`\`\n`,
      "utf8",
    );
  } catch {
    // 写不进去不影响判读本身,别为它翻红。
  }
}

process.exit(state === "green" ? 0 : state === "red" ? 1 : 2);

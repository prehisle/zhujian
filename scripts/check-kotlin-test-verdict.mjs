#!/usr/bin/env node
// `kotlin-test-verdict.mjs` 那把尺自己的阴性对照 —— 十刀。
//
// 用法:node scripts/check-kotlin-test-verdict.mjs
//
// **为什么它要有回归网**:那把尺存在的全部理由是「gradle 的 test 任务在一支都没跑的时候
// 照样 BUILD SUCCESSFUL」。⇒ **尺自己失灵的方式也是安静的绿** —— 它一旦把空目录、
// 零测试、全跳过判成绿,CI 上看到的与真跑了 23 支一模一样。同 `check-test-verdict.mjs`
// (那把 e2e 尺的 25 格回归网),本文件是 Kotlin 这一端的同一件事。
//
// ⚠ **样本是真实输出原文**:下面那份 XML 逐字抄自 2026-08-28 本机跑
// `:app:testUniversalDebugUnitTest` 的 `TEST-app.zhujian.notebook.SafPureTest.xml`。
// **动过的只有三处,且都与判据无关**:testcase 列表截短到两条、`hostname` 与 `timestamp`
// 换成占位(那是本机的机器名,没必要进公开仓)。⛔ 属性**顺序与拼写一字未动** —— 那才是
// 这份样本要保的东西(刀⑩量的就是它)。
// ⛔ 它是**冻结**的 —— 本文件证明不了「gradle 哪天不换 XML 格式」,那半靠尺自己的
// fail-closed(读不出 `tests=` 就归判不出,刀⑨)。
//
// ⛔ **每刀先印「XML 真的变成了什么」再印结论** —— 刀没落上与刀被吸收了,屏幕上同形。
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const RULER = join(here, "kotlin-test-verdict.mjs");

// 真实输出原文(2026-08-28 本机,gradle 8.14.3 / AGP;testcase 只留两条示意)。
const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="app.zhujian.notebook.SafPureTest" tests="23" skipped="0" failures="0" errors="0" timestamp="2026-01-01T00:00:00.000Z" hostname="build-host" time="0.186">
  <properties/>
  <testcase name="闸② —— 扩展名不是 zjbak 一律拒" classname="app.zhujian.notebook.SafPureTest" time="0.038"/>
  <testcase name="在飞记录的值域不合法就该被当成损坏" classname="app.zhujian.notebook.SafPureTest" time="0.002"/>
  <system-out><![CDATA[]]></system-out>
  <system-err><![CDATA[]]></system-err>
</testsuite>
`;

function run(dir, status) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [RULER, dir, `--status=${status}`], { encoding: "utf8" }) };
  } catch (e) {
    return { code: e.status, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

// [名字, 怎么改 XML(undefined = 目录不建 / null = 目录留空), gradle 退出码, 期望退出码]
// 退出码口径:0 绿 / 1 红 / 2 判不出。
const KNIVES = [
  ["① 原样 + 退出码 0(**阳性对照**,必须绿,否则下面九刀全部作废)", (x) => x, 0, 0],
  ["② 结果目录根本不在(那一步没跑到 / 任务改了名)", undefined, 0, 2],
  ["③ 目录在但零份 XML(test 任务一支没跑也 BUILD SUCCESSFUL)", null, 0, 2],
  ["④ tests=0(空测试类)", (x) => x.replace(/tests="\d+"/, 'tests="0"'), 0, 2],
  ["⑤ 全被 @Ignore 跳过(skipped == tests)", (x) => x.replace(/skipped="\d+"/, 'skipped="23"'), 0, 2],
  ["⑥ 有失败", (x) => x.replace(/failures="\d+"/, 'failures="2"'), 1, 1],
  ["⑦ 有出错", (x) => x.replace(/errors="\d+"/, 'errors="1"'), 1, 1],
  ["⑧ 测试全过、gradle 却非零(编译错 / daemon 挂了那一形)", (x) => x, 1, 2],
  ["⑨ 读不出 tests= 属性(gradle 换了 XML 格式)", (x) => x.replace(/\btests="\d+"/, ""), 0, 2],
  [
    "⑩ 属性顺序被打乱(**反向刀**:必须仍读得出 ⇒ 仍绿)",
    (x) =>
      x.replace(
        /<testsuite\b[^>]*>/,
        '<testsuite errors="0" skipped="0" name="app.zhujian.notebook.SafPureTest" failures="0" time="0.1" tests="23">',
      ),
    0,
    0,
  ],
];

const base = mkdtempSync(join(tmpdir(), "zj-kotlin-verdict-knives-"));
let pass = 0;
let fail = 0;
console.log(`kotlin-test-verdict.mjs 阴性对照 —— ${KNIVES.length} 刀\n`);
for (const [name, mut, status, want] of KNIVES) {
  const dir = mkdtempSync(join(base, "case-"));
  let shown;
  if (mut === undefined) {
    rmSync(dir, { recursive: true, force: true });
    shown = "(目录已删)";
  } else if (mut === null) {
    shown = "(空目录,零份 XML)";
  } else {
    const x = mut(SAMPLE);
    writeFileSync(join(dir, "TEST-app.zhujian.notebook.SafPureTest.xml"), x, "utf8");
    shown = (x.match(/<testsuite\b[^>]*>/) ?? ["(连开标签都没了)"])[0];
  }
  const r = run(dir, status);
  const verdict = (r.out.match(/^结论:.*$/m) ?? ["(没印结论)"])[0];
  const ok = r.code === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  console.log(`    XML → ${shown}`);
  console.log(`    退出码 ${r.code}(要 ${want}) · ${verdict}`);
}
rmSync(base, { recursive: true, force: true });

console.log(`\n合计:${pass} 过 / ${fail} 不过`);
if (fail > 0) {
  console.error("\n❌ 那把尺失灵了 —— 它判不出上面那几种「安静的绿」。");
  process.exit(1);
}
console.log("✅ 十刀全落上了。");
console.log("⚠ 诚实边界:样本冻结,证明不了 gradle 不换 XML 格式;那半靠尺的 fail-closed(刀⑨)。");

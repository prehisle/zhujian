#!/usr/bin/env node
// 非发版门禁:压 scripts/lib/test-verdict.mjs 那把尺(`flaky-hunt.mjs` 用它判「这趟红没红」)。
// 跑法:node scripts/check-test-verdict.mjs
//
// **它为什么存在**:那把尺原本两处 fail-open —— 读不出就报绿。而它偏偏是用来判
// 「一支测试是不是随机红」的:尺读错了,会把「稳定红」判成「抖动」,或者把「压根没跑」
// 判成「不复现」。⇒ 这里钉住的是**三态**:绿要有正面字据,判不出必须响亮说判不出。
//
// ⭐ 纪律(416 立的那条):下面 fixtures/ 里五份样本是**真的量到的原文**,不是照格式编的 ——
//   · `wdio-9.28-green-tail.txt` = 2026-08-18 本机全量那趟(39 spec/171 例零重试、10:11)
//     日志的**尾巴 12 行**(整份 41 KB,只取到汇总行为止;逐字节,含那个制表符)。
//   · `wdio-9.28-red.txt`       = 同日 439 那把刀造的红,**整份原样**(2.7 KB)。
//   · `libtest-ok.txt` / `libtest-failed.txt` = `rustc --test` 编一支两只测试的样本文件
//     跑出来的原文(一绿一红),退出码 0 / 101。
//   · `libtest-name-typo.txt`   = **本仓 core 的真测试二进制**,`--exact` 给了个不存在的
//     名字 ⇒ `0 passed; … 961 filtered out`,**退出码 0**。这一份就是 fail-open ② 的现场。
// 新格式**必须先在真工具上量到**再往下面加,别照着猜写。
//
// ⚠ 诚实边界:样本是**冻结**的,它证明的是「这把尺今天读得出这几种真实形状」——
//    它**证明不了** wdio / libtest 明天不换格式。挡住换格式那一下的是**运行期 fail-closed**
//    (读不出 ⇒ 判不出 ⇒ 按红处理),不是这个文件。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { libtestVerdict, wdioVerdict } from './lib/test-verdict.mjs';

const fx = (n) => readFileSync(join('scripts', 'fixtures', n), 'utf8');
// ⚠ 仓里 .gitattributes 是 `* text=auto eol=lf` ⇒ **Windows 那台检出来也是 LF**,
// 下面两格不是在补那个洞(别把这条读成「检出会变 CRLF」)。它们防的是**样本来路**:
// 哪天在 Windows 上重新量一份样本重定向进 fixtures/,那份就是 CRLF —— 判据不许因此变脸。
const crlf = (s) => s.replace(/\r?\n/g, '\r\n');

// ── 真实样本(正例):形状读得出、判得对 ──────────────────────────────────
const CASES = [
  // [标题, 判据函数, 输入, 退出码, 期望三态]
  ['真实样本 · wdio 9.28 全绿(39/39,尾巴 12 行)', wdioVerdict, fx('wdio-9.28-green-tail.txt'), 0, 'green'],
  ['真实样本 · wdio 9.28 红(439 那把刀,整份)', wdioVerdict, fx('wdio-9.28-red.txt'), 1, 'red'],
  ['真实样本 · libtest 全绿', libtestVerdict, fx('libtest-ok.txt'), 0, 'green'],
  ['真实样本 · libtest 红(退出码 101)', libtestVerdict, fx('libtest-failed.txt'), 101, 'red'],

  // ⭐ fail-open ② 的现场:退出码 0、零失败,**却一只测试都没跑**
  ['真实样本 · libtest 名字打错 → 判不出(⛔ 绝不许是 green)', libtestVerdict, fx('libtest-name-typo.txt'), 0, 'unknown'],

  // CRLF 来路的样本(见上)
  ['真实样本 · wdio 全绿,CRLF 检出', wdioVerdict, crlf(fx('wdio-9.28-green-tail.txt')), 0, 'green'],
  ['真实样本 · libtest 名字打错,CRLF 检出', libtestVerdict, crlf(fx('libtest-name-typo.txt')), 0, 'unknown'],

  // ── 阴性对照:读不出 / 对不上,一律 unknown,**绝不许退回 green** ──────────
  ['wdio:输出被截断(连汇总行都没有)+ 退出码 0', wdioVerdict, '[wry] 起来了\n(然后什么都没有)\n', 0, 'unknown'],
  ['wdio:空输出 + 退出码 0', wdioVerdict, '', 0, 'unknown'],
  [
    'wdio:只跑完一半就停了(50% completed)',
    wdioVerdict,
    'Spec Files:\t 20 passed, 39 total (50% completed) in 00:05:00\n',
    0,
    'unknown',
  ],
  [
    'wdio:一个 spec 都没跑(--spec 匹配到 0 个)',
    wdioVerdict,
    'Spec Files:\t 0 passed, 0 total (100% completed) in 00:00:00\n',
    0,
    'unknown',
  ],
  [
    'wdio:passed 与 total 对不上(有没数清的格)',
    wdioVerdict,
    'Spec Files:\t 37 passed, 39 total (100% completed) in 00:09:00\n',
    0,
    'unknown',
  ],
  ['libtest:连「test result:」那行都没有 + 退出码 0', libtestVerdict, 'running 0 tests\n', 0, 'unknown'],

  // ⚠ 下面两格是**合成的**(不是量到的真实形),标题里就说清楚 —— 它们存在的理由是
  //    刀下来时发现:上面那两格**各自都被另一条判据兜着**(432 那条「互为备份」的形)。
  //    真实输出里两条判据总是一起响 ⇒ 想让「跑完没跑完」和「FAILED. 那句」各自还有牙齿,
  //    就得各给一格只有它能逮到的输入。⛔ 别把这两格读成「wdio/libtest 会这么印」。
  [
    'wdio(合成):没跑完,但 passed 与 total 恰好自洽 ⇒ 只剩「跑完没跑完」这条在守',
    wdioVerdict,
    'Spec Files:\t 20 passed, 20 total (50% completed) in 00:05:00\n',
    0,
    'unknown',
  ],
  [
    'libtest(合成):换了计数词(failures)⇒ 数不出来了,只剩「FAILED.」那句在守',
    libtestVerdict,
    'test result: FAILED. 1 passed; 1 failures; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n',
    0,
    'red',
  ],

  // ── 「退出码骗人」那一族:汇总说全绿,输出里却有红的记号 ⇒ 必须红 ────────────
  // (这正是本形强制 `--specFileRetries=0` 之外还要看记号的原因:哪天再冒出别的吸收机制)
  [
    'wdio:汇总说 39/39 全过,但输出里有 ✖ 用例 ⇒ 红,不是绿',
    wdioVerdict,
    '[wry #0-1]    ✖ 某只用例的名字\nSpec Files:\t 39 passed, 39 total (100% completed) in 00:10:00\n',
    0,
    'red',
  ],
  [
    'wdio:汇总说全过,但有「FAILED in」⇒ 红',
    wdioVerdict,
    '[0-0] FAILED in undefined - file:///e2e/specs/x.e2e.js\nSpec Files:\t 39 passed, 39 total (100% completed) in 00:10:00\n',
    0,
    'red',
  ],
  [
    'libtest:退出码 0,但输出里有「test result: FAILED.」⇒ 红',
    libtestVerdict,
    'test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n',
    0,
    'red',
  ],
  [
    'libtest:退出码 0、说 ok,但 failed 数不是 0 ⇒ 红',
    libtestVerdict,
    'test result: ok. 1 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n',
    0,
    'red',
  ],
  // ⭐ 顺序:红的字据要先于「一只都没跑」被读到 —— 唯一那只测试红了就是
  //    `0 passed; 1 failed`,判成「判不出」会让 single 形当场停掉,把要抓的红漏掉。
  [
    'libtest:唯一那只红了(0 passed; 1 failed)⇒ 红,不是「一只都没跑」',
    libtestVerdict,
    'test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 960 filtered out; finished in 0.01s\n',
    101,
    'red',
  ],
  [
    'libtest:多印一行时后面那行的红不许漏',
    libtestVerdict,
    'test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n' +
      'test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n',
    0,
    'red',
  ],

  // ── 被杀 / 超时:status 是 null,不许被 `!== 0` 之外的写法漏成绿 ──────────────
  [
    'wdio:被杀(status=null)即使输出看着全绿 ⇒ 红',
    wdioVerdict,
    'Spec Files:\t 39 passed, 39 total (100% completed) in 00:10:00\n',
    null,
    'red',
  ],
  ['libtest:被杀(status=null)⇒ 红', libtestVerdict, fx('libtest-ok.txt'), null, 'red'],

  // ── ignored:也是「没真跑」,同样不许当绿 ────────────────────────────────
  [
    'libtest:那只测试被 #[ignore] 跳过 ⇒ 判不出,不是绿',
    libtestVerdict,
    'test result: ok. 0 passed; 0 failed; 1 ignored; 0 measured; 960 filtered out; finished in 0.00s\n',
    0,
    'unknown',
  ],
];

let fail = 0;
for (const [title, fn, input, status, want] of CASES) {
  const got = fn(input, status);
  const ok = got.state === want;
  if (!ok) fail++;
  console.log(`${ok ? '✅' : '❌'} ${title}`);
  if (!ok) console.log(`     期望 ${want},实得 ${got.state} —— ${got.why}`);
}

// ⭐ 最后一格压的不是形状,是**这三态的用法**:判不出必须与红分开、且都不是绿。
// 单独钉一次,防止哪天有人图省事把 unknown 折进 green(那就是把 fail-open 原样搬回来)。
const states = new Set(['green', 'red', 'unknown']);
const typo = libtestVerdict(fx('libtest-name-typo.txt'), 0);
if (!states.has(typo.state) || typo.state === 'green') {
  fail++;
  console.log('❌ 「一只都没跑」被判成了绿 —— fail-open 又回来了');
} else if (!/没跑/.test(typo.why)) {
  fail++;
  console.log(`❌ 判不出的理由没说清「没跑」这件事:${typo.why}`);
} else {
  console.log('✅ 「一只都没跑」判不出,且理由说得出是「没跑」而不是「不复现」');
}

console.log(fail === 0 ? `\n${CASES.length + 1} 格全过:真实形状读得出,读不出的一律不报绿。` : `\n${fail} 条不符。`);
process.exit(fail === 0 ? 0 : 1);

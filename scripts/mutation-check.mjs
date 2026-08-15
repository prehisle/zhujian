#!/usr/bin/env node
// 变异阴性对照跑手(焊死四轮踩过的坑;配套 skill 见 .claude/skills/mutation-check/)。
//
// 用法:node scripts/mutation-check.mjs --crate core --plan /tmp/plan.mjs [--only <名目子串>]
//
// plan.mjs 形如:
//   export default [
//     { name: '①方向规则恒拨', test: 'exactly_one_side_dials',
//       edits: [{ file: 'src/sync/lan.rs', from: '原文(要唯一命中)', to: '改坏的样子' }] },
//   ]
//   // file 相对 crate 目录;test = cargo test 的过滤词(可空格分隔多只)。
//
// 焊死的四条(全是真栽过的):
//   ① 还原基线只用 git checkout,且**跑前拒绝脏工作区**——259/261 两次栽在这:拷贝快照会吞掉
//      这之后的源码编辑,而没提交就跑会让 checkout 把刚写的断言一并抹掉(于是"绿"是在测旧代码)。
//   ② 每条变异的 from 必须**恰一命中**:0 次(重构后锚点失效)或多次(改坏了别处)一律响亮报出。
//   ③ 判"编译不过"用 `could not compile`,不用 /^error/——cargo 测试失败也印 `error: test failed`,
//      会把真红误判成变异无效(255)。
//   ④ 只看退出码非零不算数,必须**红在预期那只测试上**(256)——否则"变异碰红了别的测试、目标
//      测试其实抓不住"会被记成通过。
// 另:还原挂在 exit/信号/异常三处;收尾自查 git status,残留变异绝不留在工作区(256)。

import fs from 'fs';
import path from 'path';
import { execSync, execFileSync } from 'child_process';

const argv = process.argv.slice(2);
const arg = (k, dflt) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : dflt;
};
const crate = arg('--crate');
const planPath = arg('--plan');
const only = arg('--only');
if (!crate || !planPath) {
  console.error('用法: node scripts/mutation-check.mjs --crate <crate 目录> --plan <plan.mjs> [--only <名目子串>]');
  process.exit(2);
}

const repo = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
const crateDir = path.resolve(repo, crate);
const plan = (await import(path.isAbsolute(planPath) ? `file://${planPath}` : `file://${path.resolve(planPath)}`)).default;
if (!Array.isArray(plan) || plan.length === 0) throw new Error('plan 必须导出一个非空数组');

const files = [...new Set(plan.flatMap((m) => m.edits.map((e) => path.posix.join(crate, e.file))))];
const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

// ---- ① 跑前必须干净(否则 checkout 会抹掉未提交的改动) ----
const dirty = git(['status', '--porcelain', '--', ...files]).trim();
if (dirty) {
  console.error('工作区不干净,拒绝开跑——本脚本以 `git checkout` 为还原基线,会把这些改动一并抹掉:');
  console.error(dirty);
  console.error('\n先 `git commit`(或 stash)再来。');
  process.exit(2);
}

let restored = false;
const restore = () => {
  if (restored) return;
  try {
    git(['checkout', '--', ...files]);
  } catch (e) {
    console.error('!! 还原失败,手动跑:git checkout -- ' + files.join(' '));
  }
};
process.on('exit', restore);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    restore();
    process.exit(130);
  });
}
process.on('uncaughtException', (e) => {
  restore();
  console.error(e);
  process.exit(1);
});

const results = [];
for (const m of plan) {
  if (only && !m.name.includes(only)) continue;
  git(['checkout', '--', ...files]);

  // ---- ② from 必须恰一命中 ----
  let applied = true;
  for (const e of m.edits) {
    const f = path.join(crateDir, e.file);
    const src = fs.readFileSync(f, 'utf8');
    const hits = src.split(e.from).length - 1;
    if (hits !== 1) {
      results.push({ name: m.name, verdict: `锚点命中 ${hits} 次(要求恰 1)`, ok: false });
      applied = false;
      break;
    }
    fs.writeFileSync(f, src.split(e.from).join(e.to));
  }
  if (!applied) {
    console.log(`  ${results.at(-1).verdict}  ${m.name}`);
    continue;
  }

  // ---- 跑目标测试 ----
  let out = '';
  let code = 0;
  try {
    out = execSync(`cargo test --lib -- ${m.test}`, { cwd: crateDir, encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    code = err.status ?? 1;
    out = String(err.stdout || '') + String(err.stderr || '');
  }

  // ---- ③④ 判定 ----
  let verdict;
  let ok;
  if (code === 0) {
    verdict = '绿(假绿!这条规则没人守)';
    ok = false;
  } else if (/could not compile/.test(out)) {
    verdict = '编译不过(变异无效,换个改法)';
    ok = false;
  } else {
    // `#[should_panic]` 的行形是 `test <名> - should panic ... FAILED`(多出中间那段),
    // 按 `test <名> ... FAILED` 认会把它当成「无 FAILED 行」——变异明明红在预期那只测上,
    // 却被判成不过(367 片3 ⑭ 实栽)。中间那段设成可选,别放宽 `\S+` 那一格。
    const failed = [...out.matchAll(/^test (\S+)(?: - should panic)? \.\.\. FAILED$/gm)].map(
      (x) => x[1]
    );
    const wanted = m.test.split(/\s+/).filter(Boolean);
    const hit = failed.filter((t) => wanted.some((w) => t.includes(w)));
    if (hit.length === 0) {
      verdict = `红了,但红的不是预期那只(实见:${failed.join(', ') || '无 FAILED 行'})`;
      ok = false;
    } else {
      verdict = `红 ✓(${hit.join(', ')})`;
      ok = true;
    }
  }
  results.push({ name: m.name, verdict, ok });
  console.log(`  ${verdict}  ${m.name}  [${m.test}]`);
}

git(['checkout', '--', ...files]);
restored = true;

console.log('\n==== 汇总 ====');
for (const r of results) console.log(`  ${r.ok ? '红 ✓' : '**不过**'}  ${r.name}  —— ${r.verdict}`);
const bad = results.filter((r) => !r.ok);
// ---- 收尾自查:残留变异绝不留在工作区 ----
const left = git(['status', '--porcelain', '--', ...files]).trim();
console.log(`\n还原后:${left || '(干净)'}`);
if (left) {
  console.error('!! 还有残留,立刻手动还原');
  process.exit(1);
}
console.log(bad.length === 0 ? `\n全部 ${results.length} 条真红。` : `\n${bad.length}/${results.length} 条没过,逐条看上面。`);
process.exit(bad.length === 0 ? 0 : 1);

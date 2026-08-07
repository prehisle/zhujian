#!/usr/bin/env node
// flaky-hunt —— 复现「随机红」的测试。**两种负载形,一种抓不全**(313 实测:有一只
// 在隔离形下连跑 45 次全绿,只有整套并行才红;另一只反过来一抓一个准)。
//
//   node scripts/flaky-hunt.mjs suite  --crate core [--rounds 14]
//   node scripts/flaky-hunt.mjs single --crate core [--rounds 12] [--load 14] <测试名>...
//
// * suite  = 整套反复跑(真并行 + 真服务器)。红了把整份输出存进 tmp-flaky/,并按
//            「失败用例名」汇总 —— 同族的别的成员往往就是这么露出来的(313 送了两只)。
// * single = 单只用例反复跑 + N 个占满 CPU 的空转进程制造调度饥饿。
//
// 判读与修法见 memory `flaky-test-three-shapes` 与 progress-log 313。
// ⚠ 修完必须**在原来那种负载形下**逐只复跑,并跑 `mutation-check` 证明它还能红
//   —— 修 flaky 最容易的失手是把牙齿一起磨掉。

import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const mode = argv.shift();
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? dflt : argv.splice(i, 2)[1];
};
const crate = opt('crate', 'core');
const rounds = Number(opt('rounds', mode === 'suite' ? 14 : 12));
const load = Number(opt('load', 14));
const tests = argv.filter((a) => !a.startsWith('--'));

if (!['suite', 'single'].includes(mode)) {
  console.error('用法:node scripts/flaky-hunt.mjs suite|single --crate core [...]');
  process.exit(2);
}
if (mode === 'single' && tests.length === 0) {
  console.error('single 形要点名至少一只测试(全名,如 sync::transport::tests::foo)');
  process.exit(2);
}

// 测试二进制走 `cargo test --no-run` 自己报的路径,别去猜 deps 下的文件名(带哈希、
// 还与集成测的二进制混在一起)。顺带保证「跑的东西与当前源码一致」。
function libTestBinary() {
  const out = spawnSync('cargo', ['test', '--lib', '--no-run', '--message-format=json'], {
    cwd: crate,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  if (out.status !== 0) {
    console.error(out.stderr ?? '');
    throw new Error('cargo test --lib --no-run 失败');
  }
  const exes = out.stdout
    .split(/\r?\n/)
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l))
    .filter((m) => m.reason === 'compiler-artifact' && m.executable)
    .filter((m) => (m.target?.kind ?? []).includes('lib'))
    .map((m) => m.executable);
  if (exes.length === 0) throw new Error('cargo 没报出 lib 测试二进制');
  return exes[exes.length - 1];
}

// **把二进制复制走再跑**:跑一轮十几分钟,期间谁 cargo build 一下就把它换掉了。
const bin = libTestBinary();
const frozen = join(tmpdir(), `flaky-hunt-${process.pid}.exe`);
copyFileSync(bin, frozen);
console.log(`跑的是 ${bin} 的一份冻结副本`);
mkdirSync('tmp-flaky', { recursive: true });

const tally = new Map();
const bump = (k) => tally.set(k, (tally.get(k) ?? 0) + 1);

if (mode === 'suite') {
  for (let r = 0; r < rounds; r++) {
    const res = spawnSync(frozen, [], { encoding: 'utf8', timeout: 900_000 });
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    if (res.status === 0) {
      console.log(`轮 ${r + 1}/${rounds} 全绿`);
      continue;
    }
    // cargo 的 failures 段每行是四个空格 + 用例全名。
    const names = [...new Set([...out.matchAll(/^ {4}(\S+)$/gm)].map((m) => m[1]))];
    names.forEach(bump);
    writeFileSync(join('tmp-flaky', `suite-r${r}.txt`), out);
    console.log(`轮 ${r + 1}/${rounds} 红:${names.join(', ')}(输出存 tmp-flaky/suite-r${r}.txt)`);
  }
} else {
  const loaders = [];
  for (let i = 0; i < load; i++) {
    loaders.push(
      spawn(process.execPath, ['-e', 'while(true){Math.sqrt(Math.random())}'], { stdio: 'ignore' }),
    );
  }
  try {
    for (let r = 0; r < rounds; r++) {
      for (const t of tests) {
        const res = spawnSync(frozen, ['--exact', t, '--nocapture', '--test-threads', '1'], {
          encoding: 'utf8',
          timeout: 300_000,
        });
        if (res.status === 0) continue;
        bump(t);
        writeFileSync(
          join('tmp-flaky', `${t.replaceAll('::', '_')}-r${r}.txt`),
          `${res.stdout ?? ''}${res.stderr ?? ''}`,
        );
      }
      const line = tests
        .map((t) => `${t.split('::').pop()}=${r + 1 - (tally.get(t) ?? 0)}/${r + 1}`)
        .join(' ');
      console.log(`轮 ${r + 1}/${rounds} ${line}`);
    }
  } finally {
    loaders.forEach((p) => p.kill());
  }
}

console.log('\n==== 汇总(红过几轮)====');
if (tally.size === 0) {
  console.log('一轮不红。⚠ 全绿不等于没病 —— 换另一种负载形再跑一遍。');
} else {
  for (const [k, v] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${v} 轮  ${k}`);
}
process.exit(tally.size === 0 ? 0 : 1);

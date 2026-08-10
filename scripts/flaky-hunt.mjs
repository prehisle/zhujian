#!/usr/bin/env node
// flaky-hunt —— 复现「随机红」的测试。**两种负载形,一种抓不全**(313 实测:有一只
// 在隔离形下连跑 45 次全绿,只有整套并行才红;另一只反过来一抓一个准)。
//
//   node scripts/flaky-hunt.mjs suite  --crate core [--rounds 14]
//   node scripts/flaky-hunt.mjs single --crate core [--rounds 12] [--load 14] <测试名>...
//   node scripts/flaky-hunt.mjs e2e    [--rounds 6] [--spec compose-recovery] [--load 0]
//
// * suite  = 整套反复跑(真并行 + 真服务器)。红了把整份输出存进 tmp-flaky/,并按
//            「失败用例名」汇总 —— 同族的别的成员往往就是这么露出来的(313 送了两只)。
// * single = 单只用例反复跑 + N 个占满 CPU 的空转进程制造调度饥饿。
// * e2e    = 真 GUI 那一层(331 排队第 2 条)。与上面两形的关键差别是**强制
//            `--specFileRetries=0`**:仓里 wdio.conf.js 常态开着 1 次重试(164 立的,
//            用来吸收冷启假红),而**被 retry 吸收的红不会进任何人的视野** —— 331 那
//            只 compose-recovery 就是这么在「35/35 全绿」里藏了一整轮。本形还额外
//            **按输出里的 FAILED 行判红、不只看退出码**,免得哪天又冒出别的吸收机制。
//
// 判读与修法见 memory `flaky-test-three-shapes` 与 progress-log 313 / 331。
// ⚠ 修完必须**在原来那种负载形下**逐只复跑,并跑 `mutation-check`(e2e 侧=手工变异
//   生产代码)证明它还能红 —— 修 flaky 最容易的失手是把牙齿一起磨掉。

import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';

const argv = process.argv.slice(2);
const mode = argv.shift();
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? dflt : argv.splice(i, 2)[1];
};
const crate = opt('crate', 'core');
const rounds = Number(opt('rounds', mode === 'single' ? 12 : mode === 'e2e' ? 6 : 14));
// e2e 默认不加负载:那一层跑的是真 GUI + 真 WebView,空转进程一多就整套超时,红出来的
// 是工装自己造的假红。要制造调度饥饿再显式 `--load N`,并把结论按「加了负载」读。
const load = Number(opt('load', mode === 'e2e' ? 0 : 14));
const spec = opt('spec', null);
const tests = argv.filter((a) => !a.startsWith('--'));

if (!['suite', 'single', 'e2e'].includes(mode)) {
  console.error('用法:node scripts/flaky-hunt.mjs suite|single --crate core [...] | e2e [--spec 名]');
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

// ---- e2e 形 --------------------------------------------------------------------
// 前置有两道人手闸,而跑错一整轮的代价是十几分钟 —— 所以先探再跑(wdio.conf.js 自己也
// fail-fast,但它要等 cargo build 跑完才报):
//   ① vite 必须已在 :1420(fast 模式的前端来源,另一终端 `npm run dev`,别用 tauri dev)
//   ② 生产朱笺必须已退出 —— 它占着 Ctrl+Alt+N 全局热键,e2e 的 app 启动注册热键即 panic,
//      整套报一片「target window already closed」,与被测代码毫无关系。
function portOpen(port) {
  return new Promise((res) => {
    const sock = net.connect({ host: 'localhost', port });
    sock.on('connect', () => {
      sock.destroy();
      res(true);
    });
    sock.on('error', () => res(false));
  });
}

function productionAppRunning() {
  if (process.platform !== 'win32') return false;
  // spawnSync 不经 shell —— 别让 Git Bash 把 `/FI` 当路径转换掉(MSYS 斜杠开关坑)。
  const out = spawnSync('tasklist', ['/FI', 'IMAGENAME eq zhujian.exe'], { encoding: 'utf8' });
  return (out.stdout ?? '').includes('zhujian.exe');
}

async function runE2e() {
  if (!(await portOpen(1420))) {
    console.error('vite 没起:先在另一终端跑 `npm run dev`(只起 vite,别用 tauri dev)');
    process.exit(2);
  }
  if (productionAppRunning()) {
    console.error('生产朱笺还开着:它占着 Ctrl+Alt+N,e2e 的 app 注册热键即 panic —— 先退出它');
    process.exit(2);
  }
  // **绝对路径**:wdio 把 `--spec` 的相对路径解析成相对 config 所在目录(e2e/),传
  // `e2e/specs/x.e2e.js` 会变成 `e2e/e2e/specs/x.e2e.js`。而且匹配不到文件时 wdio 只
  // WARN 一句、照样起一个 worker 去 require 那个不存在的模块,报出来的错长得很像「测试
  // 失败」—— 第一次实跑就栽在这:三轮全红,红的其实是我的用法。故先自己 fail-fast。
  const specArg = [];
  if (spec) {
    const p = resolve(spec.includes('.e2e.js') ? spec : join('e2e', 'specs', `${spec}.e2e.js`));
    if (!existsSync(p)) {
      console.error(`没有这个 spec:${p}`);
      process.exit(2);
    }
    specArg.push(p);
  }
  const loaders = [];
  for (let i = 0; i < load; i++) {
    loaders.push(
      spawn(process.execPath, ['-e', 'while(true){Math.sqrt(Math.random())}'], { stdio: 'ignore' }),
    );
  }
  console.log(
    `e2e ${rounds} 轮${spec ? ` · 只跑 ${spec}` : ' · 整套'}${load ? ` · 负载 ${load}` : ''} · 重试已强制关掉`,
  );
  try {
    for (let r = 0; r < rounds; r++) {
      const t0 = Date.now();
      const res = spawnSync(
        process.execPath,
        [
          resolve('node_modules/@wdio/cli/bin/wdio.js'),
          'run',
          'e2e/wdio.conf.js',
          '--specFileRetries=0', // ← 本形的核心:不许把红吸收掉(331 排队第 3 条)
          ...(specArg.length ? ['--spec', ...specArg] : []),
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, YS_E2E_FAST: '1' },
          timeout: 1_800_000,
          maxBuffer: 1 << 28,
        },
      );
      const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
      const secs = Math.round((Date.now() - t0) / 1000);
      // **判红不只看退出码**:哪天再冒出别的「吸收」机制(retry / 容忍阈值),退出码会
      // 骗人,而输出里的 FAILED / ✖ 不会。两者取或。
      const sawFailed = /\bFAILED in\b/.test(out) || /[✖✗×]\s+\S/.test(out);
      if (res.status === 0 && !sawFailed) {
        console.log(`轮 ${r + 1}/${rounds} 全绿(${secs}s)`);
        continue;
      }
      // 逐行状态机:含 .e2e.js 的行更新「当前 spec」,✖ 行记一笔 —— 用例名单独看认不出
      // 是哪个 spec 的(几个 spec 的用例名很像)。
      let cur = '(未知 spec)';
      const hits = [];
      for (const line of out.split(/\r?\n/)) {
        const s = line.match(/([^\\/\s]+\.e2e\.js)/);
        if (s) {
          cur = s[1];
          continue;
        }
        const f = line.match(/[✖✗×]\s+(.+?)\s*$/);
        if (f) hits.push(`${cur} › ${f[1].trim()}`);
      }
      // 兜底 key 不带轮号 —— 带了就每轮各占一行,汇总的「红过几轮」全变成 1。
      if (hits.length === 0) hits.push('(红但没解析出用例名,看 tmp-flaky/ 里那一轮的日志)');
      [...new Set(hits)].forEach(bump);
      writeFileSync(join('tmp-flaky', `e2e-r${r}.txt`), out);
      console.log(
        `轮 ${r + 1}/${rounds} 红(${secs}s):${[...new Set(hits)].join(' | ')}(输出存 tmp-flaky/e2e-r${r}.txt)`,
      );
    }
  } finally {
    loaders.forEach((p) => p.kill());
  }
}

mkdirSync('tmp-flaky', { recursive: true });

const tally = new Map();
const bump = (k) => tally.set(k, (tally.get(k) ?? 0) + 1);

// **把二进制复制走再跑**:跑一轮十几分钟,期间谁 cargo build 一下就把它换掉了。
// (e2e 形跑的是 wdio,不碰 cargo 测试二进制。)
let frozen = null;
if (mode !== 'e2e') {
  const bin = libTestBinary();
  frozen = join(tmpdir(), `flaky-hunt-${process.pid}.exe`);
  copyFileSync(bin, frozen);
  console.log(`跑的是 ${bin} 的一份冻结副本`);
}

if (mode === 'e2e') {
  await runE2e();
} else if (mode === 'suite') {
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

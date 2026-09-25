// 无界面对端的最小冒烟(746):起本地 syncd → 对端建号出码 → 新建一张卡 → 退出;
// 再核两刀「非本地地址 / 不给地址」都在联网前拒启。
//
// 用法(仓根):先 `cd core && cargo build --example headless-peer`、
// `cd server && cargo build --release`,再 `node core/examples/headless-peer-smoke.mjs`。
// 通过打 `SMOKE PASS` 退 0;任何一格不对打原因退 1。临时目录在系统 tmp 下,收场删掉。
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';
import readline from 'node:readline';

const root = resolve(import.meta.dirname, '..', '..');
const exe = process.platform === 'win32' ? '.exe' : '';
const PEER = join(root, 'core/target/debug/examples', `headless-peer${exe}`);
const SYNCD = join(root, 'server/target/release', `zhujian-syncd${exe}`);
for (const p of [PEER, SYNCD]) if (!existsSync(p)) fail(`缺二进制 ${p}(见文件头的构建命令)`);

const PORT = 18000 + Math.floor(Math.random() * 1000);
const URL = `ws://127.0.0.1:${PORT}`;
const tmp = mkdtempSync(join(tmpdir(), 'zj-peer-smoke-'));
const sdir = join(tmp, 'srv');
const pdir = join(tmp, 'peer');
mkdirSync(sdir, { recursive: true });
writeFileSync(join(sdir, 'banlist.txt'), '# 空封禁表\n');

let syncd;
function fail(msg) {
  console.error(`SMOKE FAIL ${msg}`);
  try { syncd?.kill(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(1);
}

// 刀:地址闸在联网前拒启(退 2、打 FATAL)。
for (const args of [['--dir', pdir], ['--server', 'ws://10.0.0.1:1', '--dir', pdir], ['--server', `wss://127.0.0.1:${PORT}`, '--dir', pdir]]) {
  const r = spawnSync(PEER, args, { encoding: 'utf8', timeout: 10_000 });
  if (r.status !== 2 || !/FATAL/.test(r.stderr)) fail(`应拒启 ${JSON.stringify(args)}:status=${r.status} stderr=${r.stderr}`);
  console.log(`refused ${JSON.stringify(args)} → ${r.stderr.trim()}`);
}

syncd = spawn(SYNCD, ['--listen', `127.0.0.1:${PORT}`, '--data-dir', sdir], { stdio: 'ignore' });
const up = await new Promise((res) => {
  const t0 = Date.now();
  const tryOnce = () => {
    const s = net.connect(PORT, '127.0.0.1', () => { s.destroy(); res(true); });
    s.on('error', () => (Date.now() - t0 > 10_000 ? res(false) : setTimeout(tryOnce, 200)));
  };
  tryOnce();
});
if (!up) fail('syncd 10 s 内没起来');

const peer = spawn(PEER, ['--server', URL, '--dir', pdir], { stdio: ['pipe', 'pipe', 'inherit'] });
const seen = { account: false, online: false, code: null, created: null, bye: false };
const timer = setTimeout(() => fail(`30 s 超时:${JSON.stringify(seen)}`), 30_000);
const rl = readline.createInterface({ input: peer.stdout });
rl.on('line', (line) => {
  console.log(`peer| ${line}`);
  if (line.startsWith('ACCOUNT created ')) seen.account = true;
  if (!seen.online && /^EV status state=online /.test(line)) {
    seen.online = true;
    peer.stdin.write('pair\n');
  }
  const code = line.match(/^CODE (\S+)/);
  if (code) { seen.code = code[1]; peer.stdin.write('new 冒烟卡\n'); }
  const made = line.match(/^OK new (\S+)/);
  if (made) { seen.created = made[1]; peer.stdin.write('quit\n'); }
  if (line === 'BYE') seen.bye = true;
});
const exitCode = await new Promise((res) => peer.on('exit', res));
clearTimeout(timer);
syncd.kill();
rmSync(tmp, { recursive: true, force: true });
if (exitCode !== 0 || !seen.account || !seen.online || !seen.code || !seen.created || !seen.bye) {
  fail(`exit=${exitCode} ${JSON.stringify(seen)}`);
}
console.log(`SMOKE PASS code=${seen.code} item=${seen.created}`);

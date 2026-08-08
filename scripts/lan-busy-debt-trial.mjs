// 321(§12.1 活性缺口收口)的真机台架驱动 —— lan-direct-plan §11 末那条
// 「只跑一条压缩后的决定性场景」。判据链:
//   选择性 BUSY → 本机 BROADCAST ops 撞 busy 置债 → 心跳重建广播 Hello(小帧通得过)
//   → 真对端回 Want → 本机登记定向 work → 撞 busy 让位 → 经现存 LAN 到达。
//
// 台架前提(dev-and-testing「怎么造服务端持续 busy 态」):
//   busy-syncd --listen 0.0.0.0:8787 --budget-global-bytes B(Hello 通、Ops 拒)
//   手机 adb reverse tcp:8787 tcp:8787,两端服务器地址 ws://127.0.0.1:8787
//   桌面 CDP 9223、手机 CDP 9222(先 node scripts/android-cdp.mjs forward)
//
// 用法:
//   node scripts/lan-busy-debt-trial.mjs status --desktop-space D --phone-space P
//   node scripts/lan-busy-debt-trial.mjs write  --desktop-space D --tag T --count N [--chars M]
//   node scripts/lan-busy-debt-trial.mjs watch  --desktop-space D --phone-space P --tag T --count N [--seconds S]
//   node scripts/lan-busy-debt-trial.mjs tally  --desktop-space D --phone-space P --tag T
//
// ⚠ 所有 CDP eval 一律包 IIFE:同一执行上下文复用,裸 `const` 第二次即整条报错(294/295 实踩)。
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);
const argv = process.argv.slice(3);
const cmd = process.argv[2];
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const DS = arg("--desktop-space");
const PS = arg("--phone-space");
const TAG = arg("--tag");
const COUNT = Number(arg("--count", "0"));
const CHARS = Number(arg("--chars", "4000"));
const SECONDS = Number(arg("--seconds", "105"));
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(port, pick) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const t = list.find((x) => x.type === "page" && x.webSocketDebuggerUrl && pick(x.url));
  if (!t) throw new Error(`${port} 上无匹配 page target:` + list.map((x) => x.url).join(", "));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", () => rej(new Error(`ws 连不上 ${port}`)), { once: true });
  });
  let seq = 0;
  const evaluate = (expression, timeoutMs = 120000) =>
    new Promise((res, rej) => {
      const id = ++seq;
      const to = setTimeout(() => rej(new Error(`CDP 超时(${port})`)), timeoutMs);
      const on = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id !== id) return;
        clearTimeout(to);
        ws.removeEventListener("message", on);
        if (m.error) return rej(new Error(JSON.stringify(m.error)));
        if (m.result.exceptionDetails)
          return rej(new Error("页面异常:" + JSON.stringify(m.result.exceptionDetails)));
        res(m.result.result.value);
      };
      ws.addEventListener("message", on);
      ws.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    });
  return { evaluate, close: () => ws.close() };
}

const STATUS_JS = (space) =>
  `(async()=>{const s=await window.__TAURI_INTERNALS__.invoke("sync_status",{spaceId:${J(space)}});` +
  `return JSON.stringify({state:s.state,lan:s.lan_peers,peers:s.peers_online,err:s.error,` +
  `notice:s.ops_notice,warn:s.lan_warning,dis:s.lan_disabled,frozen:s.frozen,susp:s.suspended})})()`;

// 每条内容形如 `T-000 xxxx…`,前缀即唯一键(条数 ∧ 唯一键双重对账)。
const KEYS_JS = (space, tag) =>
  `(async()=>{const r=await window.__TAURI_INTERNALS__.invoke("search_notes",{spaceId:${J(space)},query:${J(tag + "-")}});` +
  `const ks=r.map(h=>(h.content||"").slice(0,${(TAG || "").length + 4})).filter(k=>k.startsWith(${J(tag + "-")}));` +
  `return JSON.stringify({n:ks.length,uniq:new Set(ks).size,keys:ks.sort()})})()`;

// 24618 的真 TCP 态(不经我们自己的代码,最硬的地面真相)。
async function netstat24618() {
  const { stdout } = await pexec("netstat", ["-ano"], { maxBuffer: 1 << 24 });
  const lines = stdout.split(/\r?\n/).filter((l) => l.includes(":24618"));
  const est = lines.filter((l) => /ESTABLISHED/.test(l));
  const tw = lines.filter((l) => /TIME_WAIT/.test(l));
  // 取「本地 24618 ↔ 远端 ip:port」那一对,链路同一性看远端端口有没有变。
  const peers = est
    .map((l) => l.trim().split(/\s+/))
    .map((c) => ({ local: c[1], remote: c[2] }))
    .map((p) => (p.local.endsWith(":24618") ? p.remote : p.local));
  return { est: est.length, timeWait: tw.length, peers };
}

const stamp = () => new Date().toISOString().slice(11, 23);

if (cmd === "status") {
  const d = await connect(9223, (u) => u.includes("notebook"));
  const p = await connect(9222, () => true);
  const ds = JSON.parse(await d.evaluate(STATUS_JS(DS)));
  const ps = JSON.parse(await p.evaluate(STATUS_JS(PS)));
  console.log(stamp(), "桌面", J(ds));
  console.log(stamp(), "手机", J(ps));
  console.log(stamp(), "netstat", J(await netstat24618()));
  d.close();
  p.close();
} else if (cmd === "write") {
  if (!DS || !TAG || !COUNT) throw new Error("write 需要 --desktop-space --tag --count");
  const d = await connect(9223, (u) => u.includes("notebook"));
  const t0 = Date.now();
  const n = await d.evaluate(
    // capture_note 有前台空间闸(lib.rs:99),先把落点切过去。
    `(async()=>{const inv=window.__TAURI_INTERNALS__.invoke;await inv("set_foreground_space",{spaceId:${J(DS)}});` +
      `const pad="x".repeat(${CHARS});let k=0;` +
      `for(let i=0;i<${COUNT};i++){await inv("capture_note",{spaceId:${J(DS)},` +
      `content:${J(TAG)}+"-"+String(i).padStart(3,"0")+" "+pad});k++}return k})()`,
  );
  console.log(stamp(), `已写 ${n} 条(每条 ${CHARS} 字符),用时 ${Date.now() - t0}ms`);
  d.close();
} else if (cmd === "watch") {
  if (!DS || !PS || !TAG || !COUNT) throw new Error("watch 需要 --desktop-space --phone-space --tag --count");
  const d = await connect(9223, (u) => u.includes("notebook"));
  const p = await connect(9222, () => true);
  const t0 = Date.now();
  let done = null;
  while (Date.now() - t0 < SECONDS * 1000) {
    const [ds, ps, ns] = await Promise.all([
      d.evaluate(STATUS_JS(DS)).then(JSON.parse),
      p.evaluate(STATUS_JS(PS)).then(JSON.parse),
      netstat24618(),
    ]);
    const hits = JSON.parse(await p.evaluate(KEYS_JS(PS, TAG)));
    const el = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `${stamp()} +${el}s hits=${hits.n}/${COUNT} uniq=${hits.uniq} | 桌面 ${ds.state}/lan${ds.lan}/peers${ds.peers} err=${ds.err} notice=${ds.notice}` +
        ` | 手机 ${ps.state}/lan${ps.lan}/peers${ps.peers} err=${ps.err} notice=${ps.notice}` +
        ` | tcp est=${ns.est} tw=${ns.timeWait} ${ns.peers.join(",")}`,
    );
    if (hits.n >= COUNT && done === null) {
      done = Date.now() - t0;
      console.log(`✅ 全批到达 @ +${(done / 1000).toFixed(1)}s`);
      break;
    }
    // 2s 一拍:每拍的 search_notes 要把整批正文经 IPC 端到端搬一遍,1s 会让轮询
    // 本身成为手机侧的负载(105s 窗口下 2s 分辨率绰绰有余)。
    await sleep(2000);
  }
  if (done === null) {
    console.log(`❌ ${SECONDS}s 内未到齐`);
    // 退出码非零(322 实现审 L2):只印 ❌ 的话,一串进 PowerShell / CI / 验收脚本
    // 就成了假绿 —— 上游看见 exit 0 会当这一格过了。
    process.exitCode = 1;
  }
  d.close();
  p.close();
} else if (cmd === "tally") {
  const d = await connect(9223, (u) => u.includes("notebook"));
  const p = await connect(9222, () => true);
  const dk = JSON.parse(await d.evaluate(KEYS_JS(DS, TAG)));
  const pk = JSON.parse(await p.evaluate(KEYS_JS(PS, TAG)));
  const missing = dk.keys.filter((k) => !pk.keys.includes(k));
  const extra = pk.keys.filter((k) => !dk.keys.includes(k));
  const pass =
    dk.n === pk.n && dk.n === dk.uniq && pk.n === pk.uniq && missing.length === 0 && extra.length === 0;
  console.log(
    J({
      desktop: { n: dk.n, uniq: dk.uniq },
      phone: { n: pk.n, uniq: pk.uniq },
      missing,
      extra,
      pass,
    }),
  );
  // 对账不过 = 退出码非零(322 实现审 L2):`"pass": false` 只有人盯着终端才读得到。
  if (!pass) process.exitCode = 1;
  d.close();
  p.close();
} else {
  throw new Error(`未知子命令 ${cmd};见文件头用法`);
}

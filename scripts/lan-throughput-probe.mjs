// 局域网原始吞吐基线(L-d「大图直传耗时」的对照组)。
//
// 为什么需要它:测出「9MB 走直连要 37s」之后,单靠这个数分不清是**代码慢**还是**这段
// wifi 就这么快**。本探针在桌面起一个只发随机字节的 HTTP 服务,让手机去拉同样大小,
// 量的是这两台机之间 TCP 的天花板——判据链路上的独立一跳(262 教训)。
//
// 取数腿走 **`adb shell curl`**(295 修:首版走的是「手机 WebView 里 fetch」,在 vivo
// V2352GA 上恒 `TypeError: Failed to fetch`——WebView 拦 https 页面发起的明文请求。
// dev-and-testing 里写的本来就是 curl,是脚本跟文档漂了)。curl 那条腿**不需要 devtools
// 包、也不需要 app 在前台**,故它同时是更省事的那条。curl 不在时才回落 CDP fetch。
//
// ⚠⚠ 取数腿**必须异步 exec,绝不能用 `execSync`/`execFileSync`**(295 定位,销掉 294
// 记的那条「未定位」悬案):被拉的 HTTP 服务就跑在**本进程**里,同步 exec 把事件循环
// 整个堵死 → 服务器永远回不了手机那一发 curl → 挂满超时。294 当时「换成经 bash 一条
// 命令下去 0.85s 就通」,正是因为那时 bash 是**另一个进程**、node 那边的服务还在转。
// 现象是「同一条命令,手跑通、脚本里挂」——很容易误读成 adb 或引号的锅,其实是自锁。
//
// 用法:node scripts/lan-throughput-probe.mjs [--mb 9] [--port 24619] [--host <本机内网IP>]
// 前置:手机与桌面同 wifi;回落腿才需要 devtools 包 + android-cdp.mjs forward(tcp:9222)。
// 端口入站若被 Windows 防火墙挡,先加临时放行规则,收尾记得删。
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const MB = Number(arg("--mb", "9"));
const PORT = Number(arg("--port", "24619"));

const payload = Buffer.allocUnsafe(MB * 1024 * 1024);
for (let i = 0; i < payload.length; i += 4) payload.writeUInt32LE((i * 2654435761) >>> 0, i);

const server = createServer((req, res) => {
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": String(payload.length),
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  });
  res.end(payload);
});
await new Promise((r) => server.listen(PORT, "0.0.0.0", r));

// 本机在直连子网里的地址:手机拨的是哪个,这里就该用哪个。多网卡(VPN / 虚拟机 / 蜂窝共享)
// 时首个候选未必对——候选全打印在下面那行,拿不准就显式 `--host <本机内网IP>`,别让它猜。
const { networkInterfaces } = await import("node:os");
const addrs = Object.values(networkInterfaces())
  .flat()
  .filter((n) => n && n.family === "IPv4" && !n.internal)
  .map((n) => n.address);
const host = arg("--host", addrs[0]);
console.log(`服务已起:http://${host}:${PORT}/  (${MB} MB)  本机候选地址 ${addrs.join(", ")}`);

// ① 正路:手机 curl 拉。整条命令交给 shell(见文件头那条 ⚠)。
const url = `http://${host}:${PORT}/`;
try {
  // 单引号是给**设备侧** sh 看的;`execFile` 不经宿主 shell,故 Windows 的 cmd.exe
  // 不会来插一脚(`execSync` 默认走 ComSpec,单引号原样进 curl → 它去解析一个叫
  // `'http:` 的主机名,DNS 慢慢超时,又是一种「看着像挂住」的假象)。
  const { stdout } = await execFileAsync(
    "adb",
    ["shell", `curl -s -o /dev/null -w '%{size_download} %{time_total}' '${url}'`],
    { encoding: "utf8", timeout: 180000 },
  );
  const raw = stdout.trim();
  const [bytesStr, secStr] = raw.split(/\s+/);
  const bytes = Number(bytesStr);
  const sec = Number(secStr);
  if (!Number.isFinite(bytes) || !Number.isFinite(sec) || bytes <= 0 || sec <= 0) {
    throw new Error(`curl 回了读不懂的东西:${JSON.stringify(raw)}`);
  }
  // 字节数必须对得上——短读会让 MB/s 虚高,那正是这个探针最不该出的错。
  if (bytes !== payload.length) {
    throw new Error(`curl 只收到 ${bytes} 字节,应为 ${payload.length}(短读,数不可用)`);
  }
  server.close();
  console.log(
    `手机 curl 结果:${JSON.stringify({
      bytes,
      ms: Math.round(sec * 1000),
      MiBps: +(bytes / 1024 / 1024 / sec).toFixed(2),
    })}`,
  );
  process.exit(0);
} catch (e) {
  console.warn(`⚠ adb curl 那条腿没走通(${e.message.split("\n")[0]}),回落 CDP fetch —— 回落腿要 devtools 包 + forward tcp:9222 且 app 在前台`);
}

// ② 回落:手机 WebView 里 fetch(在有的机型上会被 WebView 的明文策略拦掉)。
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const t = list.find((x) => x.type === "page" && x.webSocketDebuggerUrl);
if (!t) throw new Error("手机无 page target(先 android-cdp.mjs forward,且 app 在前台)");
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res, { once: true });
  ws.addEventListener("error", () => rej(new Error("手机 ws 连不上")), { once: true });
});
const out = await new Promise((res, rej) => {
  const to = setTimeout(() => rej(new Error("CDP 超时")), 180000);
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id !== 1) return;
    clearTimeout(to);
    res(m.result);
  });
  ws.send(
    JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: {
        expression: `(async()=>{
          const t0=Date.now();
          const r=await fetch("http://${host}:${PORT}/?t="+t0,{cache:"no-store"});
          const b=await r.arrayBuffer();
          const ms=Date.now()-t0;
          return JSON.stringify({bytes:b.byteLength, ms, MBps:+(b.byteLength/1024/1024/(ms/1000)).toFixed(2)});
        })()`,
        awaitPromise: true,
        returnByValue: true,
      },
    }),
  );
});
ws.close();
server.close();
if (out.exceptionDetails) throw new Error("手机页面异常:" + JSON.stringify(out.exceptionDetails));
console.log("手机 fetch 结果:" + out.result.value);

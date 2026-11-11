// 161(W4「设置与连接」走查,用户 2026-11-06 全取推荐)手机那组 M2 —— 同步 / 设备 / 配对 / 加入 / 被移除 / 断网 —— 的真机回归网。
// 驱动形:自己起一台本机同步服务器(`server/target/{release,debug}/zhujian-syncd.exe`,临时数据目录 + admin 口)、`adb reverse`,
// 用户动作一律 `adb input`(真点 / 真返回键);CDP 只读状态、摆前置(往框里写地址 / 码)、量样式。
//
//   node scripts/android-cdp.mjs forward
//   node scripts/cdp-acceptance-walk161-m2.mjs                 # 打印 {pass, steps};设了 ANDROID_SERIAL 就只认那一台
//   node scripts/cdp-acceptance-walk161-m2.mjs --only S7,S8    # 只跑点名那几段(阴性对照用)
//   node scripts/cdp-acceptance-walk161-m2.mjs --inject-css '<css>'  # 样式阴性刀:页内注入,对应那几格应当红
//   node scripts/cdp-acceptance-walk161-m2.mjs --ohos --only S5,S11   # 鸿蒙真机(879 加):adb 那几手换成 hdc —— 真点走
//        `uitest uiInput click`、返回键 `uitest uiInput keyEvent Back`、前台查 `aa dump -l`、端口 `hdc rport`;9222 的转发照
//        skill `zhujian-ohos-verify` 自己建。⚠ 鸿蒙上问不到「软键盘起着没有」⇒ dropIme 改成页内 blur(收键盘不经返回键)。
//
// 逐段(编号对 .zjshots/W4-walk/清单.md):
//  S0  Q2 / Q1 / Q15 / A27 / A50 / A33:没开同步的同步页第一屏那几句、「用配对码加入」、地址框有标签 + 弹网址键盘 + 框下那行说明跟着值变;
//      空间页「加入空间」两枚是白钮、钮名都以「加入空间」开头、说明第一句「另成一本」;配对码框占位给出长相;
//      表单收起再展开码清掉、地址照 Q3 重填;「全部同步」是白钮、文字没有「逐空间追赶」;开空间页时上次那行结果收掉。
//  S1  建一个测试空间(⛔ 全程不碰主空间与用户已有的空间;收尾把它连同 S9 加入的那本一起重置掉 = 删库文件)。
//  S2  Q2 / Q15 / Q3:在测试空间里建账户(本机服务器)→ 回执写明是哪一本的账户;状态「已连接 · 另有 0 台设备在线」、点是实心;
//      本机记下「最近一次连上的服务器」。
//  S3  A7 = Q7 / A49 / A30 / Q16:设备名单里本机是唯一一台管理设备 ⇒ 没有「退出账户」、换成那行灰字;不对它说「建议再设一台」;
//      收着的行有箭头;没起名的那行编号只写一遍、下面一句去哪儿起名;「复制完整编号」。
//  S4  Q16 / A42:「添加设备」出码 ⇒ 写「到 HH:MM 失效」,钮变「重新出码」。
//  S5  A41:拿这一本自己的码去「加入空间」⇒ 人话「这台上已经有这个账户的一本了(「<测试空间名>」)…重置…」,不说「空间=账户」;
//      164:同一句也留在 `#join-err`(提示条几秒就走、换面就收)。
//  S6  A27 / A42 / Q3:码的样子不对 ⇒ 说长相、不说「槽号」、不挂原文;样子对但不存在 ⇒ 「重新出码」+「核对服务器地址」。
//  S7  A8 / Q14 / A33:停服务器 ⇒ 点变空心圈、「现在重连」在;那行错误带图标、原文降一档;名单「刷新」留下的那句在断开期间不来回闪;
//      起回服务器、点「现在重连」⇒ 0.5 秒内就去连(不等退避)、连上后「已重新连上」、名单那句收掉。
//  S11 164:S5 那条长错误条在换到同步面时已收 ⇒ 不手动收、直接真点「重新出码」就出新码(改前那一下被条吃掉)。
//      A38(主控收口补的手机半):无界面对端拿这台出的码加入 ⇒ 名单里点开它那一行:移除前的说明照指南一句不省(第三条「账户密钥和
//      那份完整副本也拿不回来」排在「不删它的」之后)、末尾「想彻底隔离…移除不够」+ 一枚「意见反馈」;真点它 ⇒ 开设置、「意见反馈」那一节
//      在屏上(等备份那一节画完再量);返回键 ⇒ 回同步面。
//  S10 M1 留下的那条:一篇长文都没有时,记一笔 →「长文」→ 一个字不写退出 ⇒ 回到随记、面收起。
//  S8  Q12 被拒:服务器吊销这台 ⇒ 同步页「这台已不在这个账户里(被移出,或账户被停用)」、不写「重连中」、收起「添加设备」与名单、
//      不给「现在重连」;随记页顶挂同一句;空间页那一行标「已不再同步」;「重置」确认点出「之后在这台记的那几条只在这里」;重置后账清掉。
//  S9  Q12 自己退出 / Q13:无界面对端(`core/target/debug/examples/headless-peer.exe`,没编就 SKIPPED 并印怎么编)建号出码 →
//      空间页「加入空间(输入配对码)」⇒ 回执「对方那本没起过名,这里先叫…」+「改名」;它不是管理设备 ⇒ 名单里能「退出账户」⇒
//      同步页「你已退出这个账户」(不是「被移出」)。
//
// 前置:devtools 包、app 在前台、首启告知已同意、界面语言中文、竖屏手机宽、没开任何面、没有正在跑的另一台本机服务器占着 ZJ_M2_PORT(默认 8797)。
//   本资产会:建 / 删两个测试空间、在本机服务器上建两个一次性账户、临时改写 `zhujian.last-server`(收尾还原)。⛔ 不碰主空间的数据。
//
// 诚实边界:
//  ① 另一台改别名名单跟着换(A14)、两本同名的回执(Q13 后半)、电脑那头「移除」(Q12 走的是服务器吊销这条等价路:手机收到的是同一句
//     AUTH_FAILED)—— 要第二台有界面的设备,真机 + 桌面隔离实例手走过,截图在 .zjshots/W4-fix/M2/。
//  ② 「已重新连上」只说这一句:状态里没有待发条数,「断开时记的已发出」证不了(没写)。
//  ③ 断网造的是「服务器停了」;只断手机那一形(`adb reverse --remove` + `adb reconnect`)和真断 Wi-Fi 没在这里跑。
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const PORT = 9222;
const PKG = "app.zhujian.notebook";
const SYNC_PORT = Number(process.env.ZJ_M2_PORT ?? 8797);
const ADMIN_PORT = SYNC_PORT + 1;
const URL_ = `ws://127.0.0.1:${SYNC_PORT}`;
const argv = process.argv.slice(2);
const ONLY = argv.includes("--only") ? new Set(argv[argv.indexOf("--only") + 1].split(",")) : null;
const INJECT_CSS = argv.includes("--inject-css") ? argv[argv.indexOf("--inject-css") + 1] : null;
const on = (s) => ONLY === null || ONLY.has(s);
const execFileAsync = promisify(execFile);
const OHOS = argv.includes("--ohos");
const adb = (args) => execFileAsync("adb", args, { encoding: "utf8", maxBuffer: 1 << 24 });
// hdc 路径与 `ohos-drive.mjs` / `cdp-run.mjs` 同一个环境变量、同一个默认值。
const hdc = (args) => execFileAsync(process.env.OHOS_HDC ?? "G:\\ohos-sdk\\toolchains\\hdc.exe", args, { encoding: "utf8", maxBuffer: 1 << 24 });
/** 设备上的一下真点(物理像素)。 */
const devTap = (x, y) => (OHOS ? hdc(["shell", `uitest uiInput click ${x} ${y}`]) : adb(["shell", "input", "tap", String(x), String(y)]));
const portUp = () => (OHOS ? hdc(["rport", `tcp:${SYNC_PORT}`, `tcp:${SYNC_PORT}`]) : adb(["reverse", `tcp:${SYNC_PORT}`, `tcp:${SYNC_PORT}`]));
const portDown = () => (OHOS ? hdc(["fport", "rm", `tcp:${SYNC_PORT}`, `tcp:${SYNC_PORT}`]) : adb(["reverse", "--remove", `tcp:${SYNC_PORT}`]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SYNCD = ["release", "debug"].map((p) => join(ROOT, `server/target/${p}/zhujian-syncd.exe`)).find(existsSync);
const PEER = join(ROOT, "core/target/debug/examples/headless-peer.exe");

async function focusedPkg() {
  if (OHOS) {
    // 同 cdp-run.mjs::ohosAppState:按 `Mission ID #` 切块、只认本包那一块(⛔ 别全文搜 FOREGROUND)。
    const out = await hdc(["shell", "aa dump -l"]).catch(() => null);
    for (const block of (out?.stdout ?? "").split(/^\s*Mission ID #/m).slice(1)) {
      if (block.includes(`bundle name [${PKG}]`)) return /app state #FOREGROUND/.test(block) ? PKG : "(朱简在后台)";
    }
    return null;
  }
  const out = await adb(["shell", "dumpsys", "window"]).catch(() => null);
  const m = out?.stdout.match(/mCurrentFocus=Window\{\S+ \S+ ([^/\s}]+)/);
  return m ? m[1] : null;
}
async function imeShown() {
  const out = await adb(["shell", "dumpsys", "input_method"]).catch(() => null);
  const m = out?.stdout.match(/mInputShown=(true|false)/);
  return m ? m[1] === "true" : null;
}
const back = () => (OHOS ? hdc(["shell", "uitest uiInput keyEvent Back"]) : adb(["shell", "input", "keyevent", "4"]));
let blurIme = null; // 鸿蒙:main() 里接上页内 blur
async function dropIme() {
  if (OHOS) return blurIme?.();
  if (await imeShown()) {
    await back();
    await sleep(700);
  }
}

async function connect() {
  for (let i = 0; i < 20; i++) {
    const r = await fetch(`http://127.0.0.1:${PORT}/json`).catch(() => null);
    const page = r ? (await r.json()).find((t) => t.type === "page" && t.webSocketDebuggerUrl) : null;
    if (page) {
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((res, rej) => {
        ws.addEventListener("open", res, { once: true });
        ws.addEventListener("error", () => rej(new Error("ws 连接失败")), { once: true });
      });
      let id = 0;
      const send = (method, params) =>
        new Promise((res, rej) => {
          const myId = ++id;
          const to = setTimeout(() => rej(new Error(`CDP 超时: ${method}`)), 30000);
          const onMsg = (ev) => {
            const m = JSON.parse(ev.data);
            if (m.id !== myId) return;
            ws.removeEventListener("message", onMsg);
            clearTimeout(to);
            if (m.error) return rej(new Error(`${method}: ${JSON.stringify(m.error)}`));
            res(m.result);
          };
          ws.addEventListener("message", onMsg);
          ws.send(JSON.stringify({ id: myId, method, params }));
        });
      return { send, close: () => ws.close() };
    }
    await sleep(500);
  }
  throw new Error("无 page target——先 `node scripts/android-cdp.mjs forward`,且 app 在前台");
}

// ── 本机同步服务器(临时目录;admin 口用来「吊销这台」)────────────────────────────────
const SRV_DIR = join(tmpdir(), `zj-m2-syncd-${process.pid}`);
const TOKEN = randomBytes(32).toString("hex");
let srv = null;
async function startServer() {
  mkdirSync(SRV_DIR, { recursive: true });
  writeFileSync(join(SRV_DIR, "banlist.txt"), "# 空\n");
  writeFileSync(join(SRV_DIR, "admin-token"), TOKEN);
  srv = spawn(SYNCD, ["--listen", `127.0.0.1:${SYNC_PORT}`, "--admin-listen", `127.0.0.1:${ADMIN_PORT}`, "--admin-token-file", join(SRV_DIR, "admin-token"), "--data-dir", SRV_DIR], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error("本机同步服务器 10 秒没起来")), 10000);
    // 日志走哪一路没约定(量过是 stderr),两路都听。
    const onLog = (b) => {
      if (String(b).includes("监听 ws://")) {
        clearTimeout(to);
        res();
      }
    };
    srv.stdout.on("data", onLog);
    srv.stderr.on("data", onLog);
    srv.on("exit", (c) => rej(new Error(`本机同步服务器退出了(${c});端口 ${SYNC_PORT} 被占?`)));
  });
}
async function stopServer() {
  if (!srv) return;
  const p = srv;
  srv = null;
  p.kill();
  await new Promise((r) => (p.exitCode !== null ? r() : p.once("exit", r)));
}
async function revoke(device) {
  const r = await fetch(`http://127.0.0.1:${ADMIN_PORT}/admin/revoke?device=${device}`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } });
  return `${r.status} ${(await r.text()).trim()}`;
}

// ── 无界面对端(S9)───────────────────────────────────────────────────────────────
let peer = null;
let peerOut = "";
async function startPeer(extra = [], tag = "") {
  const dir = join(tmpdir(), `zj-m2-peer-${process.pid}${tag}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  peerOut = "";
  peer = spawn(PEER, ["--server", URL_, "--dir", dir, ...extra], { stdio: ["pipe", "pipe", "pipe"] });
  peer.stdout.on("data", (b) => (peerOut += String(b)));
  peer.stderr.on("data", (b) => (peerOut += String(b)));
  // ⚠ 认 `state=online`,别认裸的 `online` —— 状态行里还有一格 `peers_online=0`,连接中那一行就会被认成上线(真栽过)。
  // 用码加入(`--join`)要先从这台手机引导一遍 ⇒ 多给一些时间。
  for (let i = 0; i < (extra.length ? 160 : 60) && !/EV status state=online/.test(peerOut); i++) await sleep(250);
  if (!/EV status state=online/.test(peerOut)) throw new Error(`对端没上线:${peerOut.slice(-400)}`);
}
async function peerCode() {
  const before = peerOut.length;
  peer.stdin.write("pair\n");
  for (let i = 0; i < 60; i++) {
    const m = /CODE (\S+)/.exec(peerOut.slice(before));
    if (m) return m[1];
    await sleep(200);
  }
  throw new Error(`对端没出码:${peerOut.slice(before)}`);
}
function stopPeer() {
  if (!peer) return;
  const p = peer;
  peer = null;
  try {
    p.stdin.end("quit\n");
  } catch {}
  setTimeout(() => p.kill(), 1500).unref();
}

const out = { pass: false, steps: [] };

const main = async () => {
  const step = (name, ok, detail = "") => {
    out.steps.push({ name, ok: ok === "skip" ? "SKIPPED" : !!ok, detail: String(detail).slice(0, 600) });
    return !!ok;
  };
  if (!SYNCD) return step("前置-本机同步服务器编过", false, "先 cd server && cargo build --release");
  let cdp = await connect();
  const evalJs = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`页内异常: ${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
    return r.result.value;
  };
  if (OHOS) blurIme = () => evalJs(`(()=>{const a=document.activeElement;if(a&&a!==document.body)a.blur();return 1})()`).then(() => sleep(500));
  const inv = (cmd, args = {}) => evalJs(`window.__TAURI__.core.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
  const until = async (expr, ms = 4000) => {
    const t0 = Date.now();
    for (;;) {
      if (await evalJs(expr).catch(() => false)) return true;
      if (Date.now() - t0 > ms) return false;
      await sleep(150);
    }
  };
  const FIXED = /^#(settings-toggle|sync-toggle|search-toggle|topics-toggle|capture-fab|space-chip)$|^#bottombar |^#error |^#confirmbar/;
  const centerDev = async (sel) => {
    if (!FIXED.test(sel)) await evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(e)e.scrollIntoView({block:"center"});return 1})()`);
    let last = null;
    for (let i = 0; i < 20; i++) {
      await sleep(120);
      const r = JSON.parse(
        await evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return "null";
          const r=e.getBoundingClientRect();if(!r.width)return "null";
          return JSON.stringify([r.top,Math.round((r.x+r.width/2)*devicePixelRatio),Math.round((r.y+r.height/2)*devicePixelRatio)])})()`),
      );
      if (!r) return null;
      if (last && last[0] === r[0]) return [r[1], r[2]];
      last = r;
    }
    return last ? [last[1], last[2]] : null;
  };
  const tapSel = async (sel) => {
    const c = await centerDev(sel);
    if (!c) {
      const why = await evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return "没有这个元素";const r=e.getBoundingClientRect();
        const chain=[];for(let x=e;x&&x!==document.body;x=x.parentElement)if(x.hidden||getComputedStyle(x).display==="none")chain.push(x.id||x.className);
        return JSON.stringify({w:r.width,h:r.height,hiddenBy:chain,pane:document.body.className})})()`).catch(() => "?");
      throw new Error(`找不到(或没画出来)${sel}:${why}`);
    }
    await devTap(c[0], c[1]);
  };
  /** 两拍确认:点第一枚、等确认条、同一口气点「是」(6 秒窗口;skill:第二拍前现取坐标)。 */
  const tapConfirm = async (sel) => {
    await tapSel(sel);
    if (!(await until(`!document.getElementById("confirmbar").hidden`, 3000))) throw new Error("确认条没出来");
    await sleep(350);
    await tapSel("#confirmbar-yes");
  };
  const setVal = (sel, v) =>
    evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});e.value=${JSON.stringify(v)};e.dispatchEvent(new Event("input",{bubbles:true}));return e.value})()`);
  const txt = (sel) => evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});return e?e.innerText:null})()`);
  const hid = (id) => evalJs(`document.getElementById(${JSON.stringify(id)}).hidden`);
  const paneIs = (id) => `(!document.getElementById(${JSON.stringify(id)}).hidden&&document.body.classList.contains("pane-open"))`;
  const curSpace = () => evalJs(`(async()=>(await window.__TAURI__.core.invoke("list_spaces")).find(x=>x.current).id)()`);
  const status = async () => inv("sync_status", { spaceId: await curSpace() });
  // 提示条的每一句(含一闪而过的),页内记账。
  const watchBars = () =>
    evalJs(`(()=>{window.__m2bars=[];const e=document.getElementById("error");if(window.__m2mo)window.__m2mo.disconnect();
      window.__m2mo=new MutationObserver(()=>{if(!e.hidden&&e.textContent)window.__m2bars.push(e.textContent)});
      window.__m2mo.observe(e,{childList:true,subtree:true,characterData:true,attributes:true});return 1})()`);
  const bars = () => evalJs(`(window.__m2bars||[]).join(" ‖ ")`);
  const closePanes = async () => {
    if (await evalJs(`document.body.classList.contains("pane-open")`)) {
      await tapSel(`#bottombar [data-mode="ideas"]`);
      await until(`!document.body.classList.contains("pane-open")`, 3000);
    }
  };
  const openPaneVia = async (id, toggle) => {
    if (await evalJs(paneIs(id))) return;
    await closePanes();
    await tapSel(toggle);
    await until(paneIs(id), 3000);
  };
  const openSpaces = async () => {
    if (await evalJs(paneIs("spaces"))) return;
    await closePanes();
    if (!(await hid("space-chip"))) await tapSel("#space-chip");
    else {
      await tapSel("#sync-toggle");
      await until(paneIs("sync"), 3000);
      await tapSel("#sync-spaces-btn");
    }
    await until(paneIs("spaces"), 3000);
  };
  const injectKnife = async () => {
    if (!INJECT_CSS) return;
    await evalJs(`(()=>{let k=document.getElementById("m2-knife");if(!k){k=document.createElement("style");k.id="m2-knife";document.head.appendChild(k)}k.textContent=${JSON.stringify(INJECT_CSS)};return 1})()`);
  };

  // ── 前置 ────────────────────────────────────────────────────────────────────
  if (!step("前置-app 在前台", (await focusedPkg()) === PKG, await focusedPkg())) return;
  if (!step("前置-界面语言中文", (await evalJs(`document.documentElement.lang`)) === "zh")) return;
  if (!step("前置-首启告知已同意", (await evalJs(`document.documentElement.dataset.privacy`)) === "ok")) return;
  await injectKnife();
  await dropIme();
  await closePanes();
  const homeSpace = await curSpace();
  const savedLast = await evalJs(`localStorage.getItem("zhujian.last-server")`);
  const created = []; // 本资产建出来 / 加入的空间,收尾全部重置(删库文件)
  await startServer();
  await portUp();
  await watchBars();

  try {
    // ── S0:没开同步那一屏 + 空间页那一组(在一本没开同步的空间里看:先建测试空间再看,免得依赖用户主空间的状态)──
    const NAME = `M2验收${randomBytes(2).toString("hex")}`;
    {
      // S1:建测试空间(真点「新建」;建好即切过去)
      await openSpaces();
      await setVal("#space-new-name", NAME);
      await tapSel("#space-create");
      const ok = await until(`document.getElementById("space-chip").textContent===${JSON.stringify(NAME)}`, 6000);
      const sid = await curSpace();
      if (ok && sid !== homeSpace) created.push(sid);
      if (!step("S1 测试空间建好并切过去", ok && sid !== homeSpace, `${NAME} ${sid}`)) return;
    }
    if (on("S0")) {
      await evalJs(`localStorage.removeItem("zhujian.last-server");1`);
      await openPaneVia("sync", "#sync-toggle");
      const intro = await txt('[data-i18n="sync.introOff"]');
      step("S0 Q2 第一屏:可选 / 只在这台 / 卸载就没了 / 先在本机加密", !(await hid("sync-join")) && /可选/.test(intro) && /只存在这台/.test(intro) && /卸载就没了/.test(intro) && /加密/.test(intro), intro);
      await tapSel("#sync-alt-create");
      await until(`!document.getElementById("sync-server-row").hidden`, 2000);
      await dropIme();
      const f = await evalJs(`(()=>{const i=document.getElementById("sync-server");const l=document.querySelector('label[for="sync-server"]');
        return {v:i.value,mode:i.inputMode,label:l&&l.textContent,hint:document.getElementById("sync-server-hint").textContent}})()`);
      step("S0 Q2 地址框有标签「服务器地址」、弹网址键盘", f.label === "服务器地址" && f.mode === "url", JSON.stringify(f));
      step("S0 Q3 从没连上过 ⇒ 预填官方那台,框下说「官方服务器,一般不用改」", /^wss:\/\/sync\.zhujian\.(app|cool)$/.test(f.v) && /^官方服务器,一般不用改/.test(f.hint), JSON.stringify(f));
      await setVal("#sync-server", URL_);
      step("S0 Q2 改成别的地址 ⇒ 那一行说「不是官方服务器:…另一套」", /^不是官方服务器/.test(await txt("#sync-server-hint")), await txt("#sync-server-hint"));
      await openSpaces();
      const g = await evalJs(`(()=>{const s=document.getElementById("join-scan-btn"),a=document.getElementById("join-alt-btn"),all=document.getElementById("sync-all-btn");
        return {scan:s.textContent,alt:a.textContent,scanGhost:s.classList.contains("ghost"),altGhost:a.classList.contains("ghost"),allGhost:all.classList.contains("ghost"),allText:all.textContent,
          note:document.querySelector('[data-i18n="shell.joinNote"]').textContent,res:document.getElementById("sync-all-result").textContent}})()`);
      step("S0 Q1 加入那一组是白钮、钮名以「加入空间」开头", g.scanGhost && g.altGhost && /^加入空间/.test(g.scan) && g.alt === "加入空间(输入配对码)", JSON.stringify(g));
      // 165 M1 A34 起「手机」改说「这台设备」(同步第一屏那组同改)。
      step("S0 Q1 说明第一句「另成一本,这台设备上现在这本不会并进去」", /^加入空间 = 另成一本,这台设备上现在这本不会并进去/.test(g.note), g.note);
      step("S0 A33 「全部同步」白钮、不说「逐空间追赶」;开页时没有上次那行", g.allGhost && !/逐空间|追赶/.test(g.allText) && g.res === "", JSON.stringify(g));
      await tapSel("#join-alt-btn");
      await until(`!document.getElementById("join-form").hidden`, 2000);
      await dropIme();
      const j = await evalJs(`(()=>({ph:document.getElementById("join-code").placeholder,l1:document.querySelector('label[for="join-server"]')?.textContent,l2:document.querySelector('label[for="join-code"]')?.textContent,mode:document.getElementById("join-server").inputMode}))()`);
      step("S0 A27 / A50 两个框都有标签、码框先给长相", j.l1 === "服务器地址" && j.l2 === "配对码" && /123456789-XXXX-XXXX/.test(j.ph) && j.mode === "url", JSON.stringify(j));
      await setVal("#join-code", "111111111-AAAA-BBBB");
      await setVal("#join-server", "ws://127.0.0.1:1");
      await tapSel("#join-alt-btn");
      await sleep(400);
      await tapSel("#join-alt-btn");
      await sleep(400);
      await dropIme();
      const k = await evalJs(`({c:document.getElementById("join-code").value,s:document.getElementById("join-server").value})`);
      step("S0 A50 收起再展开:码清掉、地址照 Q3 重填", k.c === "" && k.s !== "ws://127.0.0.1:1", JSON.stringify(k));
      // 没开同步的空间点「全部同步」:提示条说、不留在页上(A33 / WM-33)—— ⚠ 只有本机一本同步都没开时才落这一形;用户机上有开的就跳过
      const anySynced = await evalJs(`(async()=>(await window.__TAURI__.core.invoke("list_spaces")).some(x=>x.configured))()`);
      if (anySynced) step("S0 A33 没开同步时点「全部同步」走提示条", "skip", "本机已有开了同步的空间");
      else {
        await evalJs(`window.__m2bars=[];1`);
        await tapSel("#sync-all-btn");
        await sleep(1500);
        const b = await bars();
        step("S0 A33 没开同步时点「全部同步」走提示条、页上不留", /没有哪一本开了同步/.test(b) && (await txt("#sync-all-result")) === "" && !/属预期/.test(b), b);
      }
    }

    // ── S2:建账户 ──
    if (on("S2") || on("S3") || on("S4") || on("S5") || on("S11") || on("S7") || on("S8") || on("S10")) {
      await openPaneVia("sync", "#sync-toggle");
      if (await hid("sync-create")) await tapSel("#sync-alt-create");
      await until(`!document.getElementById("sync-create").hidden`, 2000);
      await dropIme();
      await setVal("#sync-server", URL_);
      await evalJs(`window.__m2bars=[];1`);
      await tapSel("#sync-create-btn");
      const online = await until(`/^已连接 · 另有 0 台设备在线/.test(document.getElementById("sync-state").innerText)`, 15000);
      const b = await bars();
      step("S2 Q2 回执写明是哪一本的账户", b.includes(`「${NAME}」的账户已创建`), b);
      step("S2 Q15 状态「已连接 · 另有 0 台设备在线」", online, await txt("#sync-state"));
      const dot = await evalJs(`(()=>{const d=getComputedStyle(document.getElementById("sync-dot"));return {bg:d.backgroundColor,bw:d.borderTopWidth}})()`);
      step("S2 Q14 连着时点是实心", dot.bg !== "rgba(0, 0, 0, 0)" && parseFloat(dot.bw) === 0, JSON.stringify(dot));
      step("S2 Q3 记下这台最近一次连上的服务器", (await evalJs(`localStorage.getItem("zhujian.last-server")`)) === URL_);
    }

    if (on("S3")) {
      await openPaneVia("sync", "#sync-toggle");
      if (await hid("sync-devices")) await tapSel("#sync-devices-btn");
      await until(`!!document.querySelector("#sync-devices .dev-row[data-dev]")`, 6000);
      const c = await evalJs(`(()=>{const r=document.querySelector("#sync-devices .dev-row[data-dev]");return {txt:r.innerText,chev:!!r.querySelector(".dev-chev"),mono:!!r.querySelector(".dev-name.mono"),sid:!!r.querySelector(".dev-sid"),hint:r.querySelector(".dev-hint")?.textContent,head:document.getElementById("sync-devices").innerText}})()`);
      step("S3 A49 收着的行有箭头", c.chev, JSON.stringify(c));
      step("S3 A30 / Q16 没起名的那行编号只写一遍、下面说去哪儿起名", c.mono && !c.sid && /设置 → 本机别名/.test(c.hint ?? ""), JSON.stringify(c));
      step("S3 A49 不对唯一一台说「建议再设一台管理设备」(这台不在两台以上的名单里)", !/建议再设一台管理设备/.test(c.head), c.head);
      await tapSel("#sync-devices .dev-row[data-dev]");
      await until(`!!document.querySelector("#sync-devices .dev-row.open")`, 2000);
      const o = await evalJs(`(()=>{const r=document.querySelector("#sync-devices .dev-row.open");return {leave:!!r.querySelector('[data-act="Remove"]'),txt:r.innerText,copy:r.querySelector("[data-copy]")?.textContent}})()`);
      step("S3 A7 唯一一台管理设备:没有「退出账户」,换成那行灰字", !o.leave && /这是账户里唯一的管理设备,不能退出;要退,先把另一台设成管理设备/.test(o.txt) && !/本机将无法再经服务器同步/.test(o.txt), o.txt);
      step("S3 A30 「复制完整编号」", o.copy === "复制完整编号", o.copy);
      await tapSel("#sync-devices .dev-head");
    }

    let ownCode = null;
    if (on("S4") || on("S5")) {
      await openPaneVia("sync", "#sync-toggle");
      await tapSel("#sync-invite-btn");
      const ok = await until(`!document.getElementById("sync-pair-out").hidden`, 10000);
      const n = await txt("#sync-pair-note");
      const btn = await txt("#sync-invite-btn");
      ownCode = await evalJs(`(()=>{const v=[...document.querySelectorAll("#sync-pair-kv .v")];return v[1]?v[1].textContent:null})()`);
      step("S4 Q16 出码页写「到 HH:MM 失效」、不写「10 分钟内有效」", ok && /到 \d{2}:\d{2} 失效/.test(n) && !/10 分钟内有效/.test(n), n);
      step("S4 N-3 出码页说明不只写电脑", /另一台设备/.test(n) && /用配对码加入/.test(n) && /加入空间\(输入配对码\)/.test(n), n);
      step("S4 A42 码在屏上时那枚钮叫「重新出码」", btn === "重新出码", btn);
    }

    const joinWith = async (code) => {
      await openSpaces();
      if (await hid("join-form")) await tapSel("#join-alt-btn");
      await until(`!document.getElementById("join-form").hidden`, 2000);
      await dropIme();
      await setVal("#join-server", URL_);
      await setVal("#join-code", code);
      // 上一条提示条可能还挂着(读秒没走完):先收掉、清账,这一下之后冒出来的才是这一次的(skill:提示条会串味)。
      await evalJs(`(()=>{const e=document.getElementById("error");e.hidden=true;e.textContent="";e.classList.remove("retiring");window.__m2bars=[];return 1})()`);
      await tapSel("#join-go");
    };
    if (on("S5") && ownCode) {
      await joinWith(ownCode);
      await until(`(window.__m2bars||[]).length>0`, 8000);
      await sleep(300);
      const b = await bars();
      step("S5 A41 同一个账户再加入:人话指出这台已有那一本、先重置,不说「空间=账户」", b.includes(`这台上已经有这个账户的一本了(「${NAME}」)`) && /重置/.test(b) && !/^[^(]*空间=账户/.test(b), b);
      // 164:那句四五行的原话也留在加入那一块里(提示条几秒就走,而且换面就收)
      const je = await evalJs(`(()=>{const e=document.getElementById("join-err");return e.hidden?null:e.textContent})()`);
      step("S5 164 加入失败的原话留在 #join-err", je !== null && je.includes(`这台上已经有这个账户的一本了(「${NAME}」)`), String(je));
    }

    if (on("S11")) {
      if (!existsSync(PEER)) step("S11 A38 移除确认一句不省 + 意见反馈", "skip", "没有无界面对端:cd core && cargo build --example headless-peer");
      else {
        await openPaneVia("sync", "#sync-toggle");
        // 码已在屏上(S4 出的那枚,S5 已经拿它撞过一次)时这枚叫「重新出码」⇒ 等**换了一枚**再读,别读到旧的。
        const codeNow = `(()=>{const o=document.getElementById("sync-pair-out");if(o.hidden)return null;const v=[...document.querySelectorAll("#sync-pair-kv .v")];return v[1]?v[1].textContent:null})()`;
        const oldCode = await evalJs(codeNow);
        // 164:S5 留下的那条提示条(A41 那句长,四五行)从前挂着读秒跟到这一面、正盖在这枚钮上 —— 真点只收了提示条、钮一下没收到。
        //   现在换面 / 关面就收错误条(要读完的那句留在 #join-err)⇒ ⛔ 别再手动收它,直接真点才是这条的回归。
        const barNow = await evalJs(`(()=>{const e=document.getElementById("error");return e.hidden?null:{cls:e.className,txt:e.textContent.slice(0,40)}})()`);
        step("S11 164 换到同步面时上一面的错误条已收", barNow === null || /notice|neutral|with-act/.test(barNow.cls), JSON.stringify(barNow));
        await tapSel("#sync-invite-btn");
        const fresh = await until(`(${codeNow})!==null&&(${codeNow})!==${JSON.stringify(oldCode)}`, 10000);
        const code = await evalJs(codeNow);
        if (!step("S11 前置-出了一枚新码", fresh, `码=${code} 旧码=${oldCode} 钮=${await txt("#sync-invite-btn")} 提示条=${await bars()}`)) throw new Error("S11 前置不成");
        try {
          await startPeer(["--join", code], "-s11");
        } catch (e) {
          step("S11 前置-对端用码加入", false, `码=${code} 旧码=${oldCode} ${e.message}`);
          throw e;
        }
        if (await hid("sync-devices")) await tapSel("#sync-devices-btn");
        const two = await until(`document.querySelectorAll("#sync-devices .dev-row[data-dev]").length>=2`, 15000);
        // 对端那行 = 没有「本机」徽章的那一行(徽章 .dev-badge 不带 .admin 的那枚)
        const other = await evalJs(`(()=>{const r=[...document.querySelectorAll("#sync-devices .dev-row[data-dev]")].find(x=>!x.querySelector(".dev-badge:not(.admin)"));return r?r.dataset.dev:null})()`);
        if (!step("S11 前置-对端用码加入、名单里出现第二台", two && other, `${code} ${other} ${peerOut.slice(-300)}`)) throw new Error("S11 前置不成");
        await tapSel(`#sync-devices .dev-row[data-dev="${other}"]`);
        await until(`!!document.querySelector("#sync-devices .dev-row.open .dev-isolate")`, 3000);
        const f = await evalJs(`(()=>{const r=document.querySelector("#sync-devices .dev-row.open");return {li:[...r.querySelectorAll(".dev-facts li")].map(x=>x.textContent),iso:r.querySelector(".dev-isolate")?.innerText,isoShown:(r.querySelector(".dev-isolate")?.getClientRects().length??0)>0,go:r.querySelector("[data-feedback]")?.textContent}})()`);
        const ki = f.li.indexOf("配对时交给它的账户密钥和那份完整副本也拿不回来。");
        step("S11 A38 移除前的说明有「密钥与完整副本拿不回来」、排在「不删它的」之后", ki > 0 && /不会被删除/.test(f.li[ki - 1]), JSON.stringify(f.li));
        step("S11 A38 末尾「想彻底隔离…移除不够」+ 一枚「意见反馈」", f.isoShown && /^想彻底隔离/.test(f.iso ?? "") && /移除不够/.test(f.iso ?? "") && f.go === "意见反馈", JSON.stringify(f));
        await tapSel("#sync-devices .dev-row.open [data-feedback]");
        const opened = await until(paneIs("settings-pane"), 3000);
        await sleep(1500); // 备份那一节是异步画的、在「意见反馈」上面 —— 画完再量(滚动锚定应当把它稳住)
        const g = await evalJs(`(()=>{const r=document.getElementById("feedback-title").getBoundingClientRect();return {top:r.top,bottom:r.bottom,vh:innerHeight}})()`);
        step("S11 A38 点「意见反馈」⇒ 开设置、那一节在屏上", opened && g.top >= 0 && g.bottom <= g.vh, JSON.stringify(g));
        await back();
        step("S11 A38 返回键 ⇒ 回同步面", await until(paneIs("sync"), 3000), await evalJs(`document.body.className`));
        stopPeer();
      }
    }

    if (on("S6")) {
      await joinWith("12345");
      await until(`(window.__m2bars||[]).length>0`, 6000);
      const b1 = await bars();
      step("S6 A27 码样子不对:说长相、不说「槽号」、不挂原文", /配对码的样子不对:应是 9 位数字、4 位、4 位/.test(b1) && !/槽号/.test(b1) && !/原文/.test(b1), b1);
      const ico = await evalJs(`getComputedStyle(document.getElementById("error"),"::before").content`);
      step("S6 A8 错误条带图标", ico === '"!"', ico);
      await joinWith("123456789-ABCD-EFGH");
      await until(`(window.__m2bars||[]).length>0`, 8000);
      const b2 = await bars();
      step("S6 A42 / Q3 码不存在:回出码那台「重新出码」+ 核对服务器地址", /在出码的那台上点「重新出码」,再输新码;也核对一下服务器地址是不是对方那台/.test(b2), b2);
    }

    if (on("S7")) {
      await openPaneVia("sync", "#sync-toggle");
      if (await hid("sync-devices")) await tapSel("#sync-devices-btn");
      await until(`!!document.querySelector("#sync-devices .dev-row[data-dev]")`, 6000);
      await stopServer();
      const off = await until(`document.getElementById("sync-state").innerText.startsWith("离线,重连中…")`, 8000);
      const dot = await evalJs(`(()=>{const d=getComputedStyle(document.getElementById("sync-dot"));return {bg:d.backgroundColor,bw:parseFloat(d.borderTopWidth),cls:document.getElementById("sync-dot").className}})()`);
      step("S7 Q14 断开:点变空心圈(不只靠颜色)", off && dot.bg === "rgba(0, 0, 0, 0)" && dot.bw >= 1.5, JSON.stringify(dot));
      step("S7 Q14 离线时同步面有「现在重连」", !(await hid("sync-reconnect-row")) && (await txt("#sync-reconnect-btn")) === "现在重连");
      const e = await evalJs(`(()=>{const x=document.querySelector("#sync-state .err");return x?{ico:getComputedStyle(x,"::before").content,raw:!!x.querySelector(".err-raw"),t:x.innerText}:null})()`);
      step("S7 A8 状态那行错误带图标、原文降一档、人话不说「中途断了」", !!e && e.ico === '"!"' && e.raw && !/中途断了/.test(e.t), JSON.stringify(e));
      await tapSel("#dev-refresh");
      // 名单「刷新」在断开时留下的那一句(离线那几拍回的是「现在没连上服务器(正在重连)…」,撞上「连接中」那一拍回的是另一句断线话 —— 都算)
      const got = await until(`!!document.querySelector("#sync-devices .err")`, 6000);
      // 断开期间状态在「离线 ↔ 连接中」来回:那句话别跟着来回闪(等过一次来回再看)
      const t0 = Date.now();
      let flips = 0;
      let last = await evalJs(`document.getElementById("sync-dot").className`);
      while (Date.now() - t0 < 9000 && flips < 2) {
        await sleep(200);
        const c = await evalJs(`document.getElementById("sync-dot").className`);
        if (c !== last) flips++;
        last = c;
      }
      const still = await evalJs(`!!document.querySelector("#sync-devices .err")`);
      step("S7 A33 断开时名单「刷新」留下那句人话,断开期间不来回闪", got && flips >= 1 && still, `got=${got} flips=${flips} still=${still}`);
      // 等退避拉长,再起服务器、点「现在重连」。⚠ 起服务器那一刻手机可能正好退避到点、自己连上了(那就判不了「是不是点的那一下」)
      // ⇒ 那一形不算数:再停一次、再等、再来,最多三趟。
      let verdict = null;
      for (let attempt = 1; attempt <= 3 && verdict === null; attempt++) {
        if (srv) await stopServer();
        await until(`document.getElementById("sync-dot").classList.contains("off")`, 8000);
        await sleep(8000);
        await startServer();
        await evalJs(`window.__m2bars=[];window.__m2conn=null;(()=>{const d=document.getElementById("sync-dot");if(window.__m2dmo)window.__m2dmo.disconnect();
          window.__m2dmo=new MutationObserver(()=>{if(window.__m2conn===null&&!d.classList.contains("off"))window.__m2conn=performance.now()});window.__m2dmo.observe(d,{attributes:true})})();1`);
        if (!(await evalJs(`!document.getElementById("sync-reconnect-btn").disabled && document.getElementById("sync-dot").classList.contains("off")`))) continue; // 自己先动了
        const c = await centerDev("#sync-reconnect-btn");
        if (!c) continue; // 判完「还离线」到取坐标之间它自己退避重连上了、钮收了:同上,这一趟不算(873 撞到)
        const tapAt = await evalJs(`performance.now()`); // 发 adb 之前记(adb 一来一回要上百毫秒,点是在这之后落的)
        await devTap(c[0], c[1]);
        const backOnline = await until(`document.getElementById("sync-dot").classList.contains("online")`, 6000);
        const connAt = await evalJs(`window.__m2conn`);
        if (connAt !== null && connAt < tapAt) continue; // 点之前就自己动了:这一趟不算
        verdict = { ok: backOnline && connAt !== null && connAt - tapAt < 700, d: `第 ${attempt} 趟:点下到离开离线 ${connAt === null ? null : Math.round(connAt - tapAt)}ms(含 adb 往返)online=${backOnline}` };
      }
      step("S7 Q14 点「现在重连」当场就去连(0.7 秒内离开离线,不等退避)", verdict?.ok ?? false, verdict?.d ?? "三趟都赶上它自己退避到点,没判成");
      await until(`document.getElementById("sync-dot").classList.contains("online")`, 30000);
      await sleep(800);
      const b = await bars();
      step("S7 Q14 连回来说一声「已重新连上」(只说这一句)", /已重新连上/.test(b) && !/已发出/.test(b), b);
      const cleared = await until(`!document.querySelector("#sync-devices .err")`, 4000);
      step("S7 A33 连回来后名单下那句过时的话收掉(没点刷新)", cleared, await txt("#sync-devices"));
    }

    if (on("S10")) {
      // 这一本一篇长文都没有(新建的测试空间)
      await closePanes();
      await tapSel("#capture-fab");
      await sleep(800);
      await tapSel("#compose-doc");
      const inDocs = await until(paneIs("docs-pane"), 3000);
      await dropIme();
      await back();
      const left = await until(`!document.body.classList.contains("pane-open")`, 4000);
      const cells = await evalJs(`[...document.querySelectorAll("#bottombar button")].filter(b=>!b.hidden).map(b=>b.textContent+(b.classList.contains("active")?"*":"")).join("|")`);
      step("S10 零篇长文时新建一个字不写就退出 ⇒ 回到随记、面收起、底栏不冒「长文」", inDocs && left && /随记\*/.test(cells) && !/长文/.test(cells), cells);
    }

    if (on("S8")) {
      const st = await status();
      if (!step("S8 前置-这一本开着同步", st.configured, JSON.stringify({ c: st.configured, s: st.state }))) return;
      await closePanes();
      const r = await revoke(st.device_id);
      const gone = await until(`/^这台已不在这个账户里\\(被移出,或账户被停用\\)/.test(document.getElementById("sync-state").innerText)`, 15000);
      // 随记页顶那一条
      const bar = await evalJs(`(()=>{const b=document.getElementById("sync-gone-bar");return {h:b.hidden,t:b.innerText}})()`);
      step("S8 Q12 随记页顶挂同一句(连同「内容都还在、之后记的只留在这台」)", gone && !bar.h && /这台已不在这个账户里/.test(bar.t) && /之后在这台记的只留在这台/.test(bar.t), `${r} ${JSON.stringify(bar)}`);
      // ⚠ 顶上那条提示条(回执 / 「已重新连上」)正好落在这一条上面,点下去先收的是提示条 —— 等它自己收完再点(人也是这么点的)。
      await until(`document.getElementById("error").hidden`, 12000);
      await tapSel("#sync-gone-bar");
      step("S8 Q12 点那一条就进同步页", await until(paneIs("sync"), 3000));
      const s = await evalJs(`({state:document.getElementById("sync-state").innerText,gone:!document.getElementById("sync-gone").hidden,goneT:document.getElementById("sync-gone").innerText,
        invite:!document.getElementById("sync-invite-row").hidden,devs:!document.getElementById("sync-devices-row").hidden,re:!document.getElementById("sync-reconnect-row").hidden,
        dot:document.getElementById("sync-dot").className})`);
      step("S8 Q12 点那一条进同步页:明说状态、不写「重连中」、不挂网络话", !/重连中|连不上|没连上|尚未确认/.test(s.state) && s.dot === "dot off", JSON.stringify(s));
      step("S8 Q12 同一处写清两件事(内容都还在 / 先复制再重置、输码加入)", s.gone && /内容都还在/.test(s.goneT) && /先把只在这台上的那几条复制出来/.test(s.goneT) && /重置/.test(s.goneT), s.goneT);
      step("S8 Q12 / A40 收起「添加设备」与设备名单、不给「现在重连」", !s.invite && !s.devs && !s.re, JSON.stringify(s));
      await tapSel("#sync-gone-spaces");
      await until(paneIs("spaces"), 3000);
      const sid = await curSpace();
      const row = await txt(`#space-list .space-row[data-space="${sid}"]`);
      step("S8 Q12 空间页那一行标「已不再同步」", /已不再同步/.test(row ?? ""), row);
      await tapSel(`#space-list [data-more="${sid}"]`);
      await sleep(400);
      await tapSel(`#space-list [data-reset="${sid}"]`);
      await sleep(400);
      const w = await txt(`#space-list .space-row[data-space="${sid}"]`);
      step("S8 Q12 「重置」确认点出「不在账户里之后记的那几条只在这里」、不说「告知运营者」", /不在账户里之后记的那几条只在这里/.test(w ?? "") && !/运营者/.test(w ?? ""), w);
      await tapSel(`#space-list [data-reset-ok="${sid}"]`);
      const gone2 = await until(`(async()=>!(await window.__TAURI__.core.invoke("list_spaces")).some(x=>x.id===${JSON.stringify(sid)}))()`, 8000);
      if (gone2) created.splice(created.indexOf(sid), 1);
      const ledger = await evalJs(`localStorage.getItem("zhujian.sync-gone")`);
      step("S8 Q12 重置后那一本的账作废、随记页顶那一条收", gone2 && !(ledger ?? "").includes(sid) && (await hid("sync-gone-bar")), `${gone2} ${ledger}`);
    }

    if (on("S9")) {
      if (!existsSync(PEER)) step("S9 Q12 自己退出 / Q13 没起名的回执", "skip", "没有无界面对端:cd core && cargo build --example headless-peer");
      else {
        await startPeer();
        const code = await peerCode();
        await joinWith(code);
        const joined = await until(`(window.__m2bars||[]).some(b=>/已加入空间/.test(b))`, 20000);
        const b = await bars();
        const act = await evalJs(`(()=>{const a=document.querySelector("#error .bar-act");return a?a.textContent:null})()`);
        const sid = await curSpace();
        if (joined && sid !== homeSpace) created.push(sid);
        step("S9 Q13 回执写明这本在这台叫什么(对方没起过名)+ 一枚「改名」", joined && /对方那本没起过名,这里先叫「未命名空间 · [0-9A-Z]{4}」/.test(b) && act === "改名", `${b} act=${act}`);
        await until(`document.getElementById("sync-dot").classList.contains("online")`, 15000);
        await openPaneVia("sync", "#sync-toggle");
        if (await hid("sync-devices")) await tapSel("#sync-devices-btn");
        await until(`!!document.querySelector("#sync-devices .dev-row[data-dev]")`, 8000);
        await tapSel("#sync-devices .dev-row[data-dev]"); // 本机那行排第一
        await until(`!!document.querySelector('#sync-devices .dev-row.open [data-act="Remove"]')`, 3000);
        await tapConfirm('#sync-devices .dev-row.open [data-act="Remove"]');
        const left = await until(`document.getElementById("sync-state").innerText.startsWith("你已退出这个账户")`, 10000);
        await sleep(2500); // 退出回执之后那条会话还要在线一会儿、接着鉴权被拒 —— 那之后还得是「你已退出」,不是「被移出」
        const s = await txt("#sync-state");
        const ledger = await evalJs(`localStorage.getItem("zhujian.sync-gone")`);
        step("S9 Q12 自己退出 ⇒「你已退出这个账户」(鉴权被拒之后也不改口成「被移出」)", left && /^你已退出这个账户/.test(s) && (ledger ?? "").includes('"why":"left"'), `${s} ${ledger}`);
        step("S9 Q12 自己退出也收起「添加设备」与名单、不写「重连中」", (await hid("sync-invite-row")) && (await hid("sync-devices-row")) && !/重连中/.test(s));
      }
    }
  } finally {
    // ── 收尾:测试空间全部重置(非主空间 = 删库文件)、回到开跑时那一本、还原地址记账、停服务器与对端 ──
    stopPeer();
    await closePanes().catch(() => {});
    for (const sid of created) {
      await inv("reset_space", { spaceId: sid }).catch((e) => step(`收尾-重置测试空间 ${sid}`, false, e));
    }
    await sleep(800);
    if ((await curSpace().catch(() => homeSpace)) !== homeSpace) {
      await openSpaces().catch(() => {});
      await tapSel(`#space-list [data-switch="${homeSpace}"]`).catch(() => {});
      await until(`(async()=>(await window.__TAURI__.core.invoke("list_spaces")).find(x=>x.current).id===${JSON.stringify(homeSpace)})()`, 6000);
      await closePanes().catch(() => {});
    }
    await evalJs(savedLast === null ? `localStorage.removeItem("zhujian.last-server");1` : `localStorage.setItem("zhujian.last-server",${JSON.stringify(savedLast)});1`).catch(() => {});
    await evalJs(`document.getElementById("m2-knife")?.remove();1`).catch(() => {});
    await stopServer();
    await portDown().catch(() => {});
    rmSync(SRV_DIR, { recursive: true, force: true });
    const left = await evalJs(`(async()=>(await window.__TAURI__.core.invoke("list_spaces")).map(x=>x.name).join("|"))()`).catch(() => "?");
    step("收尾-测试空间零残留、回到开跑那一本", !/M2验收/.test(left) && (await curSpace().catch(() => null)) === homeSpace, left);
    cdp.close();
  }
};

await main().catch((e) => out.steps.push({ name: "异常", ok: false, detail: String(e?.stack ?? e).slice(0, 800) }));
const real = out.steps.filter((s) => s.ok !== "SKIPPED");
out.pass = real.length > 0 && real.every((s) => s.ok === true);
console.log(JSON.stringify(out, null, 1));
process.exit(out.pass ? 0 : 1);

// 手机一轮(轮三,backlog 用户面 122)的真机回归网:返回键两处 + 面板随滚动收 + 移动两拍 +
// 同步空框说话 + 筛选条触区。⚠ 只在 vivo 上有意义(返回键那两段要真软键盘 + 真 keyevent 4)。
//
// 守六段(每段一个由头,别把哪段拆成恒绿):
//  A. **捕获层压返回键守门条目**:真点 ＋(adb tap)→ 键盘起 → 返回收键盘 → 再一记返回**只收层**,
//     app 仍在前台(改前这一记直接退 app —— 146 那条 `__zhujianHandleBack` 无层可关回 false)。
//     再开层 → 点遮罩收(UI 那条路,平守门条目)→ 草稿原样在框里。
//  B. **编辑层返回与点遮罩同规矩**:打一个字 → 返回 → 层**还开着** + 提示条「先保存或取消」
//     (改前直接丢稿);点「取消」收掉;再开一次不打字 → 返回 → 收层、操作面回主面。
//  C. **卡整张滚出屏就收面**:开一张卡的操作面 → 滚到它在视口上方 → 面没了、＋ 回来了,
//     且**屏上内容没跳**(卡在视口上方变矮,由滚动锚定补回 —— 同一张可见卡的 top 前后差 ≤1px)。
//  D. **移动到别的空间要两拍**(只在 ≥2 个空间时跑,否则如实 SKIPPED):点目标 → 只弹确认条、
//     卡仍在 → 点「取消」收掉。⛔ 本资产绝不点第二拍(移动会永久删编辑历史)。
//  E. **加入空间那一格空着就点「加入」要说话**:清空地址 → 点 → 提示「先填服务器地址」+ 光标进地址框;
//     填回地址、码空着 → 「先填配对码」+ 光标进码框。原值原样放回。
//  F. **筛选钮上下各 4px 的 halo 真接得住点**:`elementFromPoint` 打钮上沿外 2px / 下沿外 2px 都命中钮本身;
//     父标签的展开箭头(有的话)打中心命中的仍是箭头(halo 画在钮内容之上,箭头得浮上来)。
//  收尾:时间轴无层态 → 一记返回**退到桌面**(一次即退、不留空炮 = 前面几段的守门账目是平的)→ 再拉起。
//
// ⚠ 诚实边界:
//  ① 一个字都不写库:编辑层打的那个字点「取消」丢掉;移动只点第一拍;加入钮在空框上就被拦。
//     末尾回读那张卡的正文当字据。
//  ② 「初始同步中空态换话术」与「提醒被系统拒着要说一句」不在本资产:前者要造一个正在引导的空间,
//     后者要 `pm revoke` 通知权限(会杀进程),两格各自手跑,读数记在 progress-log 同号条。
//  ③ E 段只走空间面「加入空间」那张表;同步面那两条(输码 / 创号)同一个 `lacksInput`,没逐条点。
//
// 跑法(设备上得是 devtools 包,app 在前台):
//   node scripts/android-cdp.mjs forward
//   node scripts/cdp-acceptance-layer-guards.mjs      # 打印 {pass, steps}
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const PORT = 9222;
const PKG = "app.zhujian.notebook";
const execFileAsync = promisify(execFile);
const adb = (args) => execFileAsync("adb", args, { encoding: "utf8", maxBuffer: 1 << 24 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function imeShown() {
  const out = await adb(["shell", "dumpsys", "input_method"]).catch(() => null);
  const m = out?.stdout.match(/mInputShown=(true|false)/);
  return m ? m[1] === "true" : null;
}
async function focusedPkg() {
  const out = await adb(["shell", "dumpsys", "window"]).catch(() => null);
  const m = out?.stdout.match(/mCurrentFocus=Window\{\S+ \S+ ([^/\s}]+)/);
  return m ? m[1] : null;
}
const back = () => adb(["shell", "input", "keyevent", "4"]);
/** 键盘起着就先一记返回收掉它(返回键第一记被 IME 吃掉,那不是我们的账)。 */
async function dropIme() {
  if (await imeShown()) {
    await back();
    await sleep(700);
  }
}

async function connect() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json`);
  const page = (await r.json()).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error("无 page target——先 `node scripts/android-cdp.mjs forward`,且 app 在前台");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", () => rej(new Error("ws 连接失败")), { once: true });
  });
  let id = 0;
  const send = (method, params) =>
    new Promise((res, rej) => {
      const myId = ++id;
      const to = setTimeout(() => rej(new Error(`CDP 超时: ${method}`)), 20000);
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

// 模块级:中途抛了也要把已判的那几格印出来(阴性刀下「退到桌面」之后的那一发 CDP 会超时)。
const out = { pass: false, steps: [] };

const main = async () => {
  const step = (name, ok, detail = "") => {
    out.steps.push({ name, ok: ok === "skip" ? "SKIPPED" : !!ok, detail: String(detail) });
    return !!ok;
  };
  let cdp = await connect();
  const evalJs = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`页内异常: ${JSON.stringify(r.exceptionDetails)}`);
    return r.result.value;
  };
  const until = async (expr, ms = 4000) => {
    const t0 = Date.now();
    for (;;) {
      if (await evalJs(expr).catch(() => false)) return true;
      if (Date.now() - t0 > ms) return false;
      await sleep(150);
    }
  };
  const centerDev = async (sel) =>
    JSON.parse(
      await evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});
        if(!e)return "null";const r=e.getBoundingClientRect();
        return JSON.stringify([Math.round((r.x+r.width/2)*devicePixelRatio),Math.round((r.y+r.height/2)*devicePixelRatio)])})()`),
    );
  const tapSel = async (sel) => {
    const c = await centerDev(sel);
    if (!c) throw new Error(`找不到 ${sel}`);
    await adb(["shell", "input", "tap", String(c[0]), String(c[1])]);
  };
  const barText = () => evalJs(`(()=>{const e=document.getElementById("error");return e.hidden?"":e.textContent})()`);
  const clearBar = () => evalJs(`(()=>{const e=document.getElementById("error");e.hidden=true;e.textContent="";return 1})()`);
  /** app 被一记返回退到桌面了(那一格已判红):拉回前台、重连,后面几段照判。 */
  const relaunch = async () => {
    cdp.close();
    await adb(["shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1"]);
    await sleep(4000);
    await execFileAsync("node", ["scripts/android-cdp.mjs", "forward"]);
    cdp = await connect();
    await until(`!!document.querySelector("#timeline [data-id]")`, 12000);
  };
  const composeOpen = `document.getElementById("compose-card").classList.contains("open")`;
  const editOpen = `document.getElementById("edit-sheet").classList.contains("open")`;

  if (!step("前置-时间轴有卡", await until(`!!document.querySelector("#timeline [data-id]")`, 12000))) return out;
  if (!step("前置-app 在前台", (await focusedPkg()) === PKG, await focusedPkg())) return out;
  // 起点:无层、无面板、回时间轴顶。
  await evalJs(`(()=>{if(${editOpen})document.getElementById("edit-cancel").click();
    if(${composeOpen})document.getElementById("capture-scrim").click();
    document.querySelector("#timeline .panel")?.closest("article")?.querySelector(".content")?.click();
    scrollTo({top:0});return 1})()`);
  await sleep(900);

  // ── A. 捕获层 ─────────────────────────────────────────────────────────────
  const draft0 = await evalJs(`document.getElementById("text").value`);
  await tapSel("#capture-fab");
  step("A-真点 ＋ 开层", await until(composeOpen, 3000));
  await sleep(900);
  step("A-键盘起了(否则下一记返回的归属判不了)", await imeShown(), `mInputShown=${await imeShown()}`);
  await dropIme();
  step("A-收键盘那记返回没收层", await evalJs(composeOpen));
  await back();
  await sleep(900);
  // ⚠ 先问前台是谁再碰页面:退到桌面之后 runtime 停了,下一发 CDP 只会超时。
  const fgA = await focusedPkg();
  if (!step("A-再一记返回:app 仍在前台(改前这一记退 app)", fgA === PKG, fgA)) await relaunch();
  else step("A-再一记返回:层收了", !(await evalJs(composeOpen)));
  step("A-＋ 回来了", await evalJs(`!document.getElementById("capture-fab").hidden`));
  // UI 那条路:点遮罩收层(遮罩开层后 450ms 内不认点)。
  await tapSel("#capture-fab");
  await until(composeOpen, 3000);
  await sleep(900);
  await dropIme();
  const scrimAt = await evalJs(`JSON.stringify([Math.round(innerWidth/2*devicePixelRatio),Math.round(120*devicePixelRatio)])`);
  const [sx, sy] = JSON.parse(scrimAt);
  await adb(["shell", "input", "tap", String(sx), String(sy)]);
  step("A-点遮罩收层", await until(`!(${composeOpen})`, 3000));
  step("A-草稿原样在框里", (await evalJs(`document.getElementById("text").value`)) === draft0, JSON.stringify(draft0).slice(0, 40));

  // ── B. 编辑层 ─────────────────────────────────────────────────────────────
  const picked = await evalJs(`(()=>{const vh=visualViewport.height;
    const c=[...document.querySelectorAll("#timeline article.card[data-id]")].find(x=>{
      const r=x.getBoundingClientRect();return r.top>120&&r.bottom<vh-160&&r.height>40&&x.querySelector(".content");});
    return c?c.dataset.id:null})()`);
  if (!step("B-前置-挑到一张整卡在可见区内", !!picked)) return out;
  const card = `#timeline article.card[data-id="${picked}"]`;
  const text0 = await evalJs(`document.querySelector('${card} .content').textContent`);
  const openEdit = async () => {
    if (!(await evalJs(`!!document.querySelector('${card} .panel [data-pact="edit"]')`)))
      await evalJs(`(()=>{document.querySelector('${card} .content').click();return 1})()`);
    await until(`!!document.querySelector('${card} .panel [data-pact="edit"]')`, 3000);
    await tapSel(`${card} .panel [data-pact="edit"]`);
    return until(editOpen, 3000);
  };
  step("B-开编辑层", await openEdit());
  await sleep(700);
  await adb(["shell", "input", "text", "q"]);
  step("B-打进了一个字", await until(`document.getElementById("edit-text").value.endsWith("q")`, 3000));
  await clearBar();
  await dropIme();
  await back();
  await sleep(900);
  if (!step("B-改过了按返回:app 仍在前台", (await focusedPkg()) === PKG)) await relaunch();
  step("B-改过了按返回:层还开着", await evalJs(editOpen));
  const bar = await barText();
  step("B-改过了按返回:提示先保存或取消", /保存|Save/.test(bar), bar);
  step("B-稿还在", await evalJs(`document.getElementById("edit-text").value.endsWith("q")`));
  await evalJs(`(()=>{if(${editOpen})document.getElementById("edit-cancel").click();return 1})()`);
  step("B-点取消收层", await until(`!(${editOpen})`, 3000));
  step("B-再开一次(没改过)", await openEdit());
  await sleep(700);
  await dropIme();
  await back();
  await sleep(900);
  step("B-没改过按返回:层收了", !(await evalJs(editOpen)));
  step("B-没改过按返回:操作面回主面", await evalJs(`!!document.querySelector('${card} .panel [data-pact="edit"]')`));
  step("B-库里正文没动(字据)", (await evalJs(`document.querySelector('${card} .content').textContent`)) === text0);

  // ── C. 卡滚出屏就收面 ─────────────────────────────────────────────────────
  // 此刻 B 留下那张卡的操作面开着。把它滚到视口上方,同步量一张下面可见卡的 top 当锚。
  step("C-前置-面开着、＋ 让位", await evalJs(`document.body.classList.contains("panel-open")`));
  const anchorRaw = await evalJs(`(()=>{const c=document.querySelector('${card}');const r=c.getBoundingClientRect();
    scrollBy(0, r.bottom + 40);
    const vh=innerHeight;const a=[...document.querySelectorAll("#timeline article.card[data-id]")].find(x=>{
      const q=x.getBoundingClientRect();return q.top>150&&q.bottom<vh;});
    return JSON.stringify(a?[a.dataset.id,a.getBoundingClientRect().top]:null)})()`);
  const anchor = JSON.parse(anchorRaw);
  await sleep(600);
  step("C-卡滚到视口上方:面收了", await evalJs(`!document.querySelector("#timeline .panel")&&!document.body.classList.contains("panel-open")`));
  step("C-＋ 回来了", await evalJs(`getComputedStyle(document.getElementById("capture-fab")).display!=="none"`));
  if (anchor) {
    const top1 = await evalJs(`document.querySelector('#timeline article.card[data-id="${anchor[0]}"]').getBoundingClientRect().top`);
    step("C-屏上没跳(可见卡 top 前后差 ≤1px)", Math.abs(top1 - anchor[1]) <= 1, `${anchor[1].toFixed(1)} → ${top1.toFixed(1)}`);
  } else step("C-屏上没跳", "skip", "视口里没有可当锚的整卡");
  await evalJs(`(()=>{scrollTo({top:0});return 1})()`);
  await sleep(400);

  // ── D. 移动两拍 ───────────────────────────────────────────────────────────
  const nSpaces = await evalJs(`window.__TAURI__.core.invoke("list_spaces").then(s=>s.length)`);
  if (nSpaces < 2) step("D-移动两拍", "skip", `只有 ${nSpaces} 个空间`);
  else {
    // 面可能还开着(C 那格红了的时候)—— 开着再点正文是收,先看在不在。
    await evalJs(`(()=>{if(!document.querySelector('${card} .panel [data-pact="more"]'))document.querySelector('${card} .content').click();return 1})()`);
    await until(`!!document.querySelector('${card} .panel [data-pact="more"]')`, 3000);
    await evalJs(`(()=>{document.querySelector('${card} .panel [data-pact="more"]').click();return 1})()`);
    const hasMove = await until(`!!document.querySelector('${card} .panel [data-pact="move"]')`, 2000);
    if (!hasMove) step("D-移动两拍", "skip", "更多…里没有移动入口");
    else {
      await evalJs(`(()=>{document.querySelector('${card} .panel [data-pact="move"]').click();return 1})()`);
      await until(`!!document.querySelector('${card} .panel [data-move-to]')`, 3000);
      await evalJs(`(()=>{document.querySelector('${card} .panel [data-move-to]').click();return 1})()`);
      await sleep(400);
      step("D-第一拍只弹确认条", await evalJs(`!document.getElementById("confirmbar").hidden`), await evalJs(`document.getElementById("confirmbar-q").textContent`));
      step("D-卡仍在、仍在移动子面", await evalJs(`!!document.querySelector('${card} .panel [data-move-to]')`));
      await evalJs(`(()=>{document.getElementById("confirmbar-no").click();return 1})()`);
      step("D-点取消收掉确认条", await evalJs(`document.getElementById("confirmbar").hidden`));
    }
    await evalJs(`(()=>{document.querySelector('${card} .content')?.click();return 1})()`); // 收面
    await sleep(300);
  }

  // ── E. 加入空间空框 ───────────────────────────────────────────────────────
  // ⚠ 面与表单都得真摊开:藏着的输入框 focus() 不生效,「光标进空着的那格」会假红。
  await clearBar();
  await evalJs(`(()=>{document.getElementById("sync-spaces-btn").click();return 1})()`);
  step("E-前置-空间面开着", await until(`!document.getElementById("spaces").hidden&&document.body.classList.contains("pane-open")`, 3000));
  await evalJs(`(()=>{if(document.getElementById("join-form").hidden)document.getElementById("join-alt-btn").click();return 1})()`);
  step("E-前置-输码表单摊开", await until(`!document.getElementById("join-form").hidden`, 2000));
  const e = await evalJs(`(async()=>{const s=document.getElementById("join-server"),c=document.getElementById("join-code");
    const s0=s.value,c0=c.value;const r={};
    s.value="";c.value="";document.getElementById("join-go").click();
    const b=document.getElementById("error");r.noServer=[b.hidden?"":b.textContent,document.activeElement?.id];
    b.hidden=true;s.value="wss://example.invalid";document.getElementById("join-go").click();
    r.noCode=[b.hidden?"":b.textContent,document.activeElement?.id];
    s.value=s0;c.value=c0;s.blur();c.blur();b.hidden=true;r.restored=s.value===s0&&c.value===c0;
    r.ph=s.placeholder;return JSON.stringify(r)})()`);
  const er = JSON.parse(e);
  step("E-地址空着:说「先填服务器地址」且光标进地址框", /服务器地址|server address/.test(er.noServer[0]) && er.noServer[1] === "join-server", er.noServer.join(" | "));
  step("E-码空着:说「先填配对码」且光标进码框", /配对码|pairing code/.test(er.noCode[0]) && er.noCode[1] === "join-code", er.noCode.join(" | "));
  step("E-地址框有占位字", er.ph.length > 0, er.ph);
  step("E-原值放回", er.restored);
  await dropIme();
  await evalJs(`(()=>{document.getElementById("join-alt-btn").click();document.getElementById("sync-spaces-btn").click();return 1})()`); // 收表单、收面(toggle)
  await sleep(400);

  // ── F. 筛选钮 halo ────────────────────────────────────────────────────────
  const f = JSON.parse(
    await evalJs(`(()=>{scrollTo({top:0});const r={};
      const p=[...document.querySelectorAll("#filterbar .fpill")].find(x=>{const q=x.getBoundingClientRect();return q.width>0&&q.left>4&&q.right<innerWidth-4;});
      if(!p)return JSON.stringify(null);const q=p.getBoundingClientRect(),cx=q.left+q.width/2;
      r.h=q.height;r.above=document.elementFromPoint(cx,q.top-2)?.closest(".fpill")===p;
      r.below=document.elementFromPoint(cx,q.bottom+2)?.closest(".fpill")===p;
      r.far=document.elementFromPoint(cx,q.top-6)?.closest(".fpill")===p;
      const k=[...document.querySelectorAll("#filterbar .fcaret")].find(x=>{const z=x.getBoundingClientRect();return z.width>0&&z.left>4&&z.right<innerWidth-4;});
      if(k){const z=k.getBoundingClientRect();r.caret=document.elementFromPoint(z.left+z.width/2,z.top+z.height/2)===k;}
      return JSON.stringify(r)})()`),
  );
  if (!f) step("F-筛选钮 halo", "skip", "筛选条上没有整枚在屏内的钮");
  else {
    step("F-钮上沿外 2px 命中钮", f.above, `钮高 ${f.h.toFixed(1)}`);
    step("F-钮下沿外 2px 命中钮", f.below);
    step("F-上沿外 6px 不归它(halo 只有 4px,没越到行间中线外)", !f.far);
    if (f.caret === undefined) step("F-展开箭头浮在 halo 上", "skip", "没有带子标签的父标签");
    else step("F-展开箭头浮在 halo 上", f.caret);
  }

  // ── 收尾:守门账目是平的 ⇒ 无层态一记返回就退到桌面 ─────────────────────
  await dropIme();
  await evalJs(`(()=>{document.getElementById("error").hidden=true;return 1})()`);
  await sleep(300);
  step("收尾-前置-无层无面", await evalJs(`!(${composeOpen})&&!(${editOpen})&&!document.body.classList.contains("pane-open")&&!document.querySelector("#timeline .panel")`));
  cdp.close();
  await back();
  await sleep(1200);
  const fgEnd = await focusedPkg();
  step("收尾-一记返回即退(不留空炮)", fgEnd !== PKG, fgEnd);
  await adb(["shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1"]);
  await sleep(2500);

  out.pass = out.steps.every((s) => s.ok === true || s.ok === "SKIPPED");
  return out;
};

main()
  .then((o) => {
    console.log(JSON.stringify(o, null, 1));
    process.exit(o.pass ? 0 : 1);
  })
  .catch((e) => {
    console.log(JSON.stringify({ ...out, pass: false, error: String(e?.stack ?? e) }, null, 1));
    process.exit(1);
  });

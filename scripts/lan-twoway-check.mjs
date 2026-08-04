// 两端双向互补的最小判据(lan-direct-plan §11「纯局域网双向互补」/「冷启动形」)。
//
// 两端各建一条,各自等对面出现;两端 sync_status 必须 state=offline(= 没有任何中转路),
// 故「到达」只可能是走了直连。末了两条都删净。
// 用法:node scripts/lan-twoway-check.mjs --desktop-space <id> --phone-space <id> [--keep]
const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const DS = arg("--desktop-space");
const PS = arg("--phone-space");
if (!DS || !PS) throw new Error("必须给 --desktop-space 与 --phone-space");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(port, pick) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const t = list.find((x) => x.type === "page" && x.webSocketDebuggerUrl && pick(x.url));
  if (!t) throw new Error(`${port} 上无匹配 page target`);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", () => rej(new Error(`ws 连不上 ${port}`)), { once: true });
  });
  let seq = 0;
  const evaluate = (expression, timeoutMs = 60000) =>
    new Promise((res, rej) => {
      const id = ++seq;
      const to = setTimeout(() => rej(new Error(`CDP 超时(${port})`)), timeoutMs);
      const on = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id !== id) return;
        clearTimeout(to);
        ws.removeEventListener("message", on);
        if (m.error) return rej(new Error(JSON.stringify(m.error)));
        if (m.result.exceptionDetails) return rej(new Error("页面异常:" + JSON.stringify(m.result.exceptionDetails)));
        res(m.result.result.value);
      };
      ws.addEventListener("message", on);
      ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  return { evaluate, close: () => ws.close() };
}

const desktop = await connect(9223, (u) => u.includes("notebook"));
const phone = await connect(9222, () => true);
const J = JSON.stringify;

// 先自证「没有中转路」——否则到达证明不了走的是直连。
const states = JSON.parse(
  await desktop.evaluate(`(async()=>{const i=window.__TAURI_INTERNALS__.invoke;const s=await i("sync_status",{spaceId:${J(DS)}});return JSON.stringify({state:s.state,lan:s.lan_peers})})()`),
);
const pstates = JSON.parse(
  await phone.evaluate(`(async()=>{const i=window.__TAURI_INTERNALS__.invoke;const s=await i("sync_status",{spaceId:${J(PS)}});return JSON.stringify({state:s.state,lan:s.lan_peers})})()`),
);
console.log("桌面", states, " 手机", pstates);
if (states.state !== "offline" || pstates.state !== "offline") {
  console.log("⚠ 有一端仍在线——本轮到达不能当「走直连」的证据");
}

async function waitFor(side, space, marker, budgetMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    const n = await side.evaluate(
      `(async()=>{const i=window.__TAURI_INTERNALS__.invoke;const r=await i("search_notes",{spaceId:${J(space)},query:${J(marker)}});return r.length})()`,
    );
    if (n > 0) return Date.now() - t0;
    await sleep(150);
  }
  return null;
}

const tag = String(process.pid);
// 桌面 → 手机
const d2p = `COLD-D2P-${tag}`;
const dId = await desktop.evaluate(
  `(async()=>{const i=window.__TAURI_INTERNALS__.invoke;await i("set_foreground_space",{spaceId:${J(DS)}});return await i("capture_note",{spaceId:${J(DS)},content:${J(d2p)}})})()`,
);
const d2pMs = await waitFor(phone, PS, d2p);
console.log(`桌面→手机 ${d2pMs === null ? "❌ 60s 未到" : `✅ ${d2pMs}ms`}`);

// 手机 → 桌面
const p2d = `COLD-P2D-${tag}`;
const pId = await phone.evaluate(
  `(async()=>{const i=window.__TAURI_INTERNALS__.invoke;return await i("capture_idea",{spaceId:${J(PS)},content:${J(p2d)}})})()`,
);
const p2dMs = await waitFor(desktop, DS, p2d);
console.log(`手机→桌面 ${p2dMs === null ? "❌ 60s 未到" : `✅ ${p2dMs}ms`}`);

if (!argv.includes("--keep")) {
  const did = typeof dId === "string" ? dId : dId?.id;
  await desktop.evaluate(`(async()=>{const i=window.__TAURI_INTERNALS__.invoke;await i("delete_note",{spaceId:${J(DS)},id:${J(did)}});return 1})()`);
  const pid = typeof pId === "string" ? pId : pId?.id;
  await phone.evaluate(`(async()=>{const i=window.__TAURI_INTERNALS__.invoke;await i("purge_note",{spaceId:${J(PS)},id:${J(pid)}});return 1})()`).catch(async () => {
    await phone.evaluate(`(async()=>{const i=window.__TAURI_INTERNALS__.invoke;await i("archive_note",{spaceId:${J(PS)},id:${J(pid)}});await i("purge_note",{spaceId:${J(PS)},id:${J(pid)}});return 1})()`);
  });
  console.log("两条测试条目已删");
}

console.log(JSON.stringify({ desktopState: states, phoneState: pstates, d2pMs, p2dMs, pass: d2pMs !== null && p2dMs !== null }));
desktop.close();
phone.close();

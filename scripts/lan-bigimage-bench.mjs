// 大图跨端到达耗时的 A/B 台架(lan-direct-plan §11「大图直传耗时对比」,L-d 下半)。
//
// 为什么单独一支而不是拼 desktop-cdp.mjs + android-cdp.mjs:那两支是「一次调用一个进程」,
// 每次 node 冷启动 ~200ms,而本测量的判据就是毫秒。这里对两端各开一条**常驻** CDP 会话,
// 全部时刻在同一个进程的同一个时钟里取,进程启动开销不进判据。
//
// 判据怎么来的(照 262 那条教训:判据链路上每一跳都要有独立证据):
//   ① 先建条目(小 op)并**等它到达手机**——把条目传播与图字节传播分开,量的才是 blob 那一段。
//   ② 手机侧**页内**装一枚 100ms 轮询探针,记下首次 list_item_images 非空的时刻(手机自己的
//      时钟,故不受两机墙钟偏差影响)。
//   ③ 桌面 attach 返回后驱动侧记一个时刻;探针 t0 与它的差(驱动侧本地时钟量的)当作起跑线
//      修正量扣掉——扣掉的是「装探针→桌面本地写完 8MB」这一段,两个臂里同构,故差值可比。
//   ④ 末了用 get_item_image 的字节数**对账**,证明到的是整张图不是半截行。
//
// 用法:
//   node scripts/lan-bigimage-bench.mjs --desktop-space <id> --phone-space <id> \
//        --label lan --mb 8 [--keep]
// 前置:桌面带 --remote-debugging-port=9223 起、手机 devtools 包 + android-cdp.mjs forward。
// 默认量完即删条目(--keep 保留)。

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const DESKTOP_SPACE = arg("--desktop-space");
const PHONE_SPACE = arg("--phone-space");
const LABEL = arg("--label", "run");
const MB = Number(arg("--mb", "8"));
const KEEP = argv.includes("--keep");
if (!DESKTOP_SPACE || !PHONE_SPACE) throw new Error("必须给 --desktop-space 与 --phone-space");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 一条常驻 CDP 页面会话。 */
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
      const to = setTimeout(() => rej(new Error(`CDP 超时(${port}):${expression.slice(0, 60)}`)), timeoutMs);
      const on = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id !== id) return;
        clearTimeout(to);
        ws.removeEventListener("message", on);
        if (m.error) return rej(new Error(JSON.stringify(m.error)));
        const r = m.result;
        if (r.exceptionDetails) return rej(new Error("页面异常:" + JSON.stringify(r.exceptionDetails)));
        res(r.result.value);
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

const desktop = await connect(9223, (u) => u.includes("notebook"));
const phone = await connect(9222, () => true);

const marker = `LAN-BENCH-${LABEL}-${process.pid}`;
const log = (...a) => console.log(...a);

// ---- ① 建条目并等它到手机 ----
const itemId = await desktop.evaluate(`(async()=>{
  const i=window.__TAURI_INTERNALS__.invoke;
  await i("set_foreground_space",{spaceId:${JSON.stringify(DESKTOP_SPACE)}});
  return await i("capture_note",{spaceId:${JSON.stringify(DESKTOP_SPACE)},content:${JSON.stringify(marker)}});
})()`);
log(`条目已建:${itemId}(${marker})`);

const itemDeadline = Date.now() + 60000;
let itemArrived = false;
while (Date.now() < itemDeadline) {
  const hits = await phone.evaluate(`(async()=>{
    const i=window.__TAURI_INTERNALS__.invoke;
    const r=await i("search_notes",{spaceId:${JSON.stringify(PHONE_SPACE)},query:${JSON.stringify(marker)}});
    return r.length;
  })()`);
  if (hits > 0) {
    itemArrived = true;
    break;
  }
  await sleep(200);
}
if (!itemArrived) throw new Error("条目 60s 内没到手机——先查两端 sync_status,别把工装当产品的患");
log("条目已到手机,开始量图字节");

// ---- ② 手机侧装探针 ----
await phone.evaluate(`(()=>{
  window.__lanProbe = { t0: Date.now(), found: null, polls: 0, err: null };
  const i = window.__TAURI_INTERNALS__.invoke;
  const tick = async () => {
    if (window.__lanProbe.found) return;
    window.__lanProbe.polls++;
    try {
      const r = await i("list_item_images",{spaceId:${JSON.stringify(PHONE_SPACE)},itemId:${JSON.stringify(itemId)}});
      if (r && r.length) { window.__lanProbe.found = Date.now(); return; }
    } catch (e) { window.__lanProbe.err = String(e); }
    setTimeout(tick, 100);
  };
  tick();
  return true;
})()`);
const tArmReturned = Date.now();

// ---- ③ 桌面造图并挂上 ----
const px = Math.round(Math.sqrt((MB * 1024 * 1024) / 3));
const attach = await desktop.evaluate(`(async()=>{
  const i=window.__TAURI_INTERNALS__.invoke;
  const W=${px},H=${px};
  const c=document.createElement("canvas");c.width=W;c.height=H;
  const ctx=c.getContext("2d");
  const img=ctx.createImageData(W,H);
  const d=img.data;
  // 自带 LCG 填噪声:随机数据几乎不可压,PNG 出来的字节数才真接近目标 MB
  // (crypto.getRandomValues 单次上限 65536,循环调它更慢)。
  let s=0x2545f491;
  for(let p=0;p<d.length;p+=4){
    s=(s*1664525+1013904223)>>>0;
    d[p]=s&255; d[p+1]=(s>>8)&255; d[p+2]=(s>>16)&255; d[p+3]=255;
  }
  ctx.putImageData(img,0,0);
  const url=c.toDataURL("image/png");
  const b64=url.slice(url.indexOf(",")+1);
  const t0=Date.now();
  const meta=await i("add_item_image",{spaceId:${JSON.stringify(DESKTOP_SPACE)},itemId:${JSON.stringify(itemId)},mime:"image/png",dataB64:b64});
  return {imageId:meta.id, seq:meta.seq, bytes:Math.floor(b64.length*3/4), attachMs:Date.now()-t0};
})()`);
const tAttachReturned = Date.now();
const startupOffset = tAttachReturned - tArmReturned; // 驱动本地时钟,无跨机偏差
log(`图已挂上:${attach.imageId}  ${(attach.bytes / 1024 / 1024).toFixed(2)} MB(桌面本地写 ${attach.attachMs}ms)`);

// ---- ④ 等手机探针命中 ----
const blobDeadline = Date.now() + 180000;
let probe = null;
while (Date.now() < blobDeadline) {
  probe = await phone.evaluate(`JSON.stringify(window.__lanProbe)`).then(JSON.parse);
  if (probe.found) break;
  await sleep(250);
}
if (!probe || !probe.found) throw new Error(`图字节 180s 内没到手机(轮询 ${probe?.polls} 次,err=${probe?.err})`);

const rawMs = probe.found - probe.t0; // 手机自己的时钟,跨机偏差不进这一格
const netMs = rawMs - startupOffset;

// ---- ⑤ 字节对账:到的是整张图 ----
const gotBytes = await phone.evaluate(`(async()=>{
  const i=window.__TAURI_INTERNALS__.invoke;
  const metas=await i("list_item_images",{spaceId:${JSON.stringify(PHONE_SPACE)},itemId:${JSON.stringify(itemId)}});
  const url=await i("get_item_image",{spaceId:${JSON.stringify(PHONE_SPACE)},imageId:metas[0].id});
  const b64=url.slice(url.indexOf(",")+1);
  return Math.floor(b64.length*3/4);
})()`);

const result = {
  label: LABEL,
  itemId,
  imageId: attach.imageId,
  // 单位一律 MiB(1024²)。别写成 MB——判据要跟 LAN_LINK_QUEUE_BYTES = 8 MiB 这个
  // 二进制上界直接比大小,混单位会把「刚好卡在界上」读成「界下却挂了」。
  mebibytes: +(attach.bytes / 1024 / 1024).toFixed(2),
  desktopBytes: attach.bytes,
  phoneBytes: gotBytes,
  bytesMatch: gotBytes === attach.bytes,
  desktopLocalWriteMs: attach.attachMs,
  rawMs,
  startupOffsetMs: startupOffset,
  arrivalMs: netMs,
  throughputMiBps: +(attach.bytes / 1024 / 1024 / (netMs / 1000)).toFixed(2),
  probePolls: probe.polls,
};
log("\n" + JSON.stringify(result, null, 2));
if (!result.bytesMatch) log("\n⚠ 字节数对不上——到的不是整张图,上面的耗时不可当结论");

if (!KEEP) {
  await desktop.evaluate(`(async()=>{
    const i=window.__TAURI_INTERNALS__.invoke;
    await i("delete_note",{spaceId:${JSON.stringify(DESKTOP_SPACE)},id:${JSON.stringify(itemId)}});
    return true;
  })()`);
  log("测试条目已删(两端随同步清)");
}

desktop.close();
phone.close();

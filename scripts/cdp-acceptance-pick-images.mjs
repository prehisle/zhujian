// 391 相册多选 / 当场拍照的回归网(backlog 测试与工装 2)。
//
// 为什么此前没有:相册与相机是**系统模态**,CDP 从点下去那一刻起全程失明,只能靠
// `adb tap` 量屏幕坐标,而坐标绑「设备分辨率 + ROM」——写死进资产不划算(391 记的账)。
// 本资产换了一条路:**在系统选择器弹出之前把它拦下**,于是一个坐标都不需要。三件套:
//   Page.setInterceptFileChooserDialog{enabled:true}  弹窗被拦下,改发 Page.fileChooserOpened
//   Runtime.evaluate{userGesture:true}                合成 click 带上手势位,input.click() 才真去弹
//   DOM.setFileInputFiles{backendNodeId,files}        把设备上的真文件塞回那个 input,change 真发
// 三件在安卓 WebView(MuMu / SDK 35)上实测都在。
//
// ⚠ 诚实边界(三条,别把本资产的绿读大):
//  ① 拦下之后**系统那半就没跑**。本资产证的是「我们交出去的是什么」(chooser 的 mode +
//     那个 input 身上的 multiple / accept / capture 三个属性)与「拿回来之后我们怎么处理」;
//     **不证明**系统真开的是相机还是相册 —— 那半仍归 391 那条判据(拿掉 manifest 的
//     `<queries>` 会静默退化成相册,界面毫无异样):`adb shell dumpsys window | grep mCurrentFocus`,
//     见 skill `zhujian-android-verify`「原生模态类验收」。
//  ② 覆盖两个入口(compose 记灵感 / 卡片操作面)的相册与拍照按钮,不覆盖权限框。
//  ③ 要 devtools 包(发版包 WebView 不可调试)。
//
// 跑法(前置三步照旧):
//   node scripts/build-android.mjs --devtools
//   adb install -r android/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
//   adb shell monkey -p app.zhujian.notebook -c android.intent.category.LAUNCHER 1
//   node scripts/android-cdp.mjs forward
//   node scripts/cdp-acceptance-pick-images.mjs      # 打印 {pass, steps};pass=true 才算过
// 多台设备同连时 `export ANDROID_SERIAL=<serial>`(与 android-cdp.mjs 同一个出口)。
//
// 阴性对照(改完记得还回去):把 android/src/images.ts 里 `el.multiple = true` 删掉 ⇒ 第 1 步
// 当场红在 `mode=selectSingle`;把 `accept` 改成 `image/png` ⇒ 第 6 步红(wry 认 capture 的
// 前提就是 accept 恰为 image/*,改坏它=拍照静默退化成相册)。
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";

const PORT = 9222;
const PKG = "app.zhujian.notebook";
const DEV_DIR = `/sdcard/Android/data/${PKG}/files/pickseed`;
const PICK_MAX = 9; // 与 android/src/images.ts 同一个数;超上界那步靠它取 N=PICK_MAX+1

// execFile 直调 adb.exe、参数逐个透传 ⇒ 不过 bash/MSYS,/sdcard 路径不被 Git Bash 转成 C:\
// (memory `gitbash-slash-flag-conversion-trap`:本资产写第一版时就栽了一次)。
// 异步不同步:同步 exec 会把事件循环堵死(memory `self-service-probe-sync-exec-deadlock`)。
const execFileAsync = promisify(execFile);
const adb = (args) => execFileAsync("adb", args, { encoding: "utf8", maxBuffer: 1 << 24 });

// ---- 种子图:纯 node 造 PNG(无外部依赖) -------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** w×h 的 RGBA PNG。`noisy` 时逐像素铺伪随机字节 —— 降采样那步要的是「JPEG 重编码后
 *  **更小**」,纯色 PNG 只有几十 KB、重编码反而更大,`downsampleForUpload` 会按设计
 *  放行原图,那一步就永远验不到(第一版真栽在这)。 */
function makePng(w, h, [r, g, b], noisy = false) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  let seed = 0x2545f491;
  for (let y = 0; y < h; y++) {
    const row = y * (w * 4 + 1);
    raw[row] = 0; // filter none
    for (let x = 0; x < w; x++) {
      const o = row + 1 + x * 4;
      if (noisy) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        raw[o] = seed & 0xff;
        raw[o + 1] = (seed >>> 8) & 0xff;
        raw[o + 2] = (seed >>> 16) & 0xff;
      } else {
        raw[o] = r;
        raw[o + 1] = g;
        raw[o + 2] = b;
      }
      raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function seed() {
  const dir = mkdtempSync(join(tmpdir(), "zj-pickseed-"));
  const files = [
    ["s1.png", makePng(40, 40, [204, 51, 51])],
    ["s2.png", makePng(120, 120, [51, 102, 204])],
    // 长边 2600 > UPLOAD_MAX_EDGE(2560)⇒ 必过降采样主闸;噪声保证重编码后真的更小。
    ["s3.png", makePng(2600, 1000, [0, 0, 0], true)],
  ];
  for (let i = 1; i <= PICK_MAX + 1; i++) files.push([`m${i}.png`, makePng(8, 8, [i * 20, 90, 90])]);
  for (const [name, buf] of files) writeFileSync(join(dir, name), buf);
  await adb(["shell", "mkdir", "-p", DEV_DIR]);
  for (const [name] of files) await adb(["push", join(dir, name), `${DEV_DIR}/${name}`]);
  rmSync(dir, { recursive: true, force: true });
  return Object.fromEntries(files.map(([name]) => [name, `${DEV_DIR}/${name}`]));
}

// ---- CDP 会话(一条连接跑到底:拦截是会话级开关,断了就复原) ------------------
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
  const waiters = new Set();
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method) for (const w of [...waiters]) w(m);
  });
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
  /** 等一条事件(先挂钩再触发,免竞态)。 */
  const nextEvent = (method, ms = 8000) =>
    new Promise((res, rej) => {
      const to = setTimeout(() => {
        waiters.delete(w);
        rej(new Error(`没等到 ${method}`));
      }, ms);
      const w = (m) => {
        if (m.method !== method) return;
        waiters.delete(w);
        clearTimeout(to);
        res(m.params);
      };
      waiters.add(w);
    });
  return { send, nextEvent, close: () => ws.close() };
}

const main = async () => {
  const out = { pass: false, steps: [] };
  const step = (name, ok, detail = "") => {
    out.steps.push({ name, ok: !!ok, detail: String(detail) });
    return !!ok;
  };

  const S = await seed();
  const cdp = await connect();
  const { send, nextEvent } = cdp;

  /** 页内跑一段 JS 取值(默认不带手势位)。 */
  const evalJs = async (expression, userGesture = false) => {
    const r = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "页内抛异常");
    return r.result?.value;
  };
  const until = async (fn, ms = 8000) => {
    const t0 = Date.now();
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() - t0 > ms) return null;
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  /** 点某个按钮 → 拦下它弹出来的选择器 → 交回 {mode, 属性表, 塞文件的手}。 */
  const openChooser = async (clickJs) => {
    const ev = nextEvent("Page.fileChooserOpened");
    await evalJs(clickJs, true); // ⚠ 手势位:没有它 input.click() 一声不响什么都不发生
    const { mode, backendNodeId } = await ev;
    // ⚠ 走 describeNode 而不是 getAttributes:后者只吃 nodeId(要先 getDocument 把整棵树
    // 拉进前端的节点表),而 fileChooserOpened 给的是 backendNodeId,describeNode 直接认。
    const { node } = await send("DOM.describeNode", { backendNodeId });
    const attributes = node.attributes ?? [];
    const attrs = {};
    for (let i = 0; i < attributes.length; i += 2) attrs[attributes[i]] = attributes[i + 1];
    return {
      mode,
      attrs,
      setFiles: (paths) => send("DOM.setFileInputFiles", { files: paths, backendNodeId }),
    };
  };

  let itemId = null;
  let space = null;
  try {
    await send("Page.enable");
    await send("DOM.enable");
    await send("Page.setInterceptFileChooserDialog", { enabled: true });

    // ---- 前置:等启动闸走完 + 停在主时间轴(有面盖着时 compose 那排按钮点不着) ----
    // ⚠ 刚 `adb install -r` 完的那次首启要十几秒(dex 优化 + 各空间前滚检查),这期间
    // `list_spaces` 报的是 `state not managed for field coord`。**那不是失败,是没就绪** ——
    // 第一版直接抛,把「跑早了」读成了产品红,故这里改成轮询等它。
    const boot = await until(async () => {
      const j = await evalJs(`(async () => {
        const g = document.getElementById("gate");
        if (!g.hidden) return JSON.stringify({ ready: false, why: "启动闸还没过" });
        try {
          const s = await window.__TAURI__.core.invoke("list_spaces");
          const cur = (s.find((x) => x.current) || {}).id ?? "";
          return JSON.stringify({
            ready: !!cur,
            space: cur,
            pane: document.body.classList.contains("pane-open"),
            addimg: !!document.getElementById("compose-addimg"),
            photo: !!document.getElementById("compose-photo"),
          });
        } catch (e) {
          return JSON.stringify({ ready: false, why: String(e) });
        }
      })()`);
      const o = JSON.parse(j);
      return o.ready ? o : null;
    }, 40000);
    if (!step("前置:启动闸已过、拿到前台空间", !!boot, boot ? boot.space : "40s 内没就绪")) return out;
    if (!step("前置:停在主时间轴、两个入口都在", !boot.pane && boot.addimg && boot.photo, JSON.stringify(boot)))
      return out;
    space = boot.space;
    // 上一轮跑剩的暂存图会把「张数」这类断言整条翻掉(396 同族的隐藏入参),先清干净。
    await evalJs(`(() => {
      const del = [...document.querySelectorAll("#compose-thumbs .cthumb-del")];
      del.forEach((b) => b.click());
      return del.length;
    })()`);

    // ---- ① compose「加图」= 相册多选:交出去的是 multiple + accept=image/* ----
    const c1 = await openChooser(`document.getElementById("compose-addimg").click()`);
    step("① compose 加图:chooser mode=selectMultiple", c1.mode === "selectMultiple", c1.mode);
    step("① 那个 input 身上有 multiple", "multiple" in c1.attrs, JSON.stringify(c1.attrs));
    step("① accept 恰为 image/*(wry 认 capture 的前提)", c1.attrs.accept === "image/*", c1.attrs.accept ?? "");

    // ---- ② 塞 3 张真文件 → 暂存条一张不少(391「三选二」那笔悬案的网) ----
    await c1.setFiles([S["s1.png"], S["s2.png"], S["s3.png"]]);
    const thumbs = await until(async () => {
      const n = await evalJs(`document.querySelectorAll("#compose-thumbs .cthumb").length`);
      return n === 3 ? n : 0;
    }, 20000);
    if (!step("② 多选 3 张 → 暂存条 3 张", thumbs === 3, `实得 ${thumbs ?? await evalJs(`document.querySelectorAll("#compose-thumbs .cthumb").length`)}`))
      return out;

    // ---- ③ 记下 → 三张全入库,seq 连续 1..3(失败的写入不消耗编号 ⇒ 断号即漏写) ----
    const marker = `【CDP验收】相册多选 ${Date.now()}`;
    await evalJs(`(() => {
      const ta = document.getElementById("text");
      ta.value = ${JSON.stringify(marker)};
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("save").click();
      return "saved";
    })()`);
    const card = await until(
      async () =>
        await evalJs(
          `(() => {
            const c = [...document.querySelectorAll("#timeline [data-id]")]
              .find(x => (x.querySelector(".content")?.textContent ?? "").includes(${JSON.stringify(marker)}));
            return c ? c.dataset.id : "";
          })()`,
        ),
      15000,
    );
    if (!step("③ 记下入时间轴", !!card, card ?? "")) return out;
    itemId = card;
    const metas = await until(async () => {
      const j = await evalJs(
        `window.__TAURI__.core.invoke("list_item_images", { spaceId: ${JSON.stringify(space)}, itemId: ${JSON.stringify(card)} }).then(JSON.stringify)`,
      );
      const arr = JSON.parse(j);
      return arr.length === 3 ? arr : null;
    }, 30000);
    if (!step("③ 三张全挂上条目", !!metas, metas ? JSON.stringify(metas.map((m) => m.seq)) : "未达 3 张"))
      return out;
    step("③ seq 连续 1..3(不断号=一张都没漏写)", metas.map((m) => m.seq).join(",") === "1,2,3", metas.map((m) => m.seq).join(","));

    // ---- ④ 降采样主闸:2600 长边那张入库后 ≤2560 且已转 JPEG ----
    const big = metas[2];
    const dims = await evalJs(`(async () => {
      const url = await window.__TAURI__.core.invoke("get_item_image", { spaceId: ${JSON.stringify(space)}, imageId: ${JSON.stringify(big.id)} });
      const im = new Image();
      await new Promise((res, rej) => { im.onload = res; im.onerror = rej; im.src = url; });
      return im.naturalWidth + "x" + im.naturalHeight;   // ⚠ 只回尺寸:那个 dataURL 有几 MB,整份序列化会把工具输出撑爆
    })()`);
    step("④ 超边长图入库前被缩到 ≤2560", Number(dims.split("x")[0]) <= 2560, dims);
    step("④ 且重编码成 JPEG", big.mime === "image/jpeg", big.mime);

    // ---- ⑤ 超上界:选 10 张 ⇒ 一张都不收(不是静默截断掉前 9 张) ----
    const c5 = await openChooser(`document.getElementById("compose-addimg").click()`);
    await c5.setFiles(Array.from({ length: PICK_MAX + 1 }, (_, i) => S[`m${i + 1}.png`]));
    const errShown = await until(async () => await evalJs(`!document.getElementById("error").hidden`), 8000);
    const held = await evalJs(`document.querySelectorAll("#compose-thumbs .cthumb").length`);
    step(`⑤ 选 ${PICK_MAX + 1} 张 → 响亮拒(错误条出现)`, !!errShown, errShown ? "已出" : "没出");
    step("⑤ 且一张都没收进暂存条", held === 0, `暂存条 ${held} 张`);

    // ---- ⑥ compose「拍照」:capture=environment + accept=image/*,且不是多选 ----
    const c6 = await openChooser(`document.getElementById("compose-photo").click()`);
    step("⑥ 拍照:capture=environment", c6.attrs.capture === "environment", JSON.stringify(c6.attrs));
    step("⑥ 拍照:accept 恰为 image/*", c6.attrs.accept === "image/*", c6.attrs.accept ?? "");
    step("⑥ 拍照不是多选", c6.mode === "selectSingle" && !("multiple" in c6.attrs), c6.mode);
    await c6.setFiles([]); // 空 = 取消,回到「什么都没加」

    // ---- ⑦ 卡片操作面「加图」:第二个入口同样是多选,且 seq 从 4 接着走(编号不复用) ----
    await evalJs(`(() => {
      const c = document.querySelector('#timeline [data-id="' + ${JSON.stringify(itemId)} + '"]');
      if (!c.querySelector(".panel")) c.querySelector(".content").click();  // ⚠ 面板可能本来就开着,再点是收
      return "opened";
    })()`);
    const hasBtn = await until(
      async () => await evalJs(`!!document.querySelector('#timeline [data-id="' + ${JSON.stringify(itemId)} + '"] .panel [data-pact="addimg"]')`),
    );
    if (!step("⑦ 卡片操作面开着且有「加图」", !!hasBtn)) return out;
    const c7 = await openChooser(
      `document.querySelector('#timeline [data-id="' + ${JSON.stringify(itemId)} + '"] .panel [data-pact="addimg"]').click()`,
    );
    step("⑦ 卡片面加图也是多选", c7.mode === "selectMultiple" && "multiple" in c7.attrs, c7.mode);
    await c7.setFiles([S["s1.png"], S["s2.png"]]);
    const metas2 = await until(async () => {
      const j = await evalJs(
        `window.__TAURI__.core.invoke("list_item_images", { spaceId: ${JSON.stringify(space)}, itemId: ${JSON.stringify(itemId)} }).then(JSON.stringify)`,
      );
      const arr = JSON.parse(j);
      return arr.length === 5 ? arr : null;
    }, 30000);
    step("⑦ 两张续挂上(共 5 张)", !!metas2, metas2 ? JSON.stringify(metas2.map((m) => m.seq)) : "未达 5 张");
    if (metas2)
      step("⑦ seq 接着 4,5(编号不复用、不重排)", metas2.map((m) => m.seq).join(",") === "1,2,3,4,5", metas2.map((m) => m.seq).join(","));

    out.pass = out.steps.every((s) => s.ok);
    return out;
  } finally {
    // 清场:拦截关掉、造的条目删净、种子文件撤走。任一步失败都不许拦住其余清理。
    try {
      await send("Page.setInterceptFileChooserDialog", { enabled: false });
      // 中途出错时,那次 openPicker 的 Promise 永远不会 settle,它造的隐藏 input 就留在
      // DOM 里(不影响下一轮,但别给下一个人留垃圾)。
      await evalJs(`document.querySelectorAll('body > input[type=file]').forEach(el => el.remove()); "cleaned"`);
    } catch {}
    if (itemId && space) {
      try {
        await evalJs(
          `window.__TAURI__.core.invoke("archive_note", { spaceId: ${JSON.stringify(space)}, id: ${JSON.stringify(itemId)} })
             .then(() => window.__TAURI__.core.invoke("purge_note", { spaceId: ${JSON.stringify(space)}, id: ${JSON.stringify(itemId)} }))
             .then(() => "purged")`,
        );
        await evalJs(`location.reload()`).catch(() => {});
      } catch (e) {
        out.steps.push({ name: "清场:删掉造的条目", ok: false, detail: String(e.message) });
        out.pass = false;
      }
    }
    try {
      await adb(["shell", "rm", "-rf", DEV_DIR]);
    } catch {}
    cdp.close();
  }
};

const res = await main();
console.log(JSON.stringify(res, null, 2));
process.exit(res.pass ? 0 : 1);

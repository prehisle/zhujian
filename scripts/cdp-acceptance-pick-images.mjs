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
// **用户面 36 起本资产多守一根轴:加图那条路的「手感」。**从「选中 / 拍完」到「缩略图上屏」
// 中间隔着一趟主线程降采样(相机原图 4000×3000),此前那几秒屏上一个像素都不动、图再硬切
// 上屏(用户实报「体验感觉没添加好,突然又出现了图片」),且暂存缩略图点不开大图(桌面
// `src/item-images.ts` 从 53 起就能点)。新增四格:占位骨架 / 淡入真在跑 / 骨架态不给「×」
// 也不开大图 / 暂存图能点开且那里的「删除」= 移除。
//
// ⚠ 诚实边界(五条,别把本资产的绿读大):
//  ① 拦下之后**系统那半就没跑**。本资产证的是「我们交出去的是什么」(chooser 的 mode +
//     那个 input 身上的 multiple / accept / capture 三个属性)与「拿回来之后我们怎么处理」;
//     **不证明**系统真开的是相机还是相册 —— 那半仍归 391 那条判据(拿掉 manifest 的
//     `<queries>` 会静默退化成相册,界面毫无异样):`adb shell dumpsys window | grep mCurrentFocus`,
//     见 skill `zhujian-android-verify`「原生模态类验收」。
//  ② 覆盖两个入口(compose 记灵感 / 卡片操作面)的相册与拍照按钮,不覆盖权限框。
//  ③ 要 devtools 包(发版包 WebView 不可调试)。
//  ④ **量不到「用户等了几秒」**:那几秒跨三段(相机 Activity 退出 → WebView 恢复 → change
//     触发 → 降采样完),前两段是 ROM 与 wry 的,拦截把它们整个跳过了。本资产只证「第三段
//     一开始屏上就有东西在动」,⛔ 别读成「等待变短了」。
//  ⑤ 淡入那格量的是 `getComputedStyle().opacity` 的中间值,**要求元素真在渲染** —— 故新增
//     的前置里先把捕获层开起来。层收着时 `display:none` 祖先下过渡根本不跑,那时候量出来
//     的恒是 0 或 1,断言会安静地变成空测。
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
  /** 原生管线轻点(CSS 坐标)。合成 click 只证「JS 监听挂上了」,不证「手指点下去命中的
   *  是它」—— 缩略图上正压着一枚「×」,那一格必须走真触摸(skill「触区类验收」§3)。 */
  const tap = async (x, y) => {
    const p = [{ x, y, radiusX: 4, radiusY: 4, force: 1, id: 1 }];
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: p });
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  /** 取元素中心的 CSS 坐标;取不到(不在 DOM / 零盒)返回 null。 */
  const centerOf = async (sel) => {
    const j = await evalJs(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return "";
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return "";
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    })()`);
    return j ? JSON.parse(j) : null;
  };
  const tapSel = async (sel) => {
    const c = await centerOf(sel);
    if (!c) return false;
    await tap(c.x, c.y);
    return true;
  };
  /** 把捕获层弄开;开着就什么都不做。
   *  ⚠ **`记下` 成功会自动收层**(save() 末尾的 dismissCapture),所以这不是「开一次就完了」——
   *  层收着时暂存条被推到视口外(MuMu 横屏 1138×640,收起态的卡在 y≈770),原生轻点当场
   *  打空,而打空的样子是「大图没开」= 看着像功能没做。⑧ 第一次跑就是这么红的。 */
  const ensureComposeOpen = async () => {
    const isOpen = () => evalJs(`document.getElementById("compose-card").classList.contains("open")`);
    if (await isOpen()) return true;
    await tapSel("#capture-fab");
    return !!(await until(isOpen, 6000));
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

    // ---- 前置:把捕获层开起来(用户面 36 那四格要它)-------------------------------
    // ⚠ 层收着时 `#compose-card` 落在 `display:none` 的祖先下 —— **CSS 过渡根本不跑**,
    // 淡入那格量出来的 opacity 恒是 0 或 1,断言会安静地变成**空测**(不是红)。
    // 真实流程本来也是「点 ＋ 开层 → 写字 → 加图」,开着它同时更忠实于用户那条路。
    const layerOpen = await ensureComposeOpen();
    if (!step("前置:捕获层已开(过渡才跑得起来)", layerOpen, String(layerOpen))) return out;

    // ---- ① compose「加图」= 相册多选:交出去的是 multiple + accept=image/* ----
    const c1 = await openChooser(`document.getElementById("compose-addimg").click()`);
    step("① compose 加图:chooser mode=selectMultiple", c1.mode === "selectMultiple", c1.mode);
    step("① 那个 input 身上有 multiple", "multiple" in c1.attrs, JSON.stringify(c1.attrs));
    step("① accept 恰为 image/*(wry 认 capture 的前提)", c1.attrs.accept === "image/*", c1.attrs.accept ?? "");

    // ---- ①b 阴性对照:取图在飞时再点一次,**不该**再弹一个选择器 --------------------
    // 没有这道闸,`await` 期间按钮照样可点 —— 而降采样是几秒的主线程活,那几秒正是最容易
    // 被再戳一下的时候,戳中了就是两个系统选择器叠着弹。
    let second = false;
    try {
      const ev2 = nextEvent("Page.fileChooserOpened", 1500);
      await evalJs(`document.getElementById("compose-addimg").click()`, true);
      await ev2;
      second = true;
    } catch {
      /* 没等到 = 正是要的结果 */
    }
    step("①b 取图在飞时再点「加图」→ 不再弹第二个选择器", !second, second ? "又弹了一个" : "没弹");

    // ---- ② 塞 3 张真文件 → 暂存条一张不少(391「三选二」那笔悬案的网) ----
    // ⚠ **观察器必须在 setFiles 之前挂**:`reserve()` 在第一张降采样**之前**同步跑,事后
    // 轮询会整段错过那个窗口,而错过的样子是 `maxPending=0` —— 读起来像「功能没做」。
    await evalJs(`(() => {
      window.__probeStop?.();   // 重装前先断旧的:不断的话每重跑一轮就多一个观察器、采样翻倍(246 判例)
      const box = document.getElementById("compose-thumbs");
      const p = { maxPending: 0, delDisplay: null, saveDisabled: null, pendingOpensViewer: null, opac: [] };
      window.__probe = p;
      const sampled = new WeakSet();
      const obs = new MutationObserver(() => {
        const pend = box.querySelectorAll(".cthumb.pending");
        if (pend.length > p.maxPending) {
          p.maxPending = pend.length;
          p.delDisplay = getComputedStyle(pend[0].querySelector(".cthumb-del")).display;
          p.saveDisabled = document.getElementById("save").disabled;
          pend[pend.length - 1].click();   // 骨架点了不该开大图(那时候还没有字节可看)
          p.pendingOpensViewer = !document.getElementById("viewer").hidden;
        }
        for (const img of box.querySelectorAll(".cthumb img.in")) {
          if (sampled.has(img)) continue;
          sampled.add(img);
          const t0 = performance.now();
          const tick = () => {
            p.opac.push(Number(getComputedStyle(img).opacity));
            if (performance.now() - t0 < 500) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }
      });
      obs.observe(box, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
      window.__probeStop = () => obs.disconnect();
      return "armed";
    })()`);
    await c1.setFiles([S["s1.png"], S["s2.png"], S["s3.png"]]);
    // ⚠ 数的是 `:not(.pending)` —— **用户面 36 起 `.cthumb` 也包括还没有字节的骨架**,
    // 照旧数 `.cthumb` 的话这一格会在降采样跑完之前就变绿(而下面 ③ 随即红在
    // 「三张全挂上条目」:`记下` 抢在降采样前头,只挂上了一张)。真机上第一次跑就是这么红的。
    const thumbs = await until(async () => {
      const n = await evalJs(`document.querySelectorAll("#compose-thumbs .cthumb:not(.pending)").length`);
      return n === 3 ? n : 0;
    }, 30000);
    if (!step("② 多选 3 张 → 暂存条 3 张就绪", thumbs === 3, `实得 ${thumbs ?? await evalJs(`document.querySelectorAll("#compose-thumbs .cthumb:not(.pending)").length`)}`))
      return out;

    // ---- ②a-e 加图那条路的「手感」(用户面 36)-------------------------------------
    await new Promise((r) => setTimeout(r, 700)); // 等最后一张的 opacity 采样跑完
    const probe = JSON.parse(await evalJs(`JSON.stringify(window.__probe)`));
    step("②a 选中那一刻先摆了 3 个骨架(不是干等几秒)", probe.maxPending === 3, `maxPending=${probe.maxPending}`);
    step("②b 骨架态不给「×」(还没有字节可摘)", probe.delDisplay === "none", String(probe.delDisplay));
    step("②c 骨架点了不开大图", probe.pendingOpensViewer === false, String(probe.pendingOpensViewer));
    step("②d 骨架摆着时「记下」是禁的(否则 takeBatch 静默分批)", probe.saveDisabled === true, String(probe.saveDisabled));
    // ⚠ 只断言「.in 挂上了」远远不够:选择器写错时 opacity 恒 1、断言照样绿。必须抓到
    // (0,1) 之间的中间值才证明过渡**真在跑**(skill「触区类验收」§2 同一条)。
    const op = probe.opac ?? [];
    const mid = op.filter((v) => v > 0.02 && v < 0.98).length;
    step(
      "②e 缩略图是淡入不是硬切(抓到 opacity 中间值)",
      op.length > 3 && mid > 0 && Math.min(...op) < 0.5 && Math.max(...op) > 0.95,
      op.length ? `采样 ${op.length} 个 · 中间值 ${mid} 个 · 区间 [${Math.min(...op).toFixed(2)}, ${Math.max(...op).toFixed(2)}]` : "一个采样都没有",
    );

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

    // ---- ⑧ 暂存图点得开大图,「删除」在那里 = 移除(用户面 36)------------------------
    // 桌面 `src/item-images.ts` 的暂存图从 53 起就点得开,安卓这一格一直空着 —— 端间漂移。
    const c8 = await openChooser(`document.getElementById("compose-addimg").click()`);
    await c8.setFiles([S["s1.png"], S["s2.png"]]);
    const ready8 = await until(async () => {
      const n = await evalJs(`document.querySelectorAll("#compose-thumbs .cthumb:not(.pending)").length`);
      return n === 2 ? n : 0;
    }, 30000);
    if (!step("⑧ 前置:暂存条 2 张就绪", ready8 === 2, `实得 ${ready8}`)) return out;
    if (!step("⑧ 前置:捕获层开着(③ 的「记下」把它收了)", await ensureComposeOpen())) return out;
    // ⚠ 打点之前先证「这一点命中的就是它」——照 skill「触区类验收」§1:元素被推出视口时
    // elementFromPoint 返回 null,那时候的轻点是打空,而打空与「功能没做」在屏幕上同形。
    const onScreen = JSON.parse(await evalJs(`(() => {
      const t = document.querySelector("#compose-thumbs .cthumb");
      if (!t) return JSON.stringify({ ok: false, why: "没有缩略图" });
      const r = t.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      return JSON.stringify({
        ok: !!hit && !!hit.closest(".cthumb"),
        at: [Math.round(cx), Math.round(cy)],
        hit: hit ? hit.className || hit.tagName : null,
        vp: [window.innerWidth, window.innerHeight],
      });
    })()`));
    if (!step("⑧ 缩略图真在屏上,中心点命中的就是它", onScreen.ok, JSON.stringify(onScreen))) return out;
    const tapped = await tapSel("#compose-thumbs .cthumb"); // 原生轻点第一张(合成 click 不算数)
    const opened = tapped
      ? await until(async () => {
          const j = await evalJs(`(() => {
            const v = document.getElementById("viewer");
            if (v.hidden) return "";
            return JSON.stringify({
              src: (document.getElementById("viewer-img").src || "").slice(0, 5),
              cap: document.getElementById("viewer-cap").textContent,
            });
          })()`);
          return j ? JSON.parse(j) : null;
        }, 8000)
      : null;
    if (!step("⑧ 原生轻点暂存缩略图 → 大图开了", !!opened, tapped ? JSON.stringify(opened) : "缩略图不在屏上,点不着")) return out;
    step("⑧ 大图读的是手上那份字节(blob:),没去查库", opened.src === "blob:", opened.src);
    // 「图N」的号是入库才发的高水位号,暂存图**还没有号** ⇒ 那一格必须说「还没记下」,
    // ⛔ 不许为了格式整齐编一个。`· 1/2` 同时证明它认得整组(不是把单张当一组)。
    // ⚠ 中英两句都**手写**在这里:测试机跟系统语言走(MuMu 是英文,第一次跑就红在这),
    // 而从 app 自己的字典取期望 = 期望与被测同源,漂了也验不出来(memory
    // `verification-independence`)。⇒ 列穷举、不做子串匹配。
    step(
      "⑧ 角标说「还没记下 · 1/2」(zh / en 任一)",
      ["还没记下 · 1/2", "Not saved yet · 1/2"].includes(opened.cap),
      String(opened.cap),
    );
    // 暂存图上那枚「删除」是**移除**不是永久销毁 ⇒ 两拍问的那句话必须不同(同一枚钮两种
    // 后果却说同一句话,就是在骗人)。⚠ 两拍**必须在同一条命令里**:确认条 6s 自动复原,
    // 跨工具调用的间隔常常就超了(skill 那条踩过两次的纪律)。
    const removed = JSON.parse(await evalJs(`(() => {
      const del = document.getElementById("viewer-del");
      const cs = getComputedStyle(del);
      const clickable = cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) > 0.5 && cs.pointerEvents !== "none";
      del.click();
      const q = document.getElementById("confirmbar-q").textContent;
      document.getElementById("confirmbar-yes").click();
      return JSON.stringify({ clickable, q });
    })()`));
    step("⑧ 大图上那枚钮真是可点的(不是被 .zoomed 规则压着)", removed.clickable === true, String(removed.clickable));
    // 两个方向都核:**是**「移除」那句 ∧ **不是**入库图那句「删了不可恢复」。只核前半的话,
    // 哪天两句被合并成一句(同一枚钮两种后果却说同一句话)这一格照样绿。
    const Q_REMOVE = ["把这张图从暂存里移除?它还没记下", "Remove this image from the draft? It hasn't been saved yet"];
    const Q_DELETE = ["删除这张图?删了不可恢复", "Delete this image? It cannot be recovered"];
    step("⑧ 两拍问的是「移除」那句,不是入库图的「删除」那句", Q_REMOVE.includes(removed.q) && !Q_DELETE.includes(removed.q), String(removed.q));
    const after8 = await until(async () => {
      const j = await evalJs(
        `JSON.stringify({ hid: document.getElementById("viewer").hidden, n: document.querySelectorAll("#compose-thumbs .cthumb").length })`,
      );
      const o = JSON.parse(j);
      return o.hid && o.n === 1 ? o : null;
    }, 8000);
    step("⑧ 移除后:大图收了、暂存条剩 1 张", !!after8, JSON.stringify(after8));
    // 收尾:最后那张也摘掉,别把状态漏给 ⑥⑦(它们的断言按「暂存条是空的」写)。
    await evalJs(`(() => { document.querySelectorAll("#compose-thumbs .cthumb-del").forEach((b) => b.click()); return "cleared"; })()`);

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
      await evalJs(`window.__probeStop?.(); delete window.__probe; "probe off"`); // 观察器不留给下一个人
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

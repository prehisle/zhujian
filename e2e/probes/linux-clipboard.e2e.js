// ⛔ **按需探针,刻意不在默认套件里**(住 `e2e/probes/`,`specs/**/*.e2e.js` 那条 glob 扫不到)
// —— 理由与 `win-clipboard.e2e.js` 同:它**真的会改写本机剪贴板**,且这支是 Linux 专属(xclip)。
//
// 补的是 backlog「测试与工装」3① —— **Linux 侧的真剪贴板 Ctrl+V 至今零回归网**。
// 395 把取图收成唯一入口 `pasteImage()` 的三支,而仓里那三支贴图 spec 全是**合成**
// ClipboardEvent ⇒ 恒走①支;而 **Linux 真机恒落③支**(WebKitGTK 的 paste 事件里
// `types`/`items`/`files` 全空,只有 `getData` 拿得到文字)—— **③支正是为 Linux 写的那条,
// 却是唯一没有网的那条**。
//
// ⭐ 与 Windows 那支的关系:**同一套判别式,期望值恰好相反**。401 在 Windows 量到
// `items:1 / prevented:true`(①支);这里要量到 `items:0 / prevented:false / types:[]`
// **而图照样收上了** —— 三格加上那个结果只有③支能解释(逐条推理见那支用例里的注释)。
// ⇒ 两台的读数合起来才是「395 三支」的完整字据。
//
// 怎么跑(先照文档退出生产朱简;fast 形要另起 `npm run dev`):
//   YS_E2E_FAST=1 npx wdio run e2e/wdio.conf.js --specFileRetries=0 --spec e2e/probes/linux-clipboard.e2e.js
import { browser, $, $$, expect } from "@wdio/globals";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goShow, clearInbox, invoke } from "../specs/support.js";
import {
  clipboardTargets,
  setClipboardImage,
  setClipboardText,
  clearClipboard,
} from "./xclip.js";

// 尺寸刻意选一对**不像默认值**的数:壳交回来的图若是别处来的,尺寸对不上当场露馅。
const W = 53;
const H = 29;
const PNG_PATH = join(tmpdir(), "zhujian-probe-clip.png");

/** 在页面里现造一张 w×h 的 PNG,落到磁盘上供 xclip 送上剪贴板。 */
async function makePngFile(w, h) {
  const b64 = await browser.execute(
    (ww, hh) => {
      const c = document.createElement("canvas");
      c.width = ww;
      c.height = hh;
      const x = c.getContext("2d");
      x.fillStyle = "#2d7d46";
      x.fillRect(0, 0, ww, hh);
      return c.toDataURL("image/png").split(",")[1];
    },
    w,
    h,
  );
  writeFileSync(PNG_PATH, Buffer.from(b64, "base64"));
  return PNG_PATH;
}

/** 只看不干预地记这次 paste 的最终 `defaultPrevented` 与 clipboardData 实况。
 *
 *  ⛔ **这里原本还想记「这次粘贴期间壳被问了哪些命令」,415 实测**不可能**,别再试**:
 *  `window.__TAURI_INTERNALS__.invoke` 是一个 **`writable:false` + `configurable:false`** 的
 *  数据属性(实测描述符 `{"writable":false,"getter":false,"configurable":false}`,对象本身
 *  没冻)⇒ ①直接赋值在 `browser.execute` 的**非严格**上下文里是**静默失败**;
 *  ②`Object.defineProperty` 抛;③换 `Proxy` 包整个 internals 也不行 —— 代理不变式规定:
 *  不可写不可配置的数据属性,`get` 陷阱**必须**返回原值,否则 TypeError。
 *  ⭐ **发现它的方式值得留下来**:第一版没自验,钩子静默没装上、`__ipc` 恒空,而②支那条
 *  「没问过壳」的**否定断言恰好因此变绿** —— 典型的假绿。加一句「装完核一下 `invoke ===
 *  我那只`,不成就带着描述符抛」当场就把真相问出来了。**否定断言必须先证明仪器活着。**
 *  ⇒ 「②支不问壳」这条设计承诺**本探针不予断言**(见文件尾「诚实边界」),不是忘了写。 */
async function armProbe() {
  await browser.execute(() => {
    window.__probe = [];
    // 冒泡相:app 装在输入框上的处理器先跑,冒到 document 时 defaultPrevented 已是最终态。
    document.addEventListener("paste", (ev) => {
      window.__probe.push({
        prevented: ev.defaultPrevented,
        types: [...(ev.clipboardData?.types ?? [])],
        items: ev.clipboardData?.items?.length ?? -1,
        text: ev.clipboardData?.getData("text/plain") ?? null,
      });
    });
  });
}

const readProbe = () => browser.execute(() => window.__probe);

describe("395 · 真剪贴板 Ctrl+V(Linux / X11 / WebKitGTK)", () => {
  // ⛔ **每例收尾都把暂存图摘干净,红了也要摘**(415 实测的连带伤):某一例半路红在自己的清场
  // 之前,那张暂存图就留在草稿里,被下一支 `goShow` 原样回填 ⇒ 后面两例跟着红,而它们**一个
  // 产品缺陷都不是**(396 那族病的另一副面孔)。清场不许写在用例尾巴上,要写在这里。
  afterEach(async () => {
    for (const del of await $$("#cap-images .img-del")) await del.click();
    await browser.waitUntil(async () => (await $$("#cap-images .img-thumb")).length === 0, {
      timeout: 5000,
      timeoutMsg: "收尾没能把暂存图摘干净,下一例会被草稿回填污染",
    });
  });

  it("③支:剪贴板上有图 → 真 Ctrl+V 异步收图,回车挂上条目", async () => {
    await goShow("/index.html");
    await clearInbox();
    console.log("clipboard:", setClipboardImage(await makePngFile(W, H)));
    // 前置对照:确认那张图**真的**在 X 选区上(不然下面的绿可能只是别处残留)。
    expect(clipboardTargets()).toContain("image/png");

    const ta = await $("#capture");
    await ta.waitForExist({ timeout: 10000 });
    await ta.click();
    await browser.keys(["Control", "v"]);

    await $("#cap-images .img-thumb").waitForExist({
      timeout: 8000,
      timeoutMsg: "真 Ctrl+V 后暂存缩略图没出现 —— Linux 的③支断了",
    });

    await ta.setValue("E2E-真剪贴板-Linux-图");
    await browser.keys("Enter");
    let noteId;
    await browser.waitUntil(
      async () => {
        const inbox = await invoke("list_inbox");
        const hit = inbox.find((n) => n.content === "E2E-真剪贴板-Linux-图");
        if (hit) noteId = hit.id;
        return !!hit;
      },
      { timeout: 8000, timeoutMsg: "回车后未入库" },
    );
    const imgs = await invoke("list_item_images", { itemId: noteId });
    console.log("入库配图:", JSON.stringify(imgs));
    expect(imgs).toHaveLength(1);
    await clearInbox();
  });

  it("③支的判别式:那次 paste **没**被拦下(items:0 / prevented:false),图却还是收上了", async () => {
    await goShow("/index.html");
    await clearInbox();
    console.log("clipboard:", setClipboardImage(await makePngFile(W, H)));
    await armProbe();

    const ta = await $("#capture");
    await ta.waitForExist({ timeout: 10000 });
    await ta.click();
    await browser.keys(["Control", "v"]);
    await $("#cap-images .img-thumb").waitForExist({ timeout: 8000 });

    const paste = await readProbe();
    console.log("PROBE:", JSON.stringify(paste));
    expect(paste).toHaveLength(1);
    // ⭐ **这三格加上「缩略图还是出来了」,唯一地指向③支**,不需要再去钩 IPC:
    //   走①的话 `prevented` 必为 true(①支同步 preventDefault);
    //   走②的话根本不会收图(直接 return,让默认粘贴插字);
    //   ⇒ 既没拦下、事件里又一个 item 都没有、图却真的挂上了 —— 只有③支能解释。
    // Windows 上这三格恰好全反过来(401 的读数:items:1 / prevented:true)。
    expect(paste[0].items).toBe(0); // ① Windows 是 1
    expect(paste[0].prevented).toBe(false); // ① Windows 是 true
    expect(paste[0].types).toEqual([]); // WebKitGTK 的 paste 事件里 types 也是空的(394 的根因)

    // 收干净:不提交的话这张暂存图会留在草稿里被下一支 goShow 回填(396 那族的病)。
    await ta.setValue("E2E-真剪贴板-Linux-判别式");
    await browser.keys("Enter");
    await browser.waitUntil(
      async () => (await invoke("list_inbox")).some((n) => n.content === "E2E-真剪贴板-Linux-判别式"),
      { timeout: 8000, timeoutMsg: "判别式那支回车后未入库" },
    );
    await clearInbox();
    expect(await $$("#cap-images .img-thumb")).toHaveLength(0);
  });

  it("②支:剪贴板上只有文字 → 真 Ctrl+V 就是贴字、不加图", async () => {
    await goShow("/index.html");
    await clearInbox();
    console.log("clipboard:", setClipboardText("LINUXCLIP-TEXT"));
    await armProbe();

    const ta = await $("#capture");
    await ta.waitForExist({ timeout: 10000 });
    await ta.click();
    await browser.keys(["Control", "v"]);
    await browser.pause(1200);

    expect(await ta.getValue()).toBe("LINUXCLIP-TEXT");
    expect(await $$("#cap-images .img-thumb")).toHaveLength(0);

    const paste = await readProbe();
    console.log("PROBE:", JSON.stringify(paste));
    expect(paste[0].prevented).toBe(false); // 放行,让默认粘贴自己插字
    expect(paste[0].text).toBe("LINUXCLIP-TEXT"); // ⭐ WebKitGTK 上文字**只**从 getData 拿得到
    expect(paste[0].items).toBe(0); // …而 items/types 照旧是空的 —— 这正是 394 锁死的那条根因
    // ⚠ ②支还承诺「**不去问壳**」(不给每次贴字都加一趟 IPC),**本探针不予断言** ——
    // 唯一的观测口 `__TAURI_INTERNALS__.invoke` 钩不上,见 `armProbe` 头上那段。
  });

  it("③支:剪贴板真空 → 真 Ctrl+V 不加图、不插字、不报错(安静收场)", async () => {
    await goShow("/index.html");
    await clearInbox();
    console.log("clipboard:", clearClipboard());
    expect(clipboardTargets()).toEqual([]); // 真空 = 选区没有 owner(不是「一段空文本」)
    await armProbe();

    const ta = await $("#capture");
    await ta.waitForExist({ timeout: 10000 });
    await ta.click();
    await ta.setValue("E2E-空剪贴板");
    await browser.keys(["Control", "v"]);
    await browser.pause(1500);

    expect(await ta.getValue()).toBe("E2E-空剪贴板");
    expect(await $$("#cap-images .img-thumb")).toHaveLength(0);
    // 395 的③支会异步问一趟壳;拿不到图应当安静 resolve null,不许弹错(`imageFromShellClipboard`
    // 的原话:「剪贴板里根本没有图是**常态**」⇒ 那一路 resolve null 不是失败)。
    expect(await $$(".toast")).toHaveLength(0);
    const paste = await readProbe();
    console.log("PROBE:", JSON.stringify(paste));
    expect(paste[0].prevented).toBe(false); // ③支刻意不拦(拦与不拦同果,那就别拦)
  });
});

// ⚠ **诚实边界**(别把这支读成「Linux 那三支全验过了」):
//  ①「②支不问壳」这条设计承诺**没有断言** —— 观测口钩不上,理由见 `armProbe` 头上那段。
//    真要补,可行的路子是从**外面**看:`xclip -verbose` 会记下每一次 SelectionRequest,
//    把它的 stderr 用 shell 重定向进文件(⛔ 别用管子,坑③),数「那次粘贴期间选区被要过几次」。
//    没做:这是一条效率承诺,红了也不影响用户看到的行为,而它要引入一个新的外部仪器。
//  ②这支验的是**capture 浮窗**那个入口;53 起「凡是能输入条目正文的地方都能 Ctrl+V 配图」
//    另有灵感与看板两个入口,走的是同一个 `pasteImage()`,但**本探针没逐个跑**。
//  ③图与文字**同时**在剪贴板上时两条路结果不同(`pasteImage` 自己的诚实边界),本支不覆盖。

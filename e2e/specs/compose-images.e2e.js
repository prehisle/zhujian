import { browser, $, $$, expect } from "@wdio/globals";
import { invoke, goNotebook, clearInbox } from "./support.js";

// 新建入口配图一致性:凡是能输入条目正文的地方,都能 Ctrl+V 配图(共享件 pendingImages)。
// 捕获浮窗一例在 capture.e2e.js;这里补另外两个新建入口 —— 灵感「记下灵感」和看板「新建任务」。
// 真 OS 剪贴板驱动不了,和捕获一例同法:合成带 File 的 paste 事件派发到输入框,走的就是
// pendingImages.wire 的真实 paste 处理器。

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// Dispatch a synthetic image paste onto the element matching `sel`.
async function pasteImage(sel) {
  await browser.execute(
    (s, b64) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], "shot.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      document.querySelector(s).dispatchEvent(ev);
    },
    sel,
    PNG,
  );
}

describe("新建入口配图 · 灵感「记下灵感」粘贴", () => {
  before(async () => {
    await goNotebook("inbox");
    await clearInbox();
  });

  it("粘贴图片 → 暂存预览;回车 → 灵感入库且带 1 张配图,预览清空", async () => {
    const input = await $(".v-inbox .compose-input");
    await input.waitForExist({ timeout: 10000 });
    await input.click();

    await pasteImage(".v-inbox .compose-input");
    // 暂存预览出现在 compose 条里(还没入库)。
    await $(".v-inbox .compose .img-pending .img-thumb").waitForExist({ timeout: 5000 });

    await input.setValue("E2E-compose-配图-灵感");
    await browser.keys("Enter"); // capture_note → attachAll

    let noteId;
    await browser.waitUntil(
      async () => {
        const ideas = await invoke("list_ideas");
        const hit = ideas.find((n) => n.content === "E2E-compose-配图-灵感");
        if (hit) noteId = hit.id;
        return !!hit;
      },
      { timeout: 6000, timeoutMsg: "回车后配图灵感未入库" },
    );
    const imgs = await invoke("list_item_images", { itemId: noteId });
    expect(imgs).toHaveLength(1);
    expect(imgs[0].seq).toBe(1);

    // 暂存条清空收起(attachAll 后 clear;refresh 重建 bar 也不会把它带回来)。
    await browser.waitUntil(
      async () => (await $$(".v-inbox .compose .img-pending .img-thumb")).length === 0,
      { timeout: 5000, timeoutMsg: "保存后暂存预览未清空" },
    );
  });
});

describe("新建入口配图 · 看板「新建任务」粘贴", () => {
  before(async () => {
    await goNotebook("board");
  });

  it("粘贴图片 → 暂存预览;回车 → 任务入库且带 1 张配图", async () => {
    // 打开 compose 条(N 键/按钮同源;按钮直点最稳)。
    const addBtn = await $("#add-task");
    await addBtn.waitForExist({ timeout: 10000 });
    await addBtn.click();
    const input = await $("#compose-input");
    await input.waitForDisplayed({ timeout: 5000 });
    await input.click();

    await pasteImage("#compose-input");
    await $(".v-board .compose .img-pending .img-thumb").waitForExist({ timeout: 5000 });

    await input.setValue("E2E-compose-配图-任务");
    await browser.keys("Enter"); // create_task → attachAll

    let taskId;
    await browser.waitUntil(
      async () => {
        const tasks = await invoke("list_tasks");
        const hit = tasks.find((t) => t.title === "E2E-compose-配图-任务");
        if (hit) taskId = hit.id;
        return !!hit;
      },
      { timeout: 6000, timeoutMsg: "回车后配图任务未入库" },
    );
    const imgs = await invoke("list_item_images", { itemId: taskId });
    expect(imgs).toHaveLength(1);
    expect(imgs[0].seq).toBe(1);

    // 收尾:归档+彻底删,不给后续 spec 留卡片(连图带计数随条目 CASCADE)。
    await invoke("archive_task", { id: taskId });
    await invoke("purge_task", { id: taskId });
  });
});

// 点暂存缩略图 → openLightboxUrl(无放大分支,笔记本窗:pendingImages 未传 openPreview)。
// 163④/166④ 把这条路径改成与 openLightbox 同一套「布局未定不显示 → 定形亮相」时序:img 出生
// 即隐形零占位,init() 定形后一次成形亮相。这里断言点开后 img 确实经 init 亮相(visibility 非
// hidden、渲染宽 == 图宽 = fit 1:1),而非停在出生隐形态。阴性对照:注掉 openLightboxUrl 的
// viewer.init() → img 停在 width:0/visibility:hidden,waitUntil 超时真红(2026-07-20 实跑验过)。
describe("新建入口配图 · 点暂存预览开 lightbox(无放大分支)", () => {
  before(async () => {
    await goNotebook("inbox");
    await clearInbox();
  });

  it("点暂存缩略图 → lightbox 按图尺寸成形亮相;Esc 关闭", async () => {
    const input = await $(".v-inbox .compose-input");
    await input.waitForExist({ timeout: 10000 });
    await input.click();

    // 造一张 400×300 真 PNG 贴进灵感 compose 条(1×1 太小看不出布局)。
    await browser.execute(async () => {
      const c = document.createElement("canvas");
      c.width = 400;
      c.height = 300;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#c33";
      ctx.fillRect(0, 0, 400, 300);
      const blob = await new Promise((res) => c.toBlob(res, "image/png"));
      const file = new File([blob], "big.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      document.querySelector(".v-inbox .compose-input").dispatchEvent(ev);
    });
    const thumb = await $(".v-inbox .compose .img-pending .img-thumb .img-thumb-img");
    await thumb.waitForExist({ timeout: 5000 });
    await thumb.click(); // → openLightboxUrl(url),无 grow 分支

    await $(".img-lightbox .img-lightbox-img").waitForExist({ timeout: 5000 });
    // 定形亮相:非隐形(init 跑过)且渲染宽 == 400(fit 1:1,图 < 视口 → 不放大)。
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const img = document.querySelector(".img-lightbox .img-lightbox-img");
          if (!img) return false;
          const cs = getComputedStyle(img);
          return cs.visibility !== "hidden" && Math.round(img.getBoundingClientRect().width) === 400;
        }),
      { timeout: 5000, timeoutMsg: "lightbox 图未定形亮相(仍隐形/非 400 宽 = init 未跑或布局错)" },
    );

    await browser.keys("Escape");
    await browser.waitUntil(async () => (await $$(".img-lightbox")).length === 0, {
      timeout: 5000,
      timeoutMsg: "Esc 未关闭 lightbox",
    });

    // 清掉暂存预览(未回车 → 未入库,只需摘预览),不给后续 spec 留状态。
    const del = await $(".v-inbox .compose .img-pending .img-del");
    if (await del.isExisting()) await del.click();
  });
});

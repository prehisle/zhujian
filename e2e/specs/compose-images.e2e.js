import { browser, $, $$, expect } from "@wdio/globals";
import { invoke, goNotebook, clearInbox, openCompose, waitItemImages, toLightbox } from "./support.js";

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
    const imgs = await waitItemImages(noteId, 1, "compose 配图·灵感");
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
    // 打开 compose 条。⚠ 别写成裸 click:`#add-task` 是开关,见 support.js 那段注释。
    await openCompose();
    const input = await $("#compose-input");
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
    const imgs = await waitItemImages(taskId, 1, "compose 配图·任务");
    expect(imgs[0].seq).toBe(1);

    // 收尾:归档+彻底删,不给后续 spec 留卡片(连图带计数随条目 CASCADE)。
    await invoke("archive_task", { id: taskId });
    await invoke("purge_task", { id: taskId });
  });
});

// 点暂存缩略图 → openLightboxBlob(笔记本窗:pendingImages 未传 openPreview,走默认 alt)。
// ⚠ 606 起遮罩在**另一只窗**里,且这条路送过去的是 **data URL**(object URL 跨不了窗)——
// 断言前必须 `toLightbox()` 切过去。400px 的图在铺满显示器的遮罩里仍是 fit 1:1(小图不放大),
// 故下面那句宽度断言照旧成立、且更不受窗口尺寸影响。
// 163④/166④ 把这条路径改成与 openLightbox 同一套「布局未定不显示 → 定形亮相」时序:img 出生
// 即隐形零占位,init() 定形后一次成形亮相。这里断言点开后 img 确实经 init 亮相(visibility 非
// hidden、渲染宽 == 图宽 = fit 1:1),而非停在出生隐形态。阴性对照:注掉那条路上的
// viewer.init() → img 停在 width:0/visibility:hidden,waitUntil 超时真红(2026-07-20 实跑验过;
// ⚠ 606 起 init 住在遮罩窗 src/lightbox.ts::renderData 里,不再是 item-images 的 openLightboxUrl)。
describe("新建入口配图 · 点暂存预览开 lightbox", () => {
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
    await thumb.click(); // → openLightboxBlob(blob) → 发事件给遮罩窗

    const back = await toLightbox();
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
    await back();

    // 清掉暂存预览(未回车 → 未入库,只需摘预览),不给后续 spec 留状态。
    const del = await $(".v-inbox .compose .img-pending .img-del");
    if (await del.isExisting()) await del.click();
  });
});

// 538(backlog 用户面 56):**挂图失败时那句话要说得准。**
// 537 量到:够得着的拒法(不支持的类型 / 过大)全是**确定性**的 —— 同样的字节再贴一次
// 还是同样被拒 ⇒ 旧那句「(可在卡片编辑态重新粘贴)」是把用户支去做一件注定失败的事;
// 而后端本来就说得出一句照着能行动的话,却在 `catch` 里只剩「N 张」。
//
// ⭐ **样本刻意是「真 PNG 字节 + 谎报 image/heic」**,不是随机字节:
//   ①真字节 ⇒ 暂存缩略图正常出得来,验的是挂图那一步而不是预览那一步;
//   ②`blob.type` 才是交给后端的 MIME(`attachBlob` 传的就是它)⇒ 后端照样按「不支持的
//     图片类型」拒 —— **这一路与用户真粘一张 HEIC 完全同形**,且不必把第三方样本搬进仓。
describe("新建入口配图 · 挂图失败时那句话说得准不准", () => {
  before(async () => {
    await goNotebook("inbox");
    await clearInbox();
  });

  it("后端不收的格式:提示要说出是哪种格式,且不许再叫人「重新粘贴」", async () => {
    const input = await $(".v-inbox .compose-input");
    await input.waitForExist({ timeout: 10000 });
    await input.click();

    await browser.execute((b64) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      // 字节是真 PNG、type 谎报 heic —— 后端看的是 type(见文件头那段)。
      const file = new File([bytes], "photo.heic", { type: "image/heic" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      document.querySelector(".v-inbox .compose-input").dispatchEvent(ev);
    }, PNG);
    await $(".v-inbox .compose .img-pending .img-thumb").waitForExist({ timeout: 5000 });

    await input.setValue("E2E-挂图失败-说得准");
    await browser.keys("Enter"); // capture_note 成功 → attachBatch 里那张图被后端拒

    // 条目本身要建成(挂图失败**不拖垮**条目,这是既有行为,顺带钉住)。
    await browser.waitUntil(
      async () => (await invoke("list_ideas")).some((n) => n.content === "E2E-挂图失败-说得准"),
      { timeout: 8000, timeoutMsg: "挂图失败时条目本身也没建成" },
    );

    // 提示过桥进重建后的 compose 条(inbox 走 postNotice → 新 bar 的 .form-err)。
    let msg = "";
    await browser.waitUntil(
      async () => {
        msg = await browser.execute(() => {
          const el = document.querySelector(".v-inbox .compose .form-err");
          return el && !el.hidden ? (el.textContent || "").trim() : "";
        });
        return msg !== "";
      },
      { timeout: 8000, timeoutMsg: "挂图失败后 compose 条没给出任何提示" },
    );

    // ⭐ 承重的两格:说出了是哪种格式 / 不再叫人做那件注定失败的事。
    expect(msg).toContain("image/heic");
    expect(msg).not.toContain("重新粘贴");
    // 顺带:张数那半没被这次改动弄丢。
    expect(msg).toContain("1");

    // 收尾:条目连同它的空图位一起清掉,不给后续 spec 留状态。
    const hit = (await invoke("list_ideas")).find((n) => n.content === "E2E-挂图失败-说得准");
    if (hit) await invoke("delete_note", { id: hit.id });
  });
});

// 用户面 147:**存图默认不压;「压缩大图」开着时只按短边缩**。
// 病:147 之前默认按**长边** > 2560 等比缩并转 JPEG ⇒ 长截图(长边是它的高)被缩成窄条、字糊。
// ⭐ 样本是**逐像素噪声** PNG:旧版只在「重编码后更小」时才换掉原图,纯色 PNG 重编码反而更大、
// 会被按设计放行 ⇒ 那样第一例在旧代码上也是绿的(同 cdp-acceptance-pick-images 那条坑)。
// 阴性对照:把 downsampleForUpload 换回 147 之前那版,第一例红在 mime(落成 image/jpeg、512×2560)。
async function pasteNoise(w, h) {
  await browser.execute(
    async (W, H) => {
      const c = document.createElement("canvas");
      c.width = W;
      c.height = H;
      const ctx = c.getContext("2d");
      const im = ctx.createImageData(W, H);
      let s = 0x2545f491;
      for (let i = 0; i < im.data.length; i += 4) {
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        im.data[i] = s & 0xff;
        im.data[i + 1] = (s >>> 8) & 0xff;
        im.data[i + 2] = (s >>> 16) & 0xff;
        im.data[i + 3] = 255;
      }
      ctx.putImageData(im, 0, 0);
      const blob = await new Promise((res) => c.toBlob(res, "image/png"));
      const dt = new DataTransfer();
      dt.items.add(new File([blob], "shot.png", { type: "image/png" }));
      const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      document.querySelector(".v-inbox .compose-input").dispatchEvent(ev);
    },
    w,
    h,
  );
}

/** 贴一张噪声图记一条,回那张图入库后的 mime 与像素尺寸。 */
async function saveNoiseNote(content, w, h) {
  const input = await $(".v-inbox .compose-input");
  await input.click();
  await pasteNoise(w, h);
  await $(".v-inbox .compose .img-pending .img-thumb").waitForExist({ timeout: 10000 });
  await input.setValue(content);
  await browser.keys("Enter");
  let noteId;
  await browser.waitUntil(
    async () => {
      const hit = (await invoke("list_ideas")).find((n) => n.content === content);
      if (hit) noteId = hit.id;
      return !!hit;
    },
    { timeout: 8000, timeoutMsg: `${content}:回车后未入库` },
  );
  const [img] = await waitItemImages(noteId, 1, content);
  // ⚠ 只回尺寸:那个 data URL 有几 MB,整份过 WebDriver 太重。
  const dims = await browser.execute(async (id) => {
    const url = await window.__TAURI__.core.invoke("get_item_image", { imageId: id, spaceId: "main" });
    const im = new Image();
    await new Promise((res, rej) => {
      im.onload = res;
      im.onerror = rej;
      im.src = url;
    });
    return [im.naturalWidth, im.naturalHeight];
  }, img.id);
  return { mime: img.mime, w: dims[0], h: dims[1] };
}

describe("存图压缩 · 默认原图,开着时只按短边缩(用户面 147)", () => {
  before(async () => {
    await goNotebook("inbox");
    await clearInbox();
    await browser.execute(() => localStorage.removeItem("zhujian.compress-images"));
  });
  after(async () => {
    await browser.execute(() => localStorage.removeItem("zhujian.compress-images"));
    await clearInbox();
  });

  it("默认关:长截图原样入库(仍是 PNG、一个像素没少)", async () => {
    const got = await saveNoiseNote("E2E-压缩-默认关", 600, 3000);
    expect(got).toEqual({ mime: "image/png", w: 600, h: 3000 });
  });

  it("开着:长截图短边不超线,照样原样入库", async () => {
    await browser.execute(() => localStorage.setItem("zhujian.compress-images", "on"));
    const got = await saveNoiseNote("E2E-压缩-开-长图", 600, 3000);
    expect(got).toEqual({ mime: "image/png", w: 600, h: 3000 });
  });

  it("开着:短边超 1920 的大图缩到短边 1920 并转 JPEG", async () => {
    await browser.execute(() => localStorage.setItem("zhujian.compress-images", "on"));
    const got = await saveNoiseNote("E2E-压缩-开-大图", 2000, 1940);
    expect(got).toEqual({ mime: "image/jpeg", w: 1979, h: 1920 });
  });
});

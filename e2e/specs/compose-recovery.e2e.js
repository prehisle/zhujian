import { browser, $, $$, expect } from "@wdio/globals";
import { invoke, goShow, goNotebook, clearInbox } from "./support.js";

// compose 草稿断电恢复(198 桌面侧):三入口(捕获浮窗 / 灵感记下灵感 / 看板新建任务)的
// 未记下草稿——文字 + 暂存图——存到设备本地,断电 / 杀进程后重开还在。这里用「整页重载」
// (browser.url,即 goShow/goNotebook)当进程重启的前端 proxy:localStorage / IndexedDB 存
// 磁盘、同源留存,重载后 main.ts / inbox.ts / board.ts 的启动回填(restore)应把稿灌回。
// 每例自清:记下 → 断言草稿清 → 清库,不给后续 spec 留状态。
//
// 阴性对照(手工验过一次即可,勿留代码):把 persistKey / saveTextDraft 注掉,重载后
// 输入框空、暂存条无 thumb → 三个 waitUntil 全超时真红。

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

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

describe("草稿断电恢复 · 捕获浮窗", () => {
  before(async () => {
    await goShow("/index.html");
    await clearInbox();
  });

  it("打字+贴图 → 整页重载 → 文字+图回填;记下后重载不复现", async () => {
    const ta = await $("#capture");
    await ta.waitForExist({ timeout: 10000 });
    await ta.click();
    await ta.setValue("E2E-断电-捕获"); // 真按键 → input 事件 → 文字入 localStorage
    await pasteImage("#capture"); // 暂存图 → IndexedDB
    await $("#cap-images .img-thumb").waitForExist({ timeout: 5000 });

    await goShow("/index.html"); // ← 断电 proxy:整页重载
    const ta2 = await $("#capture");
    await ta2.waitForExist({ timeout: 10000 });
    await browser.waitUntil(async () => (await ta2.getValue()) === "E2E-断电-捕获", {
      timeout: 5000,
      timeoutMsg: "重载后文字草稿未回填",
    });
    await $("#cap-images .img-thumb").waitForExist({
      timeout: 5000,
      timeoutMsg: "重载后暂存图未回填",
    });

    // 回填的稿能正常记下(回填的 Blob 能入库),入库带 1 张配图。
    await ta2.click();
    await browser.keys("Enter");
    let noteId;
    await browser.waitUntil(
      async () => {
        const ideas = await invoke("list_ideas");
        const hit = ideas.find((n) => n.content === "E2E-断电-捕获");
        if (hit) noteId = hit.id;
        return !!hit;
      },
      { timeout: 6000, timeoutMsg: "回填稿记下后未入库" },
    );
    expect(await invoke("list_item_images", { itemId: noteId })).toHaveLength(1);

    // 记下 = 稿了结:再重载,草稿不复现(持久化已清)。
    await goShow("/index.html");
    const ta3 = await $("#capture");
    await ta3.waitForExist({ timeout: 10000 });
    expect(await ta3.getValue()).toBe("");
    expect((await $$("#cap-images .img-thumb")).length).toBe(0);
    await clearInbox();
  });
});

describe("草稿断电恢复 · 灵感「记下灵感」", () => {
  before(async () => {
    await goNotebook("inbox");
    await clearInbox();
  });

  it("打字+贴图 → 重载笔记本 → 文字+图回填;记下后重载不复现", async () => {
    const input = await $(".v-inbox .compose-input");
    await input.waitForExist({ timeout: 10000 });
    await input.click();
    await input.setValue("E2E-断电-灵感");
    await pasteImage(".v-inbox .compose-input");
    await $(".v-inbox .compose .img-pending .img-thumb").waitForExist({ timeout: 5000 });

    await goNotebook("inbox"); // ← 断电 proxy:整页重载 + 回到灵感
    const input2 = await $(".v-inbox .compose-input");
    await input2.waitForExist({ timeout: 10000 });
    await browser.waitUntil(async () => (await input2.getValue()) === "E2E-断电-灵感", {
      timeout: 5000,
      timeoutMsg: "重载后灵感草稿未回填",
    });
    await $(".v-inbox .compose .img-pending .img-thumb").waitForExist({
      timeout: 5000,
      timeoutMsg: "重载后灵感暂存图未回填",
    });

    await input2.click();
    await browser.keys("Enter");
    let noteId;
    await browser.waitUntil(
      async () => {
        const ideas = await invoke("list_ideas");
        const hit = ideas.find((n) => n.content === "E2E-断电-灵感");
        if (hit) noteId = hit.id;
        return !!hit;
      },
      { timeout: 6000, timeoutMsg: "回填灵感记下后未入库" },
    );
    expect(await invoke("list_item_images", { itemId: noteId })).toHaveLength(1);

    await goNotebook("inbox");
    const input3 = await $(".v-inbox .compose-input");
    await input3.waitForExist({ timeout: 10000 });
    expect(await input3.getValue()).toBe("");
    expect((await $$(".v-inbox .compose .img-pending .img-thumb")).length).toBe(0);
    await clearInbox();
  });
});

describe("草稿断电恢复 · 看板「新建任务」", () => {
  before(async () => {
    await goNotebook("board");
  });

  it("打字+贴图 → 重载笔记本 → 文字+图回填(compose 自动开回);记下后重载不复现", async () => {
    const addBtn = await $("#add-task");
    await addBtn.waitForExist({ timeout: 10000 });
    await addBtn.click();
    const input = await $("#compose-input");
    await input.waitForDisplayed({ timeout: 5000 });
    await input.click();
    await input.setValue("E2E-断电-任务");
    await pasteImage("#compose-input");
    await $(".v-board .compose .img-pending .img-thumb").waitForExist({ timeout: 5000 });

    await goNotebook("board"); // ← 断电 proxy:整页重载 + 回到看板
    // 有文字草稿 → compose 应被回填并自动开回(setComposeOpen(true)),输入框可见带字。
    const input2 = await $("#compose-input");
    await input2.waitForDisplayed({ timeout: 5000, timeoutMsg: "重载后 compose 未自动开回" });
    await browser.waitUntil(async () => (await input2.getValue()) === "E2E-断电-任务", {
      timeout: 5000,
      timeoutMsg: "重载后任务草稿未回填",
    });
    await $(".v-board .compose .img-pending .img-thumb").waitForExist({
      timeout: 5000,
      timeoutMsg: "重载后任务暂存图未回填",
    });

    await input2.click();
    await browser.keys("Enter");
    let taskId;
    await browser.waitUntil(
      async () => {
        const tasks = await invoke("list_tasks");
        const hit = tasks.find((t) => t.title === "E2E-断电-任务");
        if (hit) taskId = hit.id;
        return !!hit;
      },
      { timeout: 6000, timeoutMsg: "回填任务记下后未入库" },
    );
    expect(await invoke("list_item_images", { itemId: taskId })).toHaveLength(1);

    await goNotebook("board");
    // 记下后重载:草稿不复现(compose 无字 → 收起;暂存条无 thumb)。
    expect((await $$(".v-board .compose .img-pending .img-thumb")).length).toBe(0);
    const live = await $("#compose-input");
    if (await live.isDisplayed()) expect(await live.getValue()).toBe("");

    // 清库:归档 + 彻底删,连图带计数 CASCADE。
    await invoke("archive_task", { id: taskId });
    await invoke("purge_task", { id: taskId });
  });
});

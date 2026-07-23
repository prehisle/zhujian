import { browser, $, expect } from "@wdio/globals";
import { invoke, goNotebook, boardAction } from "./support.js";

// 深链接(zhujian://open?…&item=…)的「消费端」:壳解析 URL → 定位条目所在视图 → 切过去
// 高亮。OS 侧(deep-link 插件把点击的链接转成事件/argv)是工序 4b;这里用 notebook 暴露的
// window.__zhujianOpenDeepLink 直驱消费端(同安卓 __zhujianHandleBack 的既有做法),把
// 「给个链接→打开对的条目」整条路径验干净。e2e 库无同步账户,故走 space=main 分支。
const open = (url) => browser.execute((u) => window.__zhujianOpenDeepLink(u), url);
const link = (id) => `zhujian://open?space=main&item=${id}`;
const activeView = () => $(".sidebar nav button.active").getAttribute("data-view");

describe("深链接 · 给链接直接打开条目", () => {
  const TASK = "E2E-深链任务";
  const IDEA = "E2E-深链灵感";
  let taskId, ideaId;

  before(async () => {
    taskId = await invoke("create_task", { title: TASK, topicId: null });
    ideaId = await invoke("capture_note", { content: IDEA });
    await goNotebook("board");
  });

  it("链接打开一条任务 → 切到看板并定位到它", async () => {
    await goNotebook("topics"); // 先离开看板,确认深链接会切回来
    await open(link(taskId));
    await browser.waitUntil(async () => (await activeView()) === "board", {
      timeout: 8000,
      timeoutMsg: "深链接未切到看板",
    });
    await expect($(`.tcard*=${TASK}`)).toExist();
  });

  it("链接打开一条灵感 → 切到灵感视图并定位到它", async () => {
    await goNotebook("board");
    await open(link(ideaId));
    await browser.waitUntil(async () => (await activeView()) === "inbox", {
      timeout: 8000,
      timeoutMsg: "深链接未切到灵感",
    });
    await expect($(`.note*=${IDEA}`)).toExist();
  });

  it("链接指向不存在的条目 → toast 提示,不乱跳", async () => {
    await goNotebook("board");
    await open(link("ZZZZZZZZZZZZZZZZZZZZZZZZZZ")); // 合法形态但库里没有
    await browser.waitUntil(
      async () => {
        const t = await $("#sync-toast");
        return (await t.isExisting()) && (await t.getText()).includes("找不到");
      },
      { timeout: 8000, timeoutMsg: "未见「找不到」toast" },
    );
  });

  it("「复制链接」→ 写入该条目的深链接", async () => {
    await goNotebook("board");
    await $(`.tcard*=${TASK}`).waitForExist({ timeout: 8000 });
    // 劫持 clipboard.writeText 记录写入值 —— 驱动窗里读 OS 剪贴板会挂起,写入侧拦截既
    // 确定又快,验的正是 buildItemDeepLink 生成的串。
    await browser.execute(() => {
      window.__lastClip = null;
      navigator.clipboard.writeText = (t) => {
        window.__lastClip = t;
        return Promise.resolve();
      };
    });
    await boardAction(TASK, "复制链接");
    await browser.waitUntil(async () => (await browser.execute(() => window.__lastClip)) !== null, {
      timeout: 5000,
      timeoutMsg: "复制链接未写入剪贴板",
    });
    const clip = await browser.execute(() => window.__lastClip);
    expect(clip).toBe(`zhujian://open?space=main&item=${taskId}`);
  });
});

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
    // 冷着陆的目标卡带持续定位高亮 .just-located(留到下次点击/滚动才消,见 locate.ts),
    // 不是新建那记 0.9s 一次性 .just-born——别再「还没看清就消失」。
    expect(await $(`.tcard*=${TASK}`).getAttribute("class")).toContain("just-located");
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

// 剪贴板补路(桌面):回窗读一次剪贴板,合规 zhujian:// 链接才弹非承诺式提示条「点此打开」。
// 驱动窗读 OS 剪贴板会挂起(见上),故直驱 notebook 暴露的 __zhujianOfferClipboardDeepLink(text)
// ——它就是 onFocusChanged 读到剪贴板后喂进的同一入口,把「解析→弹条→点开定位」整条验干净。
describe("剪贴板深链接 · 提示条", () => {
  const TASK = "E2E-剪贴板深链任务";
  let taskId;
  const offer = (text) => browser.execute((t) => window.__zhujianOfferClipboardDeepLink(t), text);
  const pill = () => $("#deeplink-pill");
  const pillShown = async () => (await pill().isExisting()) && (await pill().getAttribute("class")).includes("show");

  before(async () => {
    taskId = await invoke("create_task", { title: TASK, topicId: null });
    await goNotebook("topics"); // 停在非看板视图,确认点「打开」会切回来
  });

  it("合规链接 → 弹提示条,点「打开」切到看板并定位", async () => {
    await offer(`zhujian://open?space=main&item=${taskId}`);
    await browser.waitUntil(pillShown, { timeout: 5000, timeoutMsg: "未弹深链接提示条" });
    await $("#deeplink-pill .deeplink-pill-open").click();
    await browser.waitUntil(async () => (await activeView()) === "board", {
      timeout: 8000,
      timeoutMsg: "点「打开」未切到看板",
    });
    await expect($(`.tcard*=${TASK}`)).toExist();
    expect(await $(`.tcard*=${TASK}`).getAttribute("class")).toContain("just-located");
  });

  it("非自家链接 → 不弹", async () => {
    await browser.execute(() => document.getElementById("deeplink-pill")?.classList.remove("show"));
    await offer("https://example.com/not-ours"); // 合法 URL 但非 zhujian:// scheme
    await browser.pause(300);
    expect(await pillShown()).toBe(false);
  });
});

import { $, $$, expect, browser } from "@wdio/globals";
import { invoke, goNotebook } from "./support.js";

// P2-g 同步 UI 最小面。e2e 库从不配置同步账户,这里钉死的是「未配置=零打扰」契约:
// 侧栏只有一枚安静入口(灰点),面板给两条入路(创建账户/用配对码加入),Esc 即走。
// 联网链路(建账户/配对/引导/互通)在 cargo 集成测里对真服务器全链跑过,不在 e2e 重复。

describe("P2-g 同步 UI(未配置=零打扰)", () => {
  it("侧栏底部有同步入口;传输任务把状态定为 off(未配置)", async () => {
    await goNotebook("inbox");
    expect(await $("#sync-entry").isExisting()).toBe(true);
    await browser.waitUntil(
      async () => {
        const s = await invoke("sync_status");
        return s.state === "off" && s.configured === false;
      },
      { timeout: 10000, timeoutMsg: "sync_status 未进入 off 态" },
    );
    const cls = await browser.execute(() => document.getElementById("sync-dot").className);
    expect(cls).toContain("off");
  });

  it("点入口开设置面板(未配置态两个入路),Esc 关闭", async () => {
    await goNotebook("inbox");
    await browser.execute(() => document.getElementById("sync-entry").click());
    const panel = await $(".sync-panel");
    await panel.waitForExist({ timeout: 3000 });
    const text = await panel.getText();
    expect(text).toContain("创建账户");
    expect(text).toContain("用配对码加入");
    // 「创建账户」页只有服务器地址一个输入框(open-signup 155:无感创号,邀请码
    // 输入与文案连根不存在),「返回」能回到首页。
    await browser.execute(() => {
      for (const b of document.querySelectorAll(".sync-panel button")) {
        if (b.textContent.includes("创建账户")) return b.click();
      }
      throw new Error("面板里没有「创建账户」按钮");
    });
    await browser.waitUntil(
      async () => (await $$(".sync-panel .sync-input")).length === 1,
      { timeout: 3000, timeoutMsg: "创建账户页应只有服务器地址一个输入框(无码)" },
    );
    const createText = await (await $(".sync-panel")).getText();
    expect(createText).not.toContain("邀请码");
    await browser.execute(() => {
      for (const b of document.querySelectorAll(".sync-panel button")) {
        if (b.textContent === "返回") return b.click();
      }
      throw new Error("没有「返回」按钮");
    });
    // Esc 关面板(文档级监听)。
    await browser.execute(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    await browser.waitUntil(async () => !(await $(".sync-overlay").isExisting()), {
      timeout: 3000,
      timeoutMsg: "Esc 应关闭同步面板",
    });
  });
});

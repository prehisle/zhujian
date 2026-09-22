import { $, $$, expect, browser } from "@wdio/globals";
import { invoke, goNotebook } from "./support.js";

// P2-g 同步 UI 最小面。e2e 库从不配置同步账户,这里钉死的是「未配置=零打扰」契约:
// 侧栏只有一枚安静入口(灰点),面板给两条入路(创建账户/用配对码加入),Esc 即走。
// 联网链路(建账户/配对/引导/互通)在 cargo 集成测里对真服务器全链跑过,不在 e2e 重复。
// 已配置态那一页照 devices.e2e.js 的形**经真事件总线喂一份状态**画出来(生产里它的唯一输入
// 通道就是 `sync-status`),钉的是用户面 125:恢复码整个拆掉之后,那一页只剩「添加设备 /
// 设备名单」两枚入口,**任何地方都不再出现「恢复码」三个字**。

const CONFIGURED = {
  configured: true,
  state: "online",
  account_id: "01JQACCOUNT0000000000000000",
  device_id: "01JQ8F0000AAAAAAAAAAAAAAAA",
  server_url: "wss://sync.example.invalid",
  peers_online: 0,
  error: null,
  frozen: [],
  suspended: 0,
  skew: false,
  clock_skew: false,
  roster: null,
};

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
    // 用户面 125:创号页也不再预告「会给你一串恢复码」之类的话。
    expect(createText).not.toContain("恢复码");
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

  it("已配置态首页:添加设备 + 设备名单,没有「查看恢复码」(用户面 125)", async () => {
    await goNotebook("inbox");
    await browser.execute(() => document.getElementById("sync-entry").click());
    const panel = await $(".sync-panel");
    await panel.waitForExist({ timeout: 3000 });
    // 面板开着喂状态:home 页收到当前空间的 sync-status 就重画(devices.e2e.js 同一条路)。
    await browser.execute(
      (s) => window.__TAURI__.event.emit("sync-status", { space: "main", status: s }),
      CONFIGURED,
    );
    // 等 DOM 真翻到已配置态(有「设备名单」入口),不等固定毫秒。
    await browser.waitUntil(
      async () =>
        await browser.execute(() =>
          [...document.querySelectorAll(".sync-panel button")].some((b) => b.textContent.includes("设备名单")),
        ),
      { timeout: 5000, timeoutMsg: "喂进去的已配置状态没把面板翻到状态页" },
    );
    const text = await panel.getText();
    expect(text).toContain("已连接");
    expect(text).toContain("添加设备");
    expect(text).toContain("设备名单");
    expect(text).not.toContain("创建账户");
    expect(text).not.toContain("恢复码");
    // 已配置态的动作钮恰两枚(添加设备 / 设备名单)—— 数目钉死,免得将来谁把「查看恢复码」加回来
    // 而文字换了名。
    const acts = await browser.execute(() =>
      Array.from(document.querySelectorAll(".sync-panel .sync-actions button")).map((b) => b.textContent),
    );
    expect(acts).toEqual(["添加设备", "设备名单"]);
  });

  it("初始同步中:状态页画进度条,sync-boot 事件推进它;core 写进 error 的「没有在线设备」照样显出来(用户面 121)", async () => {
    await goNotebook("inbox");
    await browser.execute(() => document.getElementById("sync-entry").click());
    const panel = await $(".sync-panel");
    await panel.waitForExist({ timeout: 3000 });
    const feed = (status) =>
      browser.execute((s) => window.__TAURI__.event.emit("sync-status", { space: "main", status: s }), status);
    const boot = (received, total) =>
      browser.execute(
        (r, t) => window.__TAURI__.event.emit("sync-boot", { space: "main", received: r, total: t }),
        received,
        total,
      );
    const bootText = () =>
      browser.execute(() => document.querySelector(".sync-panel .sync-boot-text")?.textContent ?? null);
    const fillWidth = () =>
      browser.execute(() => document.querySelector(".sync-panel .sync-boot-fill")?.style.width ?? null);
    // 进 booting:进度块在,还没收到任何进度事件时说「正在等另一台设备」。
    await feed({ ...CONFIGURED, state: "booting" });
    await browser.waitUntil(async () => (await bootText()) !== null, {
      timeout: 5000,
      timeoutMsg: "booting 态的状态页应有进度块",
    });
    expect(await panel.getText()).toContain("初始同步中");
    expect(await bootText()).toBe("正在等另一台设备发来初始快照…");
    // 块帧推进:0.5 / 2.0 MB ⇒ 25%。
    await boot(524288, 2097152);
    await browser.waitUntil(async () => (await fillWidth()) === "25%", {
      timeout: 5000,
      timeoutMsg: `进度条宽度该到 25%,实得 ${await fillWidth()},文字「${await bootText()}」`,
    });
    expect(await bootText()).toBe("拉取快照 0.5 MB / 2.0 MB(25%)");
    // 收全 ⇒ 满条 + 「校验并导入中」。
    await boot(2097152, 2097152);
    await browser.waitUntil(async () => (await fillWidth()) === "100%", {
      timeout: 5000,
      timeoutMsg: "收全后进度条该满",
    });
    expect(await bootText()).toBe("快照 2.0 MB 已收全,校验并导入中…");
    // 没同伴在线那句由 core 写进 status.boot_hint(transport 那条 idle 计时;独占一格,不占 error),
    // 前端画在进度块里。同时喂一条 error:两句要**同屏**,谁也不遮谁(codex 121 一轮 M1 的形)。
    const hint = "没有在线设备可提供初始快照:请让另一台已经装好朱简的设备开着并联网,它一上线本机会自动继续";
    await feed({ ...CONFIGURED, state: "booting", boot_hint: hint, error: "初始同步空间不足:请清理存储" });
    await browser.waitUntil(async () => (await panel.getText()).includes("没有在线设备可提供初始快照"), {
      timeout: 5000,
      timeoutMsg: "booting 态带 boot_hint 的状态,那句该显在进度块里",
    });
    expect(await panel.getText()).toContain("初始同步空间不足");
    expect(await browser.execute(() => document.querySelector(".sync-panel .sync-boot-hint")?.textContent ?? null)).toBe(hint);
    // 引导完成翻到 online:进度块整个撤掉(不留一根满条在「已连接」下面)。
    await feed({ ...CONFIGURED, state: "online" });
    await browser.waitUntil(async () => (await bootText()) === null, {
      timeout: 5000,
      timeoutMsg: "online 态不该再有进度块",
    });
    expect(await panel.getText()).toContain("已连接");
    // 收摊:Esc 关面板。
    await browser.execute(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await browser.waitUntil(async () => !(await $(".sync-overlay").isExisting()), {
      timeout: 3000,
      timeoutMsg: "Esc 应关闭同步面板",
    });
  });
});

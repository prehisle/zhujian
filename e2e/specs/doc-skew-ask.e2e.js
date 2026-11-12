import { $, expect, browser } from "@wdio/globals";
import { invoke, goNotebook, clearInbox, inboxShow, inboxAction, docAction } from "./support.js";

// 878 混版提醒(src/doc-skew-ask.ts;发版全案 release-train-plan 第 1 条,用户 2026-11-11 拍板 A):
// 本机第一次要往**已配同步的空间**发 `doc_at` 那一刻弹一次「其他设备都升级了吗?」——
//   ① 弹,文案逐字;焦点停「先不用」
//   ② 「先不用」/ Esc = 这次操作取消、⛔ 一枚写命令都不发、不记
//   ③ 「仍然使用」= 照做 + 按空间记住(`zhujian.skew-ask-ack` = 空间 id 数组,与安卓同形),之后同一空间不再问
//   ④ 没配同步的空间不弹、不记
//   ⑤ 四条入口都接上:展开成长文 / 新建长文 / 收回随记 / 移到别的空间(判**目标**空间)
//
// e2e 库从不配同步 ⇒ 「已配同步」经真事件总线喂 `sync-status`(sync-walk161-d3 的形)。事件按序送达:每次喂完
// 最后一发总是 main,等侧栏状态点跟上 = 前面那几发也都已落进留存 Map。
// 写命令发没发、移动的目标空间,拦全局 fetch 记下来(space-walk159-s2 的手法与理由:`__TAURI_INTERNALS__.invoke`
// 定死不可写,只能拦这层;⛔ 包装里别抛)。另假出第二个空间供「移动」用,发往它的命令改写成 main。
// 包装随重载(goNotebook)消失 ⇒ 每例开头重装,装完先证它活着,之后只用侧栏切视图、不重载。

const FAKE = "01JW878DSKFAKESPACE0000000";
const FAKE_NAME = "演示:混版";
const ACK_KEY = "zhujian.skew-ask-ack";
const TITLE = "其他设备都升级了吗?";
const BODY =
  "这个空间里如果还有设备低于 电脑 0.2.50 / 安卓 0.3.46 / 鸿蒙 0.3.39,它会暂停接收这台设备之后的所有改动(不只是长文),升级后自动补齐。";
const STATUS = {
  configured: true,
  state: "online",
  account_id: "01JQACCOUNT0000000000000000",
  device_id: "01JQ8F0000AAAAAAAAAAAAAAAA",
  server_url: "ws://127.0.0.1:1",
  peers_online: 0,
  error: null,
  frozen: [],
  suspended: 0,
  skew: false,
  clock_skew: false,
  boot_hint: null,
  roster: null,
};
const OFF = { ...STATUS, configured: false, state: "off", account_id: null, device_id: null, server_url: null };

async function clearDocs() {
  for (const d of await invoke("list_docs")) {
    await invoke("archive_note", { id: d.id });
    await invoke("purge_note", { id: d.id });
  }
}

/** 拦全局 fetch:记写命令、假出第二个空间、`move_item_to_space` 回给定结果。 */
async function installWrapper() {
  await browser.execute((fake, fakeName) => {
    const realFetch = window.__dskRealFetch ?? window.fetch;
    window.__dskRealFetch = realFetch;
    window.__dsk = { calls: [], seen: 0 };
    const reply = (v, ok = true) =>
      Promise.resolve(
        new Response(JSON.stringify(v ?? null), { headers: { "Tauri-Response": ok ? "ok" : "error", "Content-Type": "application/json" } }),
      );
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : input.url;
      const base = ["http://ipc.localhost/", "https://ipc.localhost/", "ipc://localhost/"].find((p) => url.startsWith(p));
      if (base === undefined) return realFetch.call(window, input, init);
      const cmd = decodeURIComponent(url.slice(base.length).split("?")[0]);
      let args = null;
      try {
        if (init && typeof init.body === "string") args = JSON.parse(init.body);
      } catch {
        args = null;
      }
      if (cmd === "set_doc" || cmd === "capture_doc" || cmd === "move_item_to_space") window.__dsk.calls.push({ cmd, args });
      if (cmd === "list_spaces") {
        return realFetch.call(window, input, init).then((r) =>
          r.headers.get("Tauri-Response") !== "ok"
            ? r
            : r.json().then((all) => reply([...all, { id: fake, name: fakeName, status: all[0].status, alive: true }])),
        );
      }
      if (cmd === "move_item_to_space") {
        return reply({ outcome: "moved", new_id: args.itemId, source_already_gone: false });
      }
      if (cmd === "set_foreground_space" && args && args.spaceId === fake) return reply(null);
      if (args && typeof args === "object" && !Array.isArray(args) && args.spaceId === fake) {
        return realFetch.call(window, input, { ...init, body: JSON.stringify({ ...args, spaceId: "main" }) });
      }
      return realFetch.call(window, input, init);
    };
    // 弹窗出现过几次(含一闪而过的):MutationObserver 记,判「不弹」用
    window.__dskObs?.disconnect();
    window.__dskObs = new MutationObserver((ms) => {
      for (const m of ms)
        for (const n of m.addedNodes) if (n instanceof HTMLElement && n.querySelector(".doc-skew-ask")) window.__dsk.seen++;
    });
    window.__dskObs.observe(document.body, { childList: true });
  }, FAKE, FAKE_NAME);
  // 正控:包装真在路上(list_spaces 经它回来带着假空间、set_doc 被记下),否则下面「没发」读不出意义
  const ids = await browser.execute(() => window.__TAURI__.core.invoke("list_spaces").then((all) => all.map((s) => s.id)));
  if (!ids.includes(FAKE)) throw new Error(`IPC 包装没生效:list_spaces = ${JSON.stringify(ids)}`);
  await browser.execute(() => window.__TAURI__.core.invoke("set_doc", { spaceId: "main", id: "nope", on: true }).catch(() => {}));
  const n = await browser.execute(() => window.__dsk.calls.length);
  if (n !== 1) throw new Error(`IPC 包装没记到探针那一发 set_doc:calls = ${n}`);
  await browser.execute(() => (window.__dsk.calls = []));
}

/** 喂同步状态:先喂假空间,最后喂 main 并等侧栏状态点跟上(事件按序送达 ⇒ 假空间那一发也已落地)。 */
async function feed({ main, fake }) {
  if (main === undefined) throw new Error("feed 要给 main");
  // 先把 main 喂成与目标相反的那一态,保证最后那一发确实改了状态点(否则「已经是 off」读不出事件到没到)
  await browser.execute((s) => window.__TAURI__.event.emit("sync-status", { space: "main", status: s }), main ? OFF : STATUS);
  await waitDot(main ? "off" : "on");
  if (fake !== undefined) await browser.execute((sp, s) => window.__TAURI__.event.emit("sync-status", { space: sp, status: s }), FAKE, fake ? STATUS : OFF);
  await browser.execute((s) => window.__TAURI__.event.emit("sync-status", { space: "main", status: s }), main ? STATUS : OFF);
  await waitDot(main ? "on" : "off");
}
async function waitDot(cls) {
  await browser.waitUntil(() => browser.execute((c) => document.getElementById("sync-dot").classList.contains(c), cls), {
    timeout: 5000,
    timeoutMsg: `侧栏状态点一直没变成 ${cls}:${await browser.execute(() => document.getElementById("sync-dot").className)}`,
  });
}

const nav = (view) => browser.execute((v) => document.querySelector(`button[data-view="${v}"]`).click(), view);
async function remount(view) {
  await nav(view === "inbox" ? "topics" : "inbox");
  await $(`.v-${view === "inbox" ? "topics" : "inbox"}`).waitForExist({ timeout: 5000 });
  await nav(view);
  await $(`.v-${view}`).waitForExist({ timeout: 5000 });
}
const calls = (cmd) => browser.execute((c) => window.__dsk.calls.filter((x) => x.cmd === c), cmd);
/** 这一本记没记过「看过提醒」。 */
const acked = (space) => browser.execute((k, sp) => JSON.parse(localStorage.getItem(k) ?? "[]").includes(sp), ACK_KEY, space);

/** 等弹窗出来,读它的样子。 */
async function waitAsk() {
  await $(".th-panel.doc-skew-ask").waitForExist({ timeout: 5000 });
  return browser.execute(() => {
    const p = document.querySelector(".th-panel.doc-skew-ask");
    return {
      title: p.querySelector(".th-title").textContent,
      body: p.querySelector(".th-body").textContent,
      buttons: [...p.querySelectorAll("button")].map((b) => b.textContent),
      focused: p.contains(document.activeElement) ? document.activeElement.textContent : null,
      modal: p.getAttribute("role") === "dialog" && p.getAttribute("aria-modal") === "true",
    };
  });
}
const answer = (cls) => browser.execute((c) => document.querySelector(`.th-panel.doc-skew-ask ${c}`).click(), cls);
const escape = () =>
  browser.execute(() => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
const askGone = () => $(".th-overlay").waitForExist({ timeout: 5000, reverse: true });

async function openDoc(title) {
  await browser.waitUntil(
    () => browser.execute((t) => [...document.querySelectorAll(".v-docs .doc-card-title")].some((n) => n.textContent.includes(t)), title),
    { timeout: 8000, timeoutMsg: `长文列表里一直没有「${title}」` },
  );
  await browser.execute((t) => [...document.querySelectorAll(".v-docs .doc-card")].find((c) => c.textContent.includes(t)).click(), title);
  await $(".v-docs .doc-page").waitForExist({ timeout: 8000 });
}

describe("878 混版提醒:第一次往已配同步的空间发长文标记前问一次", () => {
  beforeEach(async () => {
    await clearInbox();
    await clearDocs();
    await browser.execute((ack) => {
      localStorage.removeItem(ack);
      for (const k of Object.keys(localStorage)) if (k.startsWith("zhujian.doc-draft:")) localStorage.removeItem(k);
    }, ACK_KEY);
  });
  afterEach(async () => {
    // 收摊:清本支写进 localStorage 的几本账,把壳里那份真状态喂回去(别漏给后面的 spec)
    await browser.execute((ack) => {
      localStorage.removeItem(ack);
      localStorage.removeItem("zhujian.last-server");
      localStorage.removeItem("zhujian.sync-gone");
      document.querySelector(".th-overlay")?.remove();
    }, ACK_KEY);
    const real = await invoke("sync_status");
    await browser.execute((s) => window.__TAURI__.event.emit("sync-status", { space: "main", status: s }), real);
  });

  it("展开成长文:弹、文案逐字、焦点停「先不用」;先不用 / Esc 不发写命令不记;仍然使用照做并记住,之后收回不再问", async () => {
    const id = await invoke("capture_note", { content: "DSK-展开 一条随记" });
    await inboxShow("ideas");
    await installWrapper();
    await feed({ main: true });

    await inboxAction("DSK-展开", "转成长文");
    const a = await waitAsk();
    expect(a).toEqual({ title: TITLE, body: BODY, buttons: ["仍然使用", "先不用"], focused: "先不用", modal: true });
    // 先不用:取消这次操作,一枚写命令都不发、不记、卡还在随记
    await answer(".th-no");
    await askGone();
    expect(await calls("set_doc")).toEqual([]);
    expect(await acked("main")).toBe(false);
    expect((await invoke("list_docs")).some((d) => d.id === id)).toBe(false);
    expect(await browser.execute(() => [...document.querySelectorAll(".v-inbox .note")].some((n) => n.textContent.includes("DSK-展开")))).toBe(true);

    // Esc 同「先不用」
    await inboxAction("DSK-展开", "转成长文");
    await waitAsk();
    await escape();
    await askGone();
    expect(await calls("set_doc")).toEqual([]);
    expect(await acked("main")).toBe(false);

    // 仍然使用:照做、记住
    await inboxAction("DSK-展开", "转成长文");
    await waitAsk();
    await answer(".th-go");
    await askGone();
    await browser.waitUntil(async () => (await invoke("list_docs")).some((d) => d.id === id), {
      timeout: 8000,
      timeoutMsg: "「仍然使用」之后 list_docs 里一直没有这一篇",
    });
    expect((await calls("set_doc")).map((c) => c.args.on)).toEqual([true]);
    expect(await acked("main")).toBe(true);

    // 记住之后同一空间不再问:阅读页「收回随记」直接做
    const seenBefore = await browser.execute(() => window.__dsk.seen);
    await nav("docs");
    await $(".v-docs").waitForExist({ timeout: 5000 });
    await openDoc("DSK-展开");
    await docAction("DSK-展开", "收回随记");
    await browser.waitUntil(async () => (await invoke("list_ideas")).some((i) => i.id === id), {
      timeout: 8000,
      timeoutMsg: "记住之后「收回随记」一直没落库(是不是又弹了?)",
    });
    expect(await browser.execute(() => window.__dsk.seen)).toBe(seenBefore);
    expect((await calls("set_doc")).map((c) => c.args.on)).toEqual([true, false]);
  });

  it("新建长文与收回随记:先不用 = 编辑器不开 / 留在阅读页;Esc 只关弹窗不回列表;仍然使用后才进编辑器、保存才建", async () => {
    const id = await invoke("capture_note", { content: "# DSK-收回\n\n正文" });
    await invoke("set_doc", { id, on: true });
    await goNotebook("docs");
    await installWrapper();
    await feed({ main: true });
    await remount("docs");

    // 新建长文 → 先不用:编辑器不开、没 capture_doc
    await browser.execute(() => document.querySelector(".v-docs header .hbtn").click());
    expect((await waitAsk()).title).toBe(TITLE);
    await answer(".th-no");
    await askGone();
    expect(await $(".v-docs .doc-area").isExisting()).toBe(false);
    expect(await calls("capture_doc")).toEqual([]);

    // 收回随记(阅读页 ⋯)→ Esc:弹窗关了,⛔ 不顺手把人带回列表;没发 set_doc、仍是长文
    await openDoc("DSK-收回");
    await docAction("DSK-收回", "收回随记");
    await waitAsk();
    await escape();
    await askGone();
    expect(await $(".v-docs .doc-page").isExisting()).toBe(true);
    expect(await calls("set_doc")).toEqual([]);
    expect((await invoke("list_docs")).some((d) => d.id === id)).toBe(true);
    expect(await acked("main")).toBe(false);

    // 回列表,新建长文 → 仍然使用:进编辑器;写了保存才建(capture_doc 恰一发),并记住
    await browser.execute(() => document.querySelector(".v-docs .doc-bar .hbtn").click());
    await $(".v-docs .doc-page").waitForExist({ timeout: 5000, reverse: true });
    await browser.execute(() => document.querySelector(".v-docs header .hbtn").click());
    await waitAsk();
    await answer(".th-go");
    await askGone();
    await $(".v-docs .doc-area").waitForExist({ timeout: 5000 });
    expect(await calls("capture_doc")).toEqual([]);
    await browser.execute(() => {
      const a = document.querySelector(".v-docs .doc-area");
      a.value = "# DSK-新建\n\n正文";
      a.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await browser.execute(() => document.querySelector(".v-docs .doc-bar .do").click());
    await browser.waitUntil(async () => (await invoke("list_docs")).length === 2, { timeout: 8000, timeoutMsg: "新建那篇一直没落库" });
    expect((await calls("capture_doc")).length).toBe(1);
    expect(await acked("main")).toBe(true);
  });

  it("没配同步的空间:三条入口都不弹、不记,直接做", async () => {
    const id = await invoke("capture_note", { content: "DSK-未配 一条随记" });
    await inboxShow("ideas");
    await installWrapper();
    await feed({ main: false });

    await inboxAction("DSK-未配", "转成长文");
    await browser.waitUntil(async () => (await invoke("list_docs")).some((d) => d.id === id), {
      timeout: 8000,
      timeoutMsg: "没配同步时展开成长文一直没落库",
    });
    await nav("docs");
    await $(".v-docs").waitForExist({ timeout: 5000 });
    await openDoc("DSK-未配");
    await docAction("DSK-未配", "收回随记");
    await browser.waitUntil(async () => (await invoke("list_ideas")).some((i) => i.id === id), {
      timeout: 8000,
      timeoutMsg: "没配同步时收回随记一直没落库",
    });
    await $(".v-docs .doc-page").waitForExist({ timeout: 5000, reverse: true });
    await browser.execute(() => document.querySelector(".v-docs header .hbtn").click());
    await $(".v-docs .doc-area").waitForExist({ timeout: 5000 });
    expect(await browser.execute(() => window.__dsk.seen)).toBe(0);
    expect(await acked("main")).toBe(false);
    // 离开编辑器(没写字 = 不建)
    await nav("inbox");
    await $(".v-inbox").waitForExist({ timeout: 5000 });
  });

  it("移到别的空间判的是**目标**空间:本空间已配、目标没配 = 不问;本空间没配、目标已配 = 问,先不用不移、仍然使用才移并记在目标名下", async () => {
    const id = await invoke("capture_note", { content: "# DSK-移动\n\n正文" });
    await invoke("set_doc", { id, on: true });
    await goNotebook("docs");
    await installWrapper();
    await remount("docs");
    const pickAndGo = async () => {
      await openDoc("DSK-移动");
      await docAction("DSK-移动", "移到别的空间");
      await $(".v-docs .move-panel").waitForExist({ timeout: 5000 });
      await browser.execute(() => document.querySelector(".v-docs .move-panel .move-target").click());
      await browser.execute(() => document.querySelector(".v-docs .move-panel .move-yes").click());
    };

    // 本空间已配、目标没配:不问,直接移(移动命令发往目标)
    await feed({ main: true, fake: false });
    await pickAndGo();
    await browser.waitUntil(async () => (await calls("move_item_to_space")).length === 1, {
      timeout: 5000,
      timeoutMsg: "目标没配同步时「确认移动」一直没发出移动命令",
    });
    expect(await browser.execute(() => window.__dsk.seen)).toBe(0);
    expect((await calls("move_item_to_space"))[0].args).toMatchObject({ spaceId: "main", targetSpaceId: FAKE, itemId: id });
    await $(".v-docs .move-panel").waitForExist({ timeout: 5000, reverse: true });

    // 本空间没配、目标已配:问
    await feed({ main: false, fake: true });
    await pickAndGo();
    expect((await waitAsk()).title).toBe(TITLE);
    await answer(".th-no");
    await askGone();
    expect((await calls("move_item_to_space")).length).toBe(1); // 先不用:没移
    // 面板还在、「确认移动」还能点(没被置灰卡死)
    expect(
      await browser.execute(() => {
        const y = document.querySelector(".v-docs .move-panel .move-yes");
        return !!y && !y.hidden && !y.disabled;
      }),
    ).toBe(true);
    expect(await acked(FAKE)).toBe(false);
    await browser.execute(() => document.querySelector(".v-docs .move-panel .move-yes").click());
    await waitAsk();
    await answer(".th-go");
    await askGone();
    await browser.waitUntil(async () => (await calls("move_item_to_space")).length === 2, {
      timeout: 5000,
      timeoutMsg: "「仍然使用」之后一直没发出移动命令",
    });
    expect(await acked(FAKE)).toBe(true);
    expect(await acked("main")).toBe(false);
  });
});

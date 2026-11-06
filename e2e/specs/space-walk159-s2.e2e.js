import { $, expect, browser } from "@wdio/globals";
import { invoke, goNotebook, inboxShow, inboxAction, boardAction, docAction } from "./support.js";

// W3 走查修复(backlog 用户面 159)桌面第二波 · 空间与跨空间移动那几条:
//   Q4   移动面板三处一个样:先说后果(编辑历史永久删除、这边不留),选了空间再「确认移动」一拍;回执走通用
//        提示条、带「去看看」(切到目标空间并定位)(WD-16 / WD-38)
//   A2   挪不动(正文写着「图N」而那张图已彻底删掉)的话原样写出来、说清怎么办,⛔ 不再被认成「那一条已经不在了」(WD-01)
//   A10  看板卡按 M:面板滚进列的可视区、焦点进面板、Tab 不跑出去(WD-12)
//   A12  任务的列不随迁:问句与回执说「会落在那边「待办」最上,原来在「进行中」」(WD-09)
//   Q6   切空间说一声;多个空间时「随手记一笔」写上空间名;每个空间各记自己的筛选与滚动位(WD-17 / WD-18)
//   A11 + WD-39  改空间名框预填原名并全选;撞名时字留着、红字不带「出错:」
//
// ⚠ e2e 恒单空间(YS_DB_PATH 下后端禁扫禁建空间),真的跨空间移动走不到。⇒ 这支只验**前端那半**:页内把
// IPC 包一层,假出第二个空间「演示:另一个」—— 发往它的命令把 spaceId 改写成 main(于是它显示的是同一份
// 数据,但前端按另一个空间 id 记账);`move_item_to_space` / `rename_space` / `create_space` 由用例给定回包。
// 真空间之间的移动、切换走真实例复走(walk-seed --desktop-spaces)与 core / 壳的 Rust 测试。包装随页面重载
// (goNotebook)消失,每例开头重装,并重挂一次视图让 listSpaces 吃到它。
// ⚠ 拦在 `fetch` 这一层:`__TAURI_INTERNALS__.invoke` 与 window 上那一格都是定死的(赋值 / 重定义 / 换 Proxy
// 三种都试过,全拒);Tauri 的 IPC 脚本(ipc-protocol.js)每次现读全局 `fetch` 发 `http://ipc.localhost/<命令>`。
// ⛔ 包装里别抛:那条 fetch 一失败,Tauri 就永久退回 postMessage 通道,之后的命令全绕过包装。

const FAKE = "01JW159S2FAKESPACE00000000";
const FAKE_NAME = "演示:另一个";
const TOK = "W159S2SP";

async function installFakeSpace() {
  await browser.execute(
    (fake, fakeName) => {
      const realFetch = window.__w159RealFetch ?? window.fetch;
      window.__w159RealFetch = realFetch;
      window.__w159 = { calls: [], moveResult: null, renameErr: null, createErr: null };
      const reply = (v, ok = true) =>
        Promise.resolve(
          new Response(JSON.stringify(v ?? null), {
            headers: { "Tauri-Response": ok ? "ok" : "error", "Content-Type": "application/json" },
          }),
        );
      window.fetch = function (input, init) {
        const url = typeof input === "string" ? input : input.url;
        const base = ["http://ipc.localhost/", "https://ipc.localhost/", "ipc://localhost/"].find((p) => url.startsWith(p));
        if (base === undefined) return realFetch.call(window, input, init);
        const cmd = decodeURIComponent(url.slice(base.length).split("?")[0]);
        const w = window.__w159;
        let args = null;
        try {
          if (init && typeof init.body === "string") args = JSON.parse(init.body);
        } catch {
          args = null;
        }
        if (cmd === "list_spaces") {
          return realFetch.call(window, input, init).then((r) =>
            r.headers.get("Tauri-Response") !== "ok"
              ? r
              : r.json().then((all) => reply([...all, { id: fake, name: fakeName, status: all[0].status, alive: true }])),
          );
        }
        if (cmd === "move_item_to_space") {
          w.calls.push({ cmd, args });
          return w.moveResult ? reply(w.moveResult(args)) : reply("e2e:没给移动回包", false);
        }
        if (cmd === "rename_space" || cmd === "create_space") {
          w.calls.push({ cmd, args });
          const err = cmd === "rename_space" ? w.renameErr : w.createErr;
          return err ? reply(err, false) : reply(cmd === "create_space" ? { id: fake, name: fakeName, status: null, alive: true } : null);
        }
        // 前台空间喂壳:假空间那一发不能改写成 main —— 壳会回声一条 `space-foreground: main`,notebook 跟着
        // 把视图切回默认空间(真空间时回声的就是目标自己,switchSpace 对同 id 是 no-op)。
        if (cmd === "set_foreground_space" && args && args.spaceId === fake) return reply(null);
        if (args && typeof args === "object" && !Array.isArray(args) && args.spaceId === fake) {
          return realFetch.call(window, input, { ...init, body: JSON.stringify({ ...args, spaceId: "main" }) });
        }
        return realFetch.call(window, input, init);
      };
    },
    FAKE,
    FAKE_NAME,
  );
  // 正控:包装真在路上(list_spaces 经它回来带着假空间),否则下面各例的「没出现」读不出意义。
  const ids = await browser.execute(() => window.__TAURI__.core.invoke("list_spaces").then((all) => all.map((s) => s.id)));
  if (!ids.includes(FAKE)) throw new Error(`IPC 包装没生效:list_spaces = ${JSON.stringify(ids)}`);
}
const nav = (view) => browser.execute((v) => document.querySelector(`button[data-view="${v}"]`).click(), view);
/** 重挂一次视图(先去别处再回来),让它挂载时取的空间名单吃到包装。 */
async function remount(view) {
  await nav(view === "inbox" ? "topics" : "inbox");
  await browser.pause(50);
  await nav(view);
  await $(`.v-${view}`).waitForExist({ timeout: 5000 });
}
async function armRecorder() {
  await browser.execute(() => {
    window.__toasts = [];
    window.__toastObs?.disconnect();
    window.__toastObs = new MutationObserver((ms) => {
      for (const m of ms)
        for (const n of m.addedNodes)
          if (n instanceof HTMLElement && (n.classList.contains("copy-toast") || n.classList.contains("undo-toast")))
            window.__toasts.push({ cls: n.className, text: n.textContent });
    });
    window.__toastObs.observe(document.body, { childList: true });
  });
}
async function waitToast(part) {
  await browser.waitUntil(async () => (await browser.execute(() => window.__toasts.slice())).some((x) => x.text.includes(part)), {
    timeout: 8000,
    timeoutMsg: `没等到含「${part}」的回执;记到的:${JSON.stringify(await browser.execute(() => window.__toasts))}`,
  });
  return (await browser.execute(() => window.__toasts.slice())).find((x) => x.text.includes(part));
}
const panelState = (scope) =>
  browser.execute((s) => {
    const p = document.querySelector(`${s} .move-panel`);
    if (!p) return null;
    const vis = (e) => !!e && !e.hidden && e.offsetParent !== null;
    return {
      warn: p.querySelector(".move-warn")?.textContent ?? "",
      col: p.querySelector(".move-col")?.textContent ?? null,
      targets: [...p.querySelectorAll(".move-target")].map((b) => b.textContent),
      pressed: [...p.querySelectorAll('.move-target[aria-pressed="true"]')].map((b) => b.textContent),
      q: vis(p.querySelector(".move-q")) ? p.querySelector(".move-q").textContent : null,
      yes: vis(p.querySelector(".move-yes")),
      err: vis(p.querySelector(".move-err")) ? p.querySelector(".move-err").textContent : null,
      focusInside: p.contains(document.activeElement),
      focused: document.activeElement?.className ?? "",
    };
  }, scope);
const clickIn = (scope, sel) => browser.execute((s, x) => document.querySelector(`${s} .move-panel ${x}`).click(), scope, sel);

describe("W3 159 · 空间与跨空间移动(桌面第二波,前端半)", () => {
  after(async () => {
    // 包装随重载消失;last-space 若停在假空间,initCurrentSpace 对照真名单会把它清掉、回默认空间。
    await goNotebook("inbox");
    await browser.waitUntil(async () => (await browser.execute(() => localStorage.getItem("zhujian.last-space"))) !== FAKE, {
      timeout: 5000,
    });
  });

  it("Q4 + A2:随记的移动面板先说后果,选了空间才出「确认移动」;挪不动的话原样说清怎么办;Esc 退", async () => {
    await invoke("capture_note", { content: `${TOK}-随记 正文里写着图2` });
    await goNotebook("inbox");
    await installFakeSpace();
    await remount("inbox");
    await $(`.note*=${TOK}-随记`).waitForExist({ timeout: 8000 });
    await inboxAction(`${TOK}-随记`, "移到别的空间");
    await $(".v-inbox .move-panel").waitForExist({ timeout: 5000 });
    let s = await panelState(".v-inbox");
    expect(s.warn).toContain("这边不留");
    expect(s.warn).toContain("编辑历史会随移动永久删除");
    expect(s).toMatchObject({ col: null, targets: [FAKE_NAME], pressed: [], q: null, yes: false, err: null, focusInside: true });
    expect(s.focused).toContain("move-target"); // A10 同款:焦点落在第一枚目标上
    // 面板长在卡身下面一行,不把正文挤成窄条(卡是横排 flex;真实例截图逮到过一个字一行)
    const geo = await browser.execute(() => {
      const p = document.querySelector(".v-inbox .move-panel");
      const body = p.closest(".note").querySelector(".note-body").getBoundingClientRect();
      const r = p.getBoundingClientRect();
      return { below: r.top >= body.bottom - 1, bodyWide: body.width >= r.width * 0.9 };
    });
    expect(geo).toEqual({ below: true, bodyWide: true });

    // 连点两下目标:只是选中,不移(执行钮在另一行)
    await browser.execute(() => {
      const b = document.querySelector(".v-inbox .move-panel .move-target");
      b.click();
      b.click();
    });
    s = await panelState(".v-inbox");
    expect(s).toMatchObject({ pressed: [FAKE_NAME], q: `移到「${FAKE_NAME}」?`, yes: true });
    expect(s.focused).toContain("move-no"); // W5 Q3 ★①(D1 改):选了目标、确认一出来焦点停「取消」(此前停「确认移动」)
    expect(await browser.execute(() => window.__w159.calls.length)).toBe(0);

    // 挪不动(正文引用了已彻底删掉的图2):原样写出来,不带「要改的那一条已经不在了」那句误判
    await browser.execute(() => (window.__w159.moveResult = () => ({ outcome: "dangling_refs", seqs: [2] })));
    await clickIn(".v-inbox", ".move-yes");
    await browser.waitUntil(async () => (await panelState(".v-inbox"))?.err !== null, { timeout: 5000, timeoutMsg: "挪不动那句没写出来" });
    s = await panelState(".v-inbox");
    expect(s.err).toContain("挪不动");
    expect(s.err).toContain("「图2」");
    expect(s.err).toContain("改个写法");
    expect(s.err).not.toContain("已经不在了");
    expect(s.err).not.toContain("出错");
    expect(await browser.execute(() => window.__w159.calls.map((c) => c.args.targetSpaceId))).toEqual([FAKE]);

    // Esc 退出:面板收掉、卡回原样
    await browser.execute(() => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await browser.waitUntil(async () => (await panelState(".v-inbox")) === null, { timeout: 5000, timeoutMsg: "Esc 没收掉移动面板" });
    expect(await browser.execute(() => document.querySelectorAll(".v-inbox .note.confirming").length)).toBe(0);
  });

  it("Q4:移走了 → 通用提示条说「已移到…」并带「去看看」,点它切到那个空间、说一声、定位那一条", async () => {
    const target = await invoke("capture_note", { content: `${TOK}-落点 那边新生的这一条` });
    await invoke("capture_note", { content: `${TOK}-要移的随记` });
    await goNotebook("inbox");
    await installFakeSpace();
    await remount("inbox");
    await armRecorder();
    await browser.execute((id) => (window.__w159.moveResult = () => ({ outcome: "moved", new_id: id, source_already_gone: false })), target);
    await inboxAction(`${TOK}-要移的随记`, "移到别的空间");
    await $(".v-inbox .move-panel").waitForExist({ timeout: 5000 });
    await clickIn(".v-inbox", ".move-target");
    await clickIn(".v-inbox", ".move-yes");
    const toast = await waitToast(`已移到「${FAKE_NAME}」`);
    expect(toast.cls).toContain("undo-toast"); // 通用提示条那条通道(≥2.2 s、可点收),不是跟随小黑条
    expect(toast.text).toContain("去看看");

    await browser.execute(() => document.querySelector(".undo-toast .undo-go").click());
    await waitToast(`已切到「${FAKE_NAME}」`);
    await browser.waitUntil(
      async () =>
        browser.execute((t) => [...document.querySelectorAll(".v-inbox .note.just-located")].some((n) => n.textContent.includes(t)), `${TOK}-落点`),
      { timeout: 10000, timeoutMsg: "「去看看」没把新那一条定位出来" },
    );
    expect(await browser.execute(() => localStorage.getItem("zhujian.last-space"))).toBe(FAKE);
    expect(await browser.execute(() => document.getElementById("space-name").textContent)).toBe(FAKE_NAME);
  });

  it("A10 + A12:看板「进行中」列底下那张卡按 M → 面板滚进列的可视区、焦点进去、Tab 不跑出去;问句与回执说列不随迁", async () => {
    const ids = [];
    for (let i = 0; i < 9; i++) ids.push(await invoke("create_task", { title: `${TOK}-进行中 ${i}\n第二行\n第三行` }));
    for (const id of ids) await invoke("update_task_status", { id, to: "doing" });
    const last = `${TOK}-进行中 8`;
    await goNotebook("board");
    await installFakeSpace();
    await remount("board");
    await armRecorder();
    await $(`.tcard*=${last}`).waitForExist({ timeout: 8000 });
    // 把那张卡滚到列可视区的最底边(走查时的形:按 M 之后面板长在可视区外)
    await browser.execute((t) => {
      const c = [...document.querySelectorAll(".v-board .tcard")].find((x) => x.textContent.includes(t));
      const body = c.closest(".col-body");
      body.scrollTop = c.offsetTop + c.offsetHeight - body.clientHeight;
    }, last);
    await boardAction(last, "移到别的空间");
    await $(".v-board .move-panel").waitForExist({ timeout: 5000 });
    const geo = await browser.execute(() => {
      const p = document.querySelector(".v-board .move-panel");
      const body = p.closest(".col-body").getBoundingClientRect();
      const r = [...p.querySelectorAll(".move-target, .move-no")].map((b) => b.getBoundingClientRect());
      return { inView: r.every((x) => x.top >= body.top - 1 && x.bottom <= body.bottom + 1 && x.bottom <= window.innerHeight), n: r.length };
    });
    expect(geo).toEqual({ inView: true, n: 2 });
    let s = await panelState(".v-board");
    expect(s.focusInside).toBe(true);
    expect(s.col).toContain("列不随迁");

    // Tab 在面板里转圈:最后一枚上 Tab 回第一枚,第一枚上 Shift+Tab 到最后一枚
    const cycle = await browser.execute(() => {
      const p = document.querySelector(".v-board .move-panel");
      const bs = [...p.querySelectorAll("button")].filter((b) => !b.hidden && !b.disabled);
      bs[bs.length - 1].focus();
      bs[bs.length - 1].dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
      const wrapped = document.activeElement === bs[0];
      bs[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
      return { wrapped, back: document.activeElement === bs[bs.length - 1] };
    });
    expect(cycle).toEqual({ wrapped: true, back: true });

    // 选目标:问句点名对方落点列(现读对方空间的列)与原来那一列
    await clickIn(".v-board", ".move-target");
    await browser.waitUntil(async () => ((await panelState(".v-board"))?.q ?? "").includes("原来在"), {
      timeout: 5000,
      timeoutMsg: `问句没说列:${JSON.stringify(await panelState(".v-board"))}`,
    });
    s = await panelState(".v-board");
    expect(s.q).toBe(`移到「${FAKE_NAME}」?会落在那边「待办」的最上面,原来在「进行中」。`);
    // 问句补上列名后长了一截:「确认移动」仍在列的可视区里(真实例复走逮到过被顶出去)
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const y = document.querySelector(".v-board .move-panel .move-yes").getBoundingClientRect();
          const body = document.querySelector(".v-board .move-panel").closest(".col-body").getBoundingClientRect();
          return y.top >= body.top - 1 && y.bottom <= body.bottom + 1;
        }),
      { timeout: 3000, timeoutMsg: "选了空间后「确认移动」被顶出列的可视区" },
    );

    await browser.execute((id) => (window.__w159.moveResult = () => ({ outcome: "moved", new_id: id, source_already_gone: false })), ids[8]);
    await clickIn(".v-board", ".move-yes");
    const toast = await waitToast(`已移到「${FAKE_NAME}」`);
    expect(toast.text).toContain(`已移到「${FAKE_NAME}」,在「待办」最上面(原来在「进行中」)`);
    expect(toast.text).toContain("去看看");

    // 人就在看板上点「去看看」:落过去那张要高亮(真实例复走逮到过:看板 unmount 清掉了先登记的 focus)
    await browser.execute(() => document.querySelector(".undo-toast .undo-go").click());
    await waitToast(`已切到「${FAKE_NAME}」`);
    await browser.waitUntil(
      async () => browser.execute((t) => [...document.querySelectorAll(".v-board .tcard.just-located")].some((c) => c.textContent.includes(t)), last),
      { timeout: 10000, timeoutMsg: "看板上点「去看看」没把那张卡定位出来" },
    );
  });

  it("Q4:长文的移动面板与另两处同一个样,也说「编辑历史」(此前说「历史版本」)", async () => {
    const id = await invoke("capture_note", { content: `# ${TOK}-长文\n\n正文` });
    await invoke("set_doc", { id, on: true });
    await goNotebook("docs");
    await installFakeSpace();
    await remount("docs");
    await browser.execute((t) => [...document.querySelectorAll(".v-docs .doc-card")].find((c) => c.textContent.includes(t)).click(), `${TOK}-长文`);
    await $(".v-docs .doc-page").waitForExist({ timeout: 5000 });
    await docAction(`${TOK}-长文`, "移到别的空间");
    await $(".v-docs .move-panel.doc-move").waitForExist({ timeout: 5000 });
    const s = await panelState(".v-docs");
    expect(s.warn).toContain("编辑历史会随移动永久删除");
    expect(s.warn).not.toContain("历史版本");
    expect(s).toMatchObject({ targets: [FAKE_NAME], q: null, yes: false, focusInside: true });
    await clickIn(".v-docs", ".move-no");
    await browser.waitUntil(async () => (await panelState(".v-docs")) === null, { timeout: 5000 });
  });

  it("Q6:多个空间时记一笔框写空间名;切空间说一声;每个空间各记自己的筛选与滚动位", async () => {
    const tag = await invoke("create_topic", { title: `${TOK}-家务` });
    for (let i = 0; i < 30; i++) {
      const id = await invoke("capture_note", { content: `${TOK}-Q6 流水 ${i}\n第二行\n第三行` });
      if (i < 3) await invoke("file_note_to_topic", { id, topicId: tag, newTitle: null });
    }
    await goNotebook("inbox");
    await installFakeSpace();
    await remount("inbox");
    await armRecorder();
    const ph = () => browser.execute(() => document.querySelector(".v-inbox .compose-input")?.placeholder ?? "");
    await browser.waitUntil(async () => (await ph()).includes("记进「"), { timeout: 5000, timeoutMsg: `记一笔框没写空间名:${await ph()}` });
    const mainLabel = await browser.execute(() => document.getElementById("space-name").textContent);
    expect(await ph()).toBe(`随手记一笔,记进「${mainLabel}」…`);

    const top = () => browser.execute(() => document.querySelector(".v-inbox #list").scrollTop);
    const pick = (label) =>
      browser.execute((l) => [...document.querySelectorAll("#idea-topic-filter .tf-pill")].find((p) => p.textContent.startsWith(l)).click(), label);
    const activePill = () => browser.execute(() => [...document.querySelectorAll("#idea-topic-filter .tf-pill.active")].map((p) => p.textContent.replace(/\d+$/, "")));
    const switchTo = async (name) => {
      await browser.execute(() => document.getElementById("space-entry").click());
      await $(".space-menu").waitForExist({ timeout: 5000 });
      await browser.execute((n) => [...document.querySelectorAll(".space-menu .space-row")].find((r) => r.querySelector(".space-row-name")?.textContent === n).click(), name);
      await waitToast(`已切到「${name}」`);
      await $(".v-inbox #list .timeline").waitForExist({ timeout: 8000 });
    };

    // 默认空间:滚到 700
    const mainTop = await browser.execute(() => (document.querySelector(".v-inbox #list").scrollTop = 700));
    await switchTo(FAKE_NAME);
    expect(await ph()).toBe(`随手记一笔,记进「${FAKE_NAME}」…`);
    expect(await top()).toBe(0); // 那边自己的位置(从没去过 = 顶上),不是带过去的 700
    await browser.execute(() => (document.querySelector(".v-inbox #list").scrollTop = 300));
    await switchTo(mainLabel);
    await browser.waitUntil(async () => Math.abs((await top()) - mainTop) <= 2, { timeout: 5000, timeoutMsg: `切回默认空间没还原滚动位:${await top()}` });

    // 筛选同理:默认空间筛「家务」,另一个空间照旧「所有」,切回来「家务」还在
    await pick(`${TOK}-家务`);
    await browser.waitUntil(async () => (await activePill()).some((p) => p.startsWith(`${TOK}-家务`)), { timeout: 5000 });
    await switchTo(FAKE_NAME);
    expect(await activePill()).toEqual(["所有"]);
    await switchTo(mainLabel);
    await browser.waitUntil(async () => (await activePill()).some((p) => p.startsWith(`${TOK}-家务`)), {
      timeout: 5000,
      timeoutMsg: `切回来筛选没了:${JSON.stringify(await activePill())}`,
    });
    await pick("所有");
    await invoke("delete_topic", { id: tag });
  });

  it("A11 + WD-39:改空间名框预填原名并全选;原样回车不发命令;撞名时字留着、红字就是那句人话(不带「出错:」)", async () => {
    await goNotebook("inbox");
    await installFakeSpace();
    await armRecorder();
    const openRow = async (label) => {
      await browser.execute(() => document.getElementById("space-entry").click());
      await $(".space-menu").waitForExist({ timeout: 5000 });
      await browser.execute((l) => [...document.querySelectorAll(".space-menu .space-row.action")].find((r) => r.textContent === l).click(), label);
      await $(".space-menu .space-form input").waitForExist({ timeout: 5000 });
    };
    const enter = (v) =>
      browser.execute((val) => {
        const inp = document.querySelector(".space-menu .space-form input");
        if (val !== null) inp.value = val;
        inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      }, v);
    const form = () =>
      browser.execute(() => {
        const inp = document.querySelector(".space-menu .space-form input");
        if (!inp) return null;
        return {
          value: inp.value,
          sel: [inp.selectionStart, inp.selectionEnd],
          focused: document.activeElement === inp,
          disabled: inp.disabled,
          err: document.querySelector(".space-menu .space-err")?.textContent ?? "",
        };
      });

    const label = await browser.execute(() => document.getElementById("space-name").textContent);
    await openRow("重命名当前空间");
    expect(await form()).toEqual({ value: label, sel: [0, label.length], focused: true, disabled: false, err: "" });
    await enter(null); // 原样回车 = 不改
    await browser.waitUntil(async () => !(await $(".space-menu").isExisting()), { timeout: 5000 });
    expect(await browser.execute(() => window.__w159.calls.length)).toBe(0);

    await browser.execute((n) => (window.__w159.renameErr = `已有同名空间「${n}」`), FAKE_NAME);
    await openRow("重命名当前空间");
    await enter(FAKE_NAME);
    await browser.waitUntil(async () => ((await form())?.err ?? "") !== "", { timeout: 5000, timeoutMsg: "撞名没报" });
    expect(await form()).toMatchObject({ value: FAKE_NAME, focused: true, disabled: false, err: `已有同名空间「${FAKE_NAME}」` });

    // 新建空间撞名:同一句、同一个样
    await browser.execute(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    await browser.execute((n) => (window.__w159.createErr = `已有同名空间「${n}」`), FAKE_NAME);
    await openRow("＋ 新建空间");
    await enter(FAKE_NAME);
    await browser.waitUntil(async () => ((await form())?.err ?? "") !== "", { timeout: 5000, timeoutMsg: "新建撞名没报" });
    expect(await form()).toMatchObject({ value: FAKE_NAME, err: `已有同名空间「${FAKE_NAME}」` });

    // 改名成功:说一声
    await browser.execute(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    await browser.execute(() => (window.__w159.renameErr = null));
    await openRow("重命名当前空间");
    await enter("演示:新名字");
    await waitToast("空间已改名为「演示:新名字」");
    expect(await browser.execute(() => window.__w159.calls.filter((c) => c.cmd === "rename_space").map((c) => c.args.name))).toEqual([FAKE_NAME, "演示:新名字"]);
  });
});

import { browser, $, expect } from "@wdio/globals";
import { boardAction, boardPickTopicPill, goNotebook, inboxAction, inboxShow, invoke, openCompose, tryInvoke, boardMore } from "./support.js";

// 多看板优化(用户 2026-11-12 拍;两端共用的行为规矩 R1–R6)桌面那一半能自动化的几条:
//  D1 / R3 空看板提示只说这块看板(归档数只数这块的成就、没有完成列不提归档、非默认看板不说「转待办」);
//  D2 列管理里「+ 新建一块看板」点取消 / Esc ⇒ 回到列管理面(此前两层都没了);
//  D3 / R2 落点 ⊥ 的看板「+ 新建卡片」事前灰、title 说原因,按 N 不开框只说原因;
//  D6 / R5 切看板时标签 / 时间筛选回「所有」;
//  D8 / B12 顶栏「归档 N」只数这块看板、纯分类且 0 张不显(G 照开)、从这块看板进归档册预选这块;
//  D9 侧栏切看板不整页卸载重挂(新建框里打了一半的字还在);
//  D12 / C14 「管理看板」+ 侧栏右键改名 / 管理 / 删除(不空响亮拒、种子看板不给删);
//  D13 / C16 拖卡时侧栏里放得进的看板亮起,拖到看板名上放下 ⇒ 回执带「去看看」。
// ⭐ 落库为准(list_boards / list_tasks 是 core 的读模型),DOM 只断「长成了拍的样子」。
// ⚠ 引擎面(原生拖放可不可放的光标、窗口几何)e2e 证不了,走 desktop-verify;这里的拖放是页内合成事件。
// ⚠ 自建的看板 / 卡 / 标签在 after 里收干净,本机「在看哪块」清掉(后面的 spec 打开看板会落在默认那块)。

const P = "多看板优化-";
const FLOW = `${P}周报`;
const READ = `${P}书单`;
const READ2 = `${P}书单改名`;
const TAG = `${P}标签`;
const SEED = "任务";

const boards = () => invoke("list_boards");
const cols = () => invoke("list_board_columns");
const tasks = () => invoke("list_tasks");
const taskByTitle = async (title) => (await tasks()).find((t) => t.title === title);
const boardByTitle = async (title) => (await boards()).find((b) => b.title === title && !b.deleted);
const h1 = () => browser.execute(() => document.querySelector(".v-board header h1")?.textContent ?? null);

async function onBoard(name) {
  try {
    await browser.waitUntil(async () => (await h1()) === name, { timeout: 8000 });
  } catch {
    throw new Error(`页头一直不是「${name}」:${JSON.stringify(await h1())}`);
  }
}
/** 点侧栏那一块看板(找不到就抛)。 */
async function navClick(name) {
  await browser.execute((n) => {
    const b = [...document.querySelectorAll("#board-nav .bn-item")].find((x) => x.querySelector(".bn-name").textContent.trim() === n);
    if (!b) throw new Error(`侧栏没有看板「${n}」`);
    b.click();
  }, name);
  await onBoard(name);
}
const flashText = () => browser.execute(() => [...document.querySelectorAll(".copy-toast")].map((x) => x.textContent).join(" | "));
const cardShown = (title) =>
  browser.execute((t) => [...document.querySelectorAll(".v-board .tcard")].some((c) => c.textContent.includes(t)), title);

async function cleanup() {
  await browser.execute(() => document.querySelectorAll(".bcm-overlay, .th-overlay, .bn-menu").forEach((o) => o.remove()));
  for (const t of await tasks()) {
    if (!t.title.startsWith(P)) continue;
    await invoke("archive_task", { id: t.id });
    await invoke("purge_task", { id: t.id });
  }
  for (const t of await invoke("list_sealed_tasks")) {
    if (!t.title.startsWith(P)) continue;
    await invoke("unseal_task", { id: t.id });
    await invoke("archive_task", { id: t.id });
    await invoke("purge_task", { id: t.id });
  }
  for (const t of await invoke("list_archived_tasks")) if (t.title.startsWith(P)) await invoke("purge_task", { id: t.id });
  for (const i of await invoke("list_ideas")) if (i.content.startsWith(P)) await invoke("archive_note", { id: i.id });
  for (const i of await invoke("list_archived")) if (i.content.startsWith(P)) await invoke("purge_note", { id: i.id });
  for (const b of await boards()) {
    if (b.deleted || !b.deletable) continue;
    const r = await tryInvoke("delete_board", { id: b.id });
    if (!r.ok) throw new Error(`收场删看板失败(${b.title}):${r.err}`);
  }
  for (const tp of await invoke("list_topics")) if (tp.title.startsWith(P)) await invoke("delete_topic", { id: tp.id });
  await browser.execute(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith("zhujian.board-current.")) localStorage.removeItem(k);
  });
}

/** 周报看板上本 spec 建的活卡一律进回收站再彻底删(第二波几例之间互不掺数)。 */
async function clearFlowCards() {
  const fb = await boardByTitle(FLOW);
  const mine = new Set((await cols()).filter((c) => c.board_id === fb.id).map((c) => c.id));
  for (const t of await tasks()) {
    if (!t.title.startsWith(P) || !mine.has(t.status)) continue;
    await invoke("archive_task", { id: t.id });
    await invoke("purge_task", { id: t.id });
  }
}

describe("多看板优化 · 桌面", () => {
  let flow;
  let read;

  before(async () => {
    await goNotebook("board");
    await cleanup();
    flow = await invoke("create_board", { title: FLOW, columns: ["待处理", "进行中", "已完成"], doneIndex: 2 });
    read = await invoke("create_board", { title: READ, columns: ["收着"], doneIndex: null });
    await goNotebook("board");
    await browser.waitUntil(async () => (await browser.execute(() => document.querySelectorAll("#board-nav .bn-item").length)) >= 3, {
      timeout: 8000,
      timeoutMsg: "三块看板时侧栏没展开",
    });
  });
  after(async () => {
    await cleanup();
  });

  it("D12:页头「⋯」里那一项叫「管理看板」,title 说清管哪些事", async () => {
    await navClick(SEED);
    await $("#board-more").waitForDisplayed({ timeout: 8000 });
    const b = await browser.execute(() => {
      document.querySelector("#board-more").click();
      const x = document.querySelector(".board-more-menu #manage-cols");
      const out = { lbl: x.querySelector(".hk-label").textContent, title: x.title };
      document.querySelector("#board-more").click(); // 收回去
      return out;
    });
    expect(b.lbl).toBe("管理看板");
    for (const w of ["看板名", "新卡片落在哪一列", "完成列", "删除看板"]) expect(b.title).toContain(w);
  });

  it("D2:列管理里「+ 新建一块看板」点取消 / Esc ⇒ 回到列管理面,焦点在面板里", async () => {
    const openNew = () =>
      browser.execute(() => {
        const x = [...document.querySelectorAll(".bcm-board .bcm-btn")].find((b) => b.textContent.trim() === "+ 新建一块看板");
        if (!x) throw new Error("列管理面里没有「+ 新建一块看板」");
        x.click();
      });
    await boardMore("manage-cols");
    await $(".bcm-board").waitForExist({ timeout: 5000 });
    await openNew();
    await $(".bn-new").waitForExist({ timeout: 5000 });
    await browser.execute(() => [...document.querySelectorAll(".bn-new .bcm-btn")].find((b) => b.textContent.trim() === "取消").click());
    await $(".bn-new").waitForExist({ timeout: 5000, reverse: true });
    await $(".bcm-board").waitForExist({ timeout: 5000 });
    expect(await browser.execute(() => !!document.activeElement?.closest(".bcm-panel"))).toBe(true);
    // Esc 同一条路
    await openNew();
    await $(".bn-new").waitForExist({ timeout: 5000 });
    await browser.keys("Escape");
    await $(".bn-new").waitForExist({ timeout: 5000, reverse: true });
    await $(".bcm-board").waitForExist({ timeout: 5000 });
    await browser.execute(() => document.querySelector(".bcm-panel .bcm-close").click());
    await $(".bcm-overlay").waitForExist({ timeout: 5000, reverse: true });
  });

  it("D1 / D8:空看板只说这块看板的事;「归档 N」只数这块;纯分类 0 张不显(G 照开);进归档册预选这块", async () => {
    const fb = await boardByTitle(FLOW);
    const a = await invoke("create_task", { title: `${P}周报归档`, boardId: flow });
    await invoke("update_task_status", { id: a, to: fb.done });
    await invoke("seal_task", { id: a });
    const s = await invoke("create_task", { title: `${P}任务归档` });
    await invoke("update_task_status", { id: s, to: "done" });
    await invoke("seal_task", { id: s });

    await navClick(FLOW);
    const st = () =>
      browser.execute(() => ({
        empty: document.querySelector(".col-empty")?.textContent ?? null,
        sealHidden: document.querySelector("#seal-toggle").hidden,
        sealN: document.querySelector("#seal-n").textContent,
      }));
    await browser.waitUntil(async () => (await st()).empty !== null, { timeout: 8000, timeoutMsg: "周报看板没出空态" });
    let x = await st();
    expect(x.empty).toContain("归档了 1 张"); // 只数这块(种子看板那张不算)
    expect(x.empty).toContain("放进看板"); // 非默认看板不说「转待办」
    expect(x.empty).not.toContain("转待办");
    expect(x.sealHidden).toBe(false);
    expect(x.sealN).toBe("1");
    // 从这块看板进归档册 ⇒ 预选这块
    await browser.execute(() => document.querySelector("#seal-toggle").click());
    await $(".sealed-view").waitForExist({ timeout: 8000 });
    const active = await browser.execute(() => document.querySelector(".sealed-boards .tf-pill.active")?.textContent.trim() ?? null);
    expect(active).toBe(FLOW);
    await browser.execute(() => document.querySelector("#seal-toggle").click());
    await onBoard(FLOW);

    // 纯分类、0 张成就:空态不提归档,「归档」钮不显;G 照样开得了归档册
    await navClick(READ);
    await browser.waitUntil(async () => (await st()).empty !== null, { timeout: 8000, timeoutMsg: "书单看板没出空态" });
    x = await st();
    expect(x.empty).not.toContain("归档");
    expect(x.sealHidden).toBe(true);
    await browser.execute(() => document.activeElement?.blur());
    await browser.keys("g");
    await onBoard("归档");
    await browser.keys("g");
    await onBoard(READ);
  });

  it("D9:侧栏切看板不整页重挂 —— 新建框里打了一半的字还在", async () => {
    await navClick(SEED);
    await openCompose();
    await browser.execute(() => {
      const i = document.querySelector("#compose-input");
      i.value = "多看板优化-打了一半";
      i.dispatchEvent(new Event("input", { bubbles: true }));
      window.__mboView = document.querySelector(".v-board");
    });
    await navClick(FLOW);
    const r = await browser.execute(() => ({
      same: document.querySelector(".v-board") === window.__mboView,
      open: !document.querySelector("#compose").hidden,
      text: document.querySelector("#compose-input").value,
    }));
    expect(r).toEqual({ same: true, open: true, text: "多看板优化-打了一半" });
    await browser.execute(() => {
      const i = document.querySelector("#compose-input");
      i.value = "";
      i.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#compose-close").click();
      delete window.__mboView;
    });
  });

  it("D6:切到另一块看板 ⇒ 标签 / 时间筛选回「所有」", async () => {
    const topicId = await invoke("create_topic", { title: TAG });
    await invoke("create_task", { title: `${P}打了标签`, topicId });
    await navClick(SEED);
    await browser.waitUntil(() => cardShown(`${P}打了标签`), { timeout: 8000 });
    await boardPickTopicPill(TAG);
    await browser.execute(() => [...document.querySelectorAll("#time-filter .tf-pill")].find((p) => p.textContent.includes("今天")).click());
    const actives = () =>
      browser.execute(() => ({
        tag: document.querySelector("#topic-filter .tf-pill.active")?.textContent.trim() ?? null,
        time: document.querySelector("#time-filter .tf-pill.active")?.textContent.trim() ?? null,
      }));
    await browser.waitUntil(async () => {
      const a = await actives();
      return a.tag?.includes(TAG) && a.time?.includes("今天");
    }, { timeout: 8000, timeoutMsg: "前置:标签 / 时间筛选没选上" });
    await navClick(FLOW);
    await navClick(SEED);
    await browser.waitUntil(() => cardShown(`${P}打了标签`), { timeout: 8000 });
    const a = await actives();
    expect(a.tag?.startsWith("所有")).toBe(true);
    expect(a.time?.startsWith("所有")).toBe(true);
  });

  it("D3:落点 ⊥ 的看板「+ 新建卡片」事前灰、title 说原因;按 N 不开框只说原因", async () => {
    // core 不许造出落点 ⊥(删不掉最后一枚非完成列),它只会由并发产生 ⇒ 页内把 list_boards 的回包改一格。
    // 拦在 fetch 这一层,理由见 space-walk159-s2.e2e.js 头注。
    await browser.execute((id) => {
      const realFetch = window.fetch;
      window.__mboFetch = realFetch;
      window.fetch = async function (input, init) {
        const url = typeof input === "string" ? input : input.url;
        const base = ["http://ipc.localhost/", "https://ipc.localhost/", "ipc://localhost/"].find((p) => url.startsWith(p));
        const r = await realFetch.call(window, input, init);
        if (base === undefined || decodeURIComponent(url.slice(base.length).split("?")[0]) !== "list_boards") return r;
        const data = await r.clone().json();
        for (const b of data) if (b.id === id) b.landing = null;
        const h = new Headers(r.headers);
        h.delete("content-length");
        return new Response(JSON.stringify(data), { status: r.status, headers: h });
      };
    }, read);
    try {
      await navClick(READ);
      const st = () =>
        browser.execute(() => {
          const b = document.querySelector("#add-task");
          return { dis: b.getAttribute("aria-disabled"), title: b.title, composeOpen: !document.querySelector("#compose").hidden };
        });
      await browser.waitUntil(async () => (await st()).dis === "true", { timeout: 8000, timeoutMsg: "落点 ⊥ 时「+ 新建卡片」没灰" });
      expect((await st()).title).toContain("没有能放新卡片的列");
      await browser.execute(() => document.activeElement?.blur());
      await browser.keys("n");
      await browser.waitUntil(async () => (await flashText()).includes("没有能放新卡片的列"), { timeout: 5000, timeoutMsg: "按 N 没说原因" });
      expect((await st()).composeOpen).toBe(false);
    } finally {
      await browser.execute(() => {
        window.fetch = window.__mboFetch;
        delete window.__mboFetch;
      });
    }
    await navClick(FLOW);
    await navClick(READ);
    await browser.waitUntil(async () => (await browser.execute(() => document.querySelector("#add-task").getAttribute("aria-disabled"))) === null, {
      timeout: 8000,
      timeoutMsg: "落点回来后「+ 新建卡片」还灰着",
    });
  });

  it("D13:拖卡时侧栏里放得进的看板亮起;拖到看板名上放下 ⇒ 挪过去,回执「去看看」切过去", async () => {
    const C = `${P}拖去任务`;
    await invoke("create_task", { title: C, boardId: flow });
    await navClick(FLOW);
    await browser.waitUntil(() => cardShown(C), { timeout: 8000 });
    const lit = await browser.execute((t) => {
      const card = [...document.querySelectorAll(".v-board .tcard")].find((c) => c.textContent.includes(t));
      window.__mboCard = card;
      card.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
      return [...document.querySelectorAll("#board-nav .bn-item.can-drop")].map((b) => b.querySelector(".bn-name").textContent.trim());
    }, C);
    expect(lit.sort()).toEqual([SEED, READ].sort()); // 卡自己那块(周报)不亮
    await browser.execute((seed) => {
      const row = [...document.querySelectorAll("#board-nav .bn-item")].find((b) => b.querySelector(".bn-name").textContent.trim() === seed);
      const dt = new DataTransfer();
      row.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
      row.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
      window.__mboCard.dispatchEvent(new DragEvent("dragend", { bubbles: true }));
      delete window.__mboCard;
    }, SEED);
    await browser.waitUntil(async () => (await taskByTitle(C))?.status === "todo", { timeout: 8000, timeoutMsg: "拖到侧栏「任务」没挪过去" });
    expect(await browser.execute(() => document.querySelectorAll("#board-nav .bn-item.can-drop").length)).toBe(0);
    await browser.waitUntil(
      async () => (await browser.execute(() => document.querySelector(".undo-toast .undo-text")?.textContent ?? "")) === `已挪到看板「${SEED}」`,
      { timeout: 8000, timeoutMsg: "放下之后没有回执" },
    );
    await browser.execute(() => document.querySelector(".undo-toast .undo-go").click());
    await onBoard(SEED);
    await browser.waitUntil(
      async () => browser.execute((t) => !!document.querySelector(".v-board .tcard.just-located")?.textContent.includes(t), C),
      { timeout: 8000, timeoutMsg: "「去看看」没定位到那张卡" },
    );
  });

  // ---- 第二波(W1 / W2 / W3 / W5) ------------------------------------------------------------

  it("W1:列 / 收容区读 core 的 accepts_cards / held —— 看板只画活列;卡还原回一枚已删的空列 ⇒ 说进了收容区", async () => {
    const fb = await boardByTitle(FLOW);
    const tmp = await invoke("create_board_column", { title: `${P}临时列`, boardId: flow });
    const T = `${P}回到已删列`;
    const id = await invoke("create_task", { title: T, boardId: flow });
    await invoke("update_task_status", { id, to: tmp });
    await invoke("archive_task", { id });
    await invoke("delete_board_column", { id: tmp }); // 列上已无活卡(那张在回收站)⇒ 删得掉
    const c = (await cols()).find((x) => x.id === tmp);
    expect({ accepts: c.accepts_cards, held: c.held, live: c.live_items }).toEqual({ accepts: false, held: true, live: 0 });

    await navClick(SEED);
    await navClick(FLOW);
    // 看板画的列 = core 说 accepts_cards 的那几枚(同序)
    const want = (await cols()).filter((x) => x.accepts_cards && x.board_id === fb.id).map((x) => x.id);
    await browser.waitUntil(
      async () =>
        JSON.stringify(await browser.execute(() => [...document.querySelectorAll(".v-board .col")].map((s) => s.dataset.col))) ===
        JSON.stringify(want),
      { timeout: 8000, timeoutMsg: "看板画的列与 accepts_cards 对不上" },
    );
    // 改前的判据(holdingColumns 要求 live_items > 0)在这里会漏:那一列此刻是空的 ⇒ 回执说「已还原到「临时列」」,卡却进了收容区。
    await browser.execute(() => document.querySelector("#trash-toggle").click());
    await onBoard("回收站");
    await browser.waitUntil(() => cardShown(T), { timeout: 8000 });
    await boardAction(T, "还原");
    await browser.waitUntil(
      async () => (await browser.execute(() => document.querySelector(".undo-toast .undo-text")?.textContent ?? "")).startsWith("已还原:它原来那一列已经删了"),
      { timeout: 8000, timeoutMsg: "还原回已删的空列,回执没说进了收容区" },
    );
    await browser.waitUntil(async () => browser.execute(() => !!document.querySelector("#board-nav .bn-holding")), {
      timeout: 8000,
      timeoutMsg: "侧栏收容区那一行没出来",
    });
    await browser.execute(() => document.querySelector(".undo-toast .undo-go").click());
    await onBoard("已删除的看板 / 列");
    await browser.waitUntil(() => cardShown(T), { timeout: 8000, timeoutMsg: "「去看看」没落到收容区那张卡" });
    // 收场:卡挪回周报(收容区只出不进,出口走 move_task_to_board)
    await invoke("move_task_to_board", { id, boardId: flow });
    await navClick(FLOW);
    await browser.waitUntil(async () => browser.execute(() => !document.querySelector("#board-nav .bn-holding")), {
      timeout: 8000,
      timeoutMsg: "收容区清空了侧栏那一行还在",
    });
  });

  it("W2:侧栏看板名右侧写没完成的卡数(open_items;完成列不算、0 不写);随记转过来侧栏跟着变", async () => {
    const fb = await boardByTitle(FLOW);
    await clearFlowCards(); // 从干净的周报数起
    await invoke("create_task", { title: `${P}周报未完`, boardId: flow });
    const d = await invoke("create_task", { title: `${P}周报已完`, boardId: flow });
    await invoke("update_task_status", { id: d, to: fb.done });
    await navClick(SEED);
    await navClick(FLOW);
    const shown = () =>
      browser.execute(() =>
        Object.fromEntries(
          [...document.querySelectorAll("#board-nav .bn-item")].map((r) => [
            r.querySelector(".bn-name").textContent.trim(),
            r.querySelector(".bn-n")?.textContent ?? null,
          ]),
        ),
      );
    const want = async () =>
      Object.fromEntries(
        (await boards()).filter((b) => !b.deleted).map((b) => [b.title_overridden ? b.title : SEED, b.open_items > 0 ? String(b.open_items) : null]),
      );
    let got = null;
    let exp = null;
    try {
      // 只比「哪块写几」:browser.execute 回传的对象不保键序(实测),先后另有 DOM 顺序为证。
      const norm = (o) => JSON.stringify(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
      await browser.waitUntil(async () => norm((got = await shown())) === norm((exp = await want())), { timeout: 8000 });
    } catch {
      throw new Error(`侧栏卡数与 open_items 对不上:侧栏 ${JSON.stringify(got)} / core ${JSON.stringify(exp)}`);
    }
    const s = await shown();
    expect(s[FLOW]).toBe("1"); // 完成列里那张不算
    expect(s[READ]).toBe(null); // 一张都没有 ⇒ 不写 0
    // 灰小字:与名字同一行、在名字右边、颜色比名字淡
    const look = await browser.execute((n) => {
      const r = [...document.querySelectorAll("#board-nav .bn-item")].find((x) => x.querySelector(".bn-name").textContent.trim() === n);
      const name = r.querySelector(".bn-name").getBoundingClientRect();
      const num = r.querySelector(".bn-n").getBoundingClientRect();
      return {
        sameRow: Math.abs(name.top + name.height / 2 - (num.top + num.height / 2)) < 3,
        right: num.left >= name.right,
        fainter: getComputedStyle(r.querySelector(".bn-n")).color !== getComputedStyle(r.querySelector(".bn-name")).color,
      };
    }, FLOW);
    expect(look).toEqual({ sameRow: true, right: true, fainter: true });

    // 看板视图没挂着(在随记页)时转待办 ⇒ 侧栏自己重取,默认看板那一格 +1
    const before = (await boards()).find((b) => b.is_default).open_items;
    const N = `${P}随记转过来`;
    await invoke("capture_note", { content: N });
    await inboxShow("ideas");
    await $(`.note*=${N}`).waitForExist({ timeout: 8000 });
    await inboxAction(N, "转待办");
    await browser.waitUntil(async () => (await taskByTitle(N)) !== undefined, { timeout: 8000, timeoutMsg: "转待办没落库" });
    let last = null;
    try {
      await browser.waitUntil(async () => (last = await shown())[SEED] === String(before + 1), { timeout: 8000 });
    } catch {
      throw new Error(`随记转待办后侧栏默认看板的卡数没变成 ${before + 1}:${JSON.stringify(last)}`);
    }
    await clearFlowCards(); // D12 数周报上剩几张,别让这几例的卡掺进去
    await goNotebook("board");
  });

  it("W3:看板页不拉回收站 / 归档册全表,顶栏两个数走计数命令且与库对得上;进了那一页才拉那一张", async () => {
    const x = await invoke("create_task", { title: `${P}进回收站` });
    await invoke("archive_task", { id: x });
    await browser.execute(() => {
      const realFetch = window.fetch;
      window.__mboFetch = realFetch;
      window.__mboCalls = [];
      window.fetch = function (input, init) {
        const url = typeof input === "string" ? input : input.url;
        const base = ["http://ipc.localhost/", "https://ipc.localhost/", "ipc://localhost/"].find((p) => url.startsWith(p));
        if (base !== undefined) window.__mboCalls.push(decodeURIComponent(url.slice(base.length).split("?")[0]));
        return realFetch.call(window, input, init);
      };
    });
    const calls = () => browser.execute(() => window.__mboCalls.slice());
    const reset = () => browser.execute(() => (window.__mboCalls = []));
    const FULL = ["list_archived_tasks", "list_sealed_tasks", "list_removed_images"];
    try {
      await navClick(FLOW);
      await navClick(SEED);
      await browser.waitUntil(async () => (await calls()).filter((k) => k === "sealed_counts_by_board").length >= 2, { timeout: 8000 });
      const c = await calls();
      expect(c.filter((k) => FULL.includes(k))).toEqual([]);
      expect(c).toContain("trash_counts");
      const tc = await invoke("trash_counts");
      const sc = await invoke("sealed_counts_by_board");
      const seedId = (await boards()).find((b) => !b.title_overridden).id;
      const n = await browser.execute(() => ({ trash: document.querySelector("#trash-n").textContent, seal: document.querySelector("#seal-n").textContent }));
      expect(n.trash).toBe(String(tc.tasks + tc.task_images)); // 条目 + 已删配图张数(随记那两格不算)
      expect(n.seal).toBe(String(sc.find((g) => g.board_id === seedId)?.n ?? 0)); // 只数这块看板那一组

      await reset();
      await browser.execute(() => document.querySelector("#trash-toggle").click());
      await onBoard("回收站");
      await browser.waitUntil(() => cardShown(`${P}进回收站`), { timeout: 8000 });
      let k = await calls();
      expect(k).toContain("list_archived_tasks");
      expect(k).toContain("list_removed_images");
      expect(k).not.toContain("list_sealed_tasks");

      await reset();
      await browser.execute(() => document.querySelector("#seal-toggle").click());
      await onBoard("归档");
      await $(".sealed-view").waitForExist({ timeout: 8000 });
      k = await calls();
      expect(k).toContain("list_sealed_tasks");
      expect(k.filter((v) => v === "list_archived_tasks" || v === "list_removed_images")).toEqual([]);
      await browser.execute(() => document.querySelector("#seal-toggle").click());
      await onBoard(SEED);
    } finally {
      await browser.execute(() => {
        window.fetch = window.__mboFetch;
        delete window.__mboFetch;
        delete window.__mboCalls;
      });
    }
  });

  it("W5:默认看板放不进卡(落点 ⊥)时,随记 ⋯「转待办」事前淡着、title 说原因;点了只说原因、不转;「放进看板 ▸」照给", async () => {
    const dflt = (await boards()).find((b) => b.is_default);
    const N = `${P}转不过去`;
    await invoke("capture_note", { content: N });
    const menuRow = () =>
      browser.execute((c) => {
        if (document.querySelector(".hk-menu")) document.body.click();
        const card = [...document.querySelectorAll(".note")].find((n) => n.textContent.includes(c));
        card.querySelector(".hk-btn").click();
        const items = [...document.querySelectorAll(".hk-menu .hk-item")];
        const it = items.find((x) => x.querySelector(".hk-label")?.textContent === "转待办");
        return {
          blocked: it.classList.contains("blocked"),
          aria: it.getAttribute("aria-disabled"),
          title: it.title,
          into: items.some((x) => x.querySelector(".hk-label")?.textContent === "放进看板"),
        };
      }, N);
    // ⚠ goNotebook / inboxShow 会整页重载(拦截器跟着没了)⇒ 先进随记页,再装拦截,再经侧栏切走切回(不重载)让随记重取看板。
    await inboxShow("ideas");
    await browser.execute((id) => {
      const realFetch = window.fetch;
      window.__mboFetch = realFetch;
      window.fetch = async function (input, init) {
        const url = typeof input === "string" ? input : input.url;
        const base = ["http://ipc.localhost/", "https://ipc.localhost/", "ipc://localhost/"].find((p) => url.startsWith(p));
        const r = await realFetch.call(window, input, init);
        if (base === undefined || decodeURIComponent(url.slice(base.length).split("?")[0]) !== "list_boards") return r;
        const data = await r.clone().json();
        for (const b of data) if (b.id === id) b.landing = null;
        const h = new Headers(r.headers);
        h.delete("content-length");
        return new Response(JSON.stringify(data), { status: r.status, headers: h });
      };
    }, dflt.id);
    try {
      await browser.execute(() => document.querySelector('.sidebar nav button[data-view="board"]').click());
      await $(".v-board").waitForExist({ timeout: 5000 });
      await browser.execute(() => document.querySelector('.sidebar nav button[data-view="inbox"]').click());
      await $(".v-inbox").waitForExist({ timeout: 5000 });
      await $(`.note*=${N}`).waitForExist({ timeout: 8000 });
      let row = null;
      try {
        await browser.waitUntil(async () => (row = await menuRow()).blocked, { timeout: 8000 });
      } catch {
        throw new Error(`落点 ⊥ 时「转待办」没淡着:${JSON.stringify(row)}`);
      }
      expect(row.blocked).toBe(true);
      expect(row.aria).toBe("true");
      expect(row.title).toContain(`默认看板「${SEED}」现在没有能放新卡片的列`);
      expect(row.into).toBe(true); // 出路:放进别的看板
      await browser.execute(() =>
        [...document.querySelectorAll(".hk-menu .hk-item")].find((x) => x.querySelector(".hk-label")?.textContent === "转待办").click(),
      );
      await browser.waitUntil(async () => (await flashText()).includes("现在没有能放新卡片的列"), {
        timeout: 5000,
        timeoutMsg: "点了淡着的「转待办」没说原因",
      });
      expect((await invoke("list_ideas")).some((i) => i.content === N)).toBe(true); // 没转
      expect(await taskByTitle(N)).toBe(undefined);
    } finally {
      await browser.execute(() => {
        if (document.querySelector(".hk-menu")) document.body.click();
        window.fetch = window.__mboFetch;
        delete window.__mboFetch;
      });
    }
    // 落点回来 ⇒ 不再淡着
    await goNotebook("board");
    await inboxShow("ideas");
    await $(`.note*=${N}`).waitForExist({ timeout: 8000 });
    const back = await menuRow();
    await browser.execute(() => document.body.click());
    expect(back.blocked).toBe(false);
    expect(back.aria).toBe(null);
    await goNotebook("board");
  });

  it("D12:侧栏右键 —— 改名、管理看板、删除(不空响亮拒;空了问一次再删;种子看板没有删除)", async () => {
    await navClick(SEED);
    const menuOf = (name) =>
      browser.execute((n) => {
        document.querySelector(".bn-menu")?.remove();
        const row = [...document.querySelectorAll("#board-nav .bn-item")].find((b) => b.querySelector(".bn-name").textContent.trim() === n);
        const r = row.getBoundingClientRect();
        row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 8 }));
        return [...document.querySelectorAll(".bn-menu .hk-item")].map((x) => x.textContent.trim());
      }, name);
    const pick = (label) =>
      browser.execute((l) => [...document.querySelectorAll(".bn-menu .hk-item")].find((x) => x.textContent.trim() === l).click(), label);

    expect(await menuOf(SEED)).toEqual(["改名", "管理看板"]); // 种子看板永不可删
    await browser.keys("Escape");
    await $(".bn-menu").waitForExist({ timeout: 3000, reverse: true });

    // 改名(行内):回车存
    expect(await menuOf(READ)).toEqual(["改名", "管理看板", "删除这块看板"]);
    await pick("改名");
    await $(".bn-rename").waitForExist({ timeout: 3000 });
    await browser.execute((v) => {
      const i = document.querySelector(".bn-rename");
      i.value = v;
      i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    }, READ2);
    await browser.waitUntil(async () => !!(await boardByTitle(READ2)), { timeout: 8000, timeoutMsg: "右键改名没落库" });
    await browser.waitUntil(
      async () => (await browser.execute(() => [...document.querySelectorAll("#board-nav .bn-item")].map((b) => b.querySelector(".bn-name").textContent.trim()))).includes(READ2),
      { timeout: 8000, timeoutMsg: "侧栏没换成新名" },
    );

    // 管理看板:开的是那一块的列管理面(不用先切过去)
    await menuOf(FLOW);
    await pick("管理看板");
    await $(".bcm-board").waitForExist({ timeout: 5000 });
    expect(await browser.execute(() => document.querySelector(".bcm-panel .bcm-title").textContent)).toBe(`管理看板 · ${FLOW}`);
    await browser.execute(() => document.querySelector(".bcm-panel .bcm-close").click());
    await $(".bcm-overlay").waitForExist({ timeout: 5000, reverse: true });

    // 删除:不空 ⇒ 响亮拒,一张卡都不丢(先清掉前面几例可能留下的,只数这一张)
    await clearFlowCards();
    await invoke("create_task", { title: `${P}周报上的卡`, boardId: flow });
    await browser.waitUntil(async () => (await tasks()).some((t) => t.title === `${P}周报上的卡`), { timeout: 5000 });
    await menuOf(FLOW);
    await pick("删除这块看板");
    await browser.waitUntil(async () => (await flashText()).includes("先把这块看板上的 1 张卡挪走"), { timeout: 5000, timeoutMsg: "不空的看板删除没响亮拒" });
    expect((await boards()).find((b) => b.id === flow).deleted).toBe(false);

    // 空的那块:问一次,确认就删
    await menuOf(READ2);
    await pick("删除这块看板");
    await $(".bn-delete-ask").waitForExist({ timeout: 5000 });
    await browser.execute(() => document.querySelector(".bn-delete-ask .th-go").click());
    await browser.waitUntil(async () => (await boards()).find((b) => b.id === read).deleted === true, { timeout: 8000, timeoutMsg: "确认删除没落库" });
    await browser.waitUntil(
      async () => !(await browser.execute(() => [...document.querySelectorAll("#board-nav .bn-item")].map((b) => b.querySelector(".bn-name").textContent.trim()))).includes(READ2),
      { timeout: 8000, timeoutMsg: "删完侧栏还挂着那块" },
    );
  });
});

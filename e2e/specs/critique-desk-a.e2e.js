import { browser, $, expect } from "@wdio/globals";
import { clearInbox, goNotebook, inboxShow, invoke, tryInvoke } from "./support.js";

// 应用评审修复 · 桌面 A 组(样式毛病 + 空态与教学期指路 + 用词)里能自动化的几条:
//  A1 搜索框的焦点圈画在外层圆角框 `.field` 上,`#q` 自己不画(此前一圈直角框压在圆角框里);
//  A3 设置页小钮 / 分段开关与旁边的说明同一种界面字体(此前写死衬线);
//  G1 随记空态标题说「这儿是干嘛的」(那句提示的两形在 settings-walk161-d1 那例里钉着);
//  G2 教学期(记过随记、还没转过待办 = `.hk-teach` 那个条件)列表下方一行灰字;条件不成立下一发自己消失;筛空 / 回收站不出;
//  G3 空看板再说一句「卡片可以拖到别的列」:点名的是这块看板**此刻的完成列名**(角色,不是最后一列);没有完成列只说能拖;只有一列不说;
//  D3 同一条创建时间轴:看板页叫「记于」,随记页仍叫「时间」;
//  W3 搜索空着时的标题:只有一个空间不提「当前空间」。
// ⚠ 种子三列那几句(`.col-empty-role`)要种子看板一张卡都没有才出,累积库上摆不出来 ⇒ 空库实例上看图验(回报里有图)。
// ⚠ G2 的条件是全库累计的统计(转过一次就永远不成立)⇒ 这里把 `idea_stats` 的回话在页内换掉(见 stubStats)来摆出两态,
//    别的命令照常走真后端;收场还原。

const P = "评审A-";
const BOARD_DONE = `${P}有完成列`;
const BOARD_PLAIN = `${P}纯分类`;
const BOARD_ONE = `${P}只一列`;

const nav = (view) => browser.execute((v) => document.querySelector(`button[data-view="${v}"]`).click(), view);

/** 把页内的 `idea_stats` 回话钉成 `stats`(null = 还原)。
 *  ⚠ 换的是 `window.fetch`,不是 `__TAURI_INTERNALS__.invoke`:后者是壳用 defineProperty 钉死的(赋值被静默吞掉,
 *  第一版就栽在这);而 IPC 每条命令都是一发 `fetch(…/idea_stats)`,回话认 `Tauri-Response: ok` + JSON。
 *  ⭐ 换没换上有自证:下面空态那一格断「空库上 `.hk-teach` 也挂着」—— 真统计给不出这个读数。 */
const stubStats = (stats) =>
  browser.execute((s) => {
    if (!window.__zjRealFetch) window.__zjRealFetch = window.fetch;
    const real = window.__zjRealFetch;
    window.fetch =
      s === null
        ? real
        : (input, init) => {
            const url = typeof input === "string" ? input : input.url;
            if (!/\/idea_stats$/.test(url)) return real(input, init);
            return Promise.resolve(
              new Response(JSON.stringify(s), { status: 200, headers: { "Content-Type": "application/json", "Tauri-Response": "ok" } }),
            );
          };
  }, stats);

/** 重挂随记页(切走再回来 = 重新读一发统计)。⛔ 只点侧栏、别走 `goNotebook` / `inboxShow`:那两支会整页重载,
 *  页内换掉的 `idea_stats` 跟着没了(第一版就栽在这:两态读到的都是真统计)。每次挂载都从想法那半起步(W3 A6)。 */
async function remountInbox() {
  await nav("search");
  await $(".v-search").waitForExist({ timeout: 5000 });
  await nav("inbox");
  await $(".v-inbox").waitForExist({ timeout: 5000 });
}
const trashToggle = () => browser.execute(() => document.querySelector("#inbox-trash-toggle").click());

const teachState = () =>
  browser.execute(() => ({
    cls: document.querySelector(".v-inbox").classList.contains("hk-teach"),
    hint: document.querySelector(".v-inbox .teach-hint")?.textContent ?? null,
    notes: document.querySelectorAll(".v-inbox .note").length,
  }));

async function navBoard(name) {
  await browser.execute((n) => {
    const b = [...document.querySelectorAll("#board-nav .bn-item")].find((x) => x.querySelector(".bn-name").textContent.trim() === n);
    if (!b) throw new Error(`侧栏没有看板「${n}」`);
    b.click();
  }, name);
  await browser.waitUntil(async () => (await browser.execute(() => document.querySelector(".v-board header h1")?.textContent ?? null)) === name, {
    timeout: 8000,
    timeoutMsg: `页头一直不是「${name}」`,
  });
}

async function cleanup() {
  await stubStats(null);
  for (const i of await invoke("list_ideas")) if (i.content.startsWith(P)) await invoke("archive_note", { id: i.id });
  for (const i of await invoke("list_archived")) if (i.content.startsWith(P)) await invoke("purge_note", { id: i.id });
  for (const b of await invoke("list_boards")) {
    if (b.deleted || !b.title.startsWith(P)) continue;
    const r = await tryInvoke("delete_board", { id: b.id });
    if (!r.ok) throw new Error(`收场删看板失败(${b.title}):${r.err}`);
  }
  await browser.execute(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith("zhujian.board-current.")) localStorage.removeItem(k);
  });
}

describe("应用评审修复 · 桌面 A 组", () => {
  before(async () => {
    await goNotebook("inbox");
    await cleanup();
  });
  after(async () => {
    await cleanup();
  });

  it("A1:搜索框拿到焦点,那一圈画在外层圆角框上,输入框自己不画", async () => {
    await goNotebook("search");
    await browser.execute(() => document.getElementById("q").focus());
    const s = await browser.execute(() => {
      const q = document.getElementById("q");
      const field = q.closest(".field");
      return {
        focused: document.activeElement === q,
        q: getComputedStyle(q).boxShadow,
        field: getComputedStyle(field).boxShadow,
        radius: parseFloat(getComputedStyle(field).borderTopLeftRadius),
      };
    });
    expect(s.focused).toBe(true);
    expect(s.q).toBe("none");
    // 外框:第一层是那一圈(0 0 0 2px,无模糊),后面跟着卡片投影。
    expect(s.field).toMatch(/0px 0px 0px 2px/);
    expect(s.radius).toBeGreaterThan(0);
    // 焦点离开就收
    await browser.execute(() => document.getElementById("q").blur());
    expect(await browser.execute(() => getComputedStyle(document.querySelector(".v-search .field")).boxShadow)).not.toMatch(/0px 0px 0px 2px/);
  });

  it("A3:设置页的小钮与分段开关和旁边的说明同一种字体", async () => {
    await goNotebook("inbox");
    await browser.execute(() => document.getElementById("settings-entry").click());
    await $(".settings-panel").waitForExist({ timeout: 5000 });
    const f = await browser.execute(() => {
      const fam = (sel) => {
        const n = document.querySelector(sel);
        if (!n) throw new Error(`设置面板里没有 ${sel}`);
        return getComputedStyle(n).fontFamily;
      };
      return { desc: fam(".settings-panel .hkset-desc"), change: fam(".settings-panel .hkset-change"), seg: fam(".settings-panel .seg-btn") };
    });
    expect(f.change).toBe(f.desc);
    expect(f.seg).toBe(f.desc);
    await browser.execute(() => document.querySelector(".settings-close").click());
    await $(".settings-overlay").waitForExist({ timeout: 5000, reverse: true });
  });

  it("G1 / G2:空态标题换了;教学期列表下方一行灰字,转过待办就没了,筛空与回收站不出", async () => {
    await clearInbox();
    await inboxShow("ideas");
    await $(".v-inbox .center .big").waitForExist({ timeout: 8000 });
    expect(await $(".v-inbox .center .big").getText()).toBe("想到什么,先记在这儿");
    // 空态上不出教学那行(哪怕条件成立)
    await stubStats({ captured_week: 1, born_inbox: 1, converted: 0 });
    await remountInbox();
    await $(".v-inbox .center .big").waitForExist({ timeout: 8000 });
    expect(await teachState()).toEqual({ cls: true, hint: null, notes: 0 });

    // 记一条 ⇒ 教学期:⋯ 常驻 + 列表下方那一行
    await invoke("capture_note", { content: `${P}教学期那一条` });
    await stubStats({ captured_week: 1, born_inbox: 1, converted: 0 });
    await remountInbox();
    await browser.waitUntil(async () => (await teachState()).notes === 1, { timeout: 8000, timeoutMsg: "那条随记没画出来" });
    let st = await teachState();
    expect(st.cls).toBe(true);
    expect(st.hint).toBe("点卡片右上角的 ⋯,可以打标签,或转成待办放进看板。");
    // 那一行在卡片列表之后
    expect(
      await browser.execute(() => {
        const hint = document.querySelector(".v-inbox .teach-hint");
        const tl = document.querySelector(".v-inbox .timeline");
        return !!(tl.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING);
      }),
    ).toBe(true);

    // 筛空:不出
    await browser.execute(() => {
      const box = document.querySelector("#idea-filter");
      box.value = "这个词哪条都没有zzz";
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await browser.waitUntil(async () => (await teachState()).notes === 0, { timeout: 8000, timeoutMsg: "过滤词没把列表筛空" });
    expect((await teachState()).hint).toBe(null);
    await browser.execute(() => {
      const box = document.querySelector("#idea-filter");
      box.value = "";
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await browser.waitUntil(async () => (await teachState()).notes === 1, { timeout: 8000, timeoutMsg: "清掉过滤词后那条没回来" });
    expect((await teachState()).hint).not.toBe(null);

    // 回收站:不出
    await trashToggle();
    await browser.waitUntil(async () => browser.execute(() => document.querySelector(".v-inbox").classList.contains("in-trash")), {
      timeout: 5000,
      timeoutMsg: "没进回收站那半",
    });
    expect((await teachState()).hint).toBe(null);
    await trashToggle();
    await browser.waitUntil(async () => (await teachState()).notes === 1, { timeout: 8000, timeoutMsg: "从回收站回来后那条没画出来" });
    expect((await teachState()).hint).not.toBe(null);

    // 转过一次待办(统计里 converted 不再是 0)⇒ 下一发自己消失,⋯ 回到悬停才现
    await stubStats({ captured_week: 1, born_inbox: 1, converted: 1 });
    await remountInbox();
    await browser.waitUntil(async () => (await teachState()).notes === 1, { timeout: 8000, timeoutMsg: "那条随记没画出来(第二发)" });
    st = await teachState();
    expect(st.cls).toBe(false);
    expect(st.hint).toBe(null);
    await stubStats(null);
  });

  it("G3:空看板说「卡片可以拖到别的列」—— 点名此刻的完成列;没有完成列只说能拖;只有一列不说", async () => {
    // 完成列故意放在**中间**:句子认的是角色,不是「最后一列」。
    await invoke("create_board", { title: BOARD_DONE, columns: ["排队", "办结", "搁着"], doneIndex: 1 });
    await invoke("create_board", { title: BOARD_PLAIN, columns: ["想看", "在看"], doneIndex: null });
    await invoke("create_board", { title: BOARD_ONE, columns: ["收着"], doneIndex: null });
    await goNotebook("board");
    await browser.waitUntil(async () => (await browser.execute(() => document.querySelectorAll("#board-nav .bn-item").length)) >= 4, {
      timeout: 8000,
      timeoutMsg: "新建的三块看板没进侧栏",
    });
    const said = async () => {
      await $(".v-board .col-empty").waitForExist({ timeout: 8000 });
      return browser.execute(() => ({
        drag: document.querySelector(".v-board .col-empty-drag")?.textContent ?? null,
        inFirstCol: !!document.querySelector(".v-board .col .col-body")?.querySelector(".col-empty-drag"),
        roles: document.querySelectorAll(".v-board .col-empty-role").length,
      }));
    };
    await navBoard(BOARD_DONE);
    expect(await said()).toEqual({ drag: "卡片可以拖到别的列,拖进「办结」列就是做完。", inFirstCol: true, roles: 0 });
    await navBoard(BOARD_PLAIN);
    expect(await said()).toEqual({ drag: "卡片可以拖到别的列。", inFirstCol: true, roles: 0 });
    await navBoard(BOARD_ONE);
    expect(await said()).toEqual({ drag: null, inFirstCol: false, roles: 0 });
  });

  it("D3:看板上那条轴叫「记于」,随记页仍叫「时间」", async () => {
    const id = await invoke("create_task", { title: `${P}轴名用的卡` });
    try {
      await goNotebook("board");
      await navBoard("任务");
      const axis = (sel) =>
        browser.execute((s) => [...document.querySelectorAll(`${s} .tf-axis`)].map((x) => x.textContent), sel);
      await browser.waitUntil(async () => (await axis(".v-board")).length > 0, { timeout: 8000, timeoutMsg: "看板筛选行没画出轴名" });
      const onBoard = await axis(".v-board");
      expect(onBoard).toContain("记于");
      expect(onBoard).not.toContain("时间");

      await invoke("capture_note", { content: `${P}轴名用的随记` });
      await remountInbox();
      await browser.waitUntil(async () => (await axis(".v-inbox")).length > 0, { timeout: 8000, timeoutMsg: "随记筛选行没画出轴名" });
      const onInbox = await axis(".v-inbox");
      expect(onInbox).toContain("时间");
      expect(onInbox).not.toContain("记于");
    } finally {
      await invoke("archive_task", { id });
      await invoke("purge_task", { id });
    }
  });

  it("W3:搜索空着时,只有一个空间不提「当前空间」;多个空间才点名", async () => {
    const spaces = await browser.execute(() => window.__TAURI__.core.invoke("list_spaces"));
    await goNotebook("search");
    await browser.execute(() => {
      const input = document.getElementById("q");
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const want = spaces.length > 1 ? "在当前空间的所有条目里查找" : "在所有内容里查找";
    await browser.waitUntil(async () => (await browser.execute(() => document.querySelector(".v-search .center.idle .big")?.textContent ?? null)) === want, {
      timeout: 8000,
      timeoutMsg: `搜索空态标题不是「${want}」(空间数 ${spaces.length})`,
    });
  });
});

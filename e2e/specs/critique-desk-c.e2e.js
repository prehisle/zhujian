import { browser, $, expect } from "@wdio/globals";
import { boardAction, boardMore, clearInbox, goNotebook, inboxAction, inboxShow, invoke, toLightbox, tryInvoke } from "./support.js";

// 应用评审二轮 · 桌面 C 组(上一轮没看到的面里的确凿毛病:浮层 / 次级页 / 边界 / 缩放 / 纯键盘)里能自动化的几条:
//  C1 重置空间的两枚钮走 .hbtn、「确认重置」实心朱砂、焦点落「取消」(⛔ 这支绝不点「确认重置」);
//  C2 随记编辑态「＋加图」不是原生灰钮;C3 删卡确认里的「不再提示」是应用自己的方框;
//  C4 管理看板面板:长列名不把面板撑出横向滚动条;
//  C5 卡片色板的「无色」不在自己内部折行;C6 超长标签的筛选 pill 不越出筛选条、名字省略、悬停给完整名字;
//  C7 标签选择器打开 / 打字后整块在可视区内;
//  C8 浮层关掉后焦点有处可落:管理看板 Esc → 「⋯」;新建看板建好 → 「+ 新建看板」;看大图 Esc → 那张卡的 ⋯;
//     删掉屏上最后一张随记 → 记一笔框;
//  C9 视口很矮(界面字号 200%)时筛选条跟着内容滚、内容够得上来;正常高度下视图不滚、页头不吸顶(零变化)。
// 原生滚动条(C4 的另一半)、字色那几档(C10)是看图 / 对比度门禁的事,不在这里。

const P = "评审C-";
const LONG_TAG = `${P}一个特别特别长的标签名字用来看筛选条在窄窗口里会不会被窗口边切掉一二三四五六七八九十一二三四五六`;
const LONG_COL = `${P}一个名字特别特别长的列看看管理面板里会不会被撑宽一二三四五六七八九十`;

const nav = (view) => browser.execute((v) => document.querySelector(`.sidebar nav button[data-view="${v}"]`).click(), view);
const focusDesc = () =>
  browser.execute(() => {
    const a = document.activeElement;
    if (!a || a === document.body) return "BODY";
    return `${a.tagName.toLowerCase()}${a.id ? "#" + a.id : ""}.${a.className}`;
  });
const esc = () =>
  browser.execute(() => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
const setSize = async (w, h) => {
  await browser.execute(
    async (ww, hh) => {
      const W = window.__TAURI__.window;
      await W.getCurrentWindow().setSize(new W.LogicalSize(ww, hh));
    },
    w,
    h,
  );
  await browser.waitUntil(async () => (await browser.execute(() => window.innerWidth)) === w, { timeout: 5000, timeoutMsg: `视口宽没到 ${w}` });
};
const setZoom = async (z, wantH) => {
  await browser.execute(async (f) => {
    await window.__TAURI__.webview.getCurrentWebview().setZoom(f);
  }, z);
  await browser.waitUntil(async () => Math.abs((await browser.execute(() => window.innerHeight)) - wantH) <= 2, {
    timeout: 5000,
    timeoutMsg: `缩放 ${z} 之后视口高没到 ${wantH}`,
  });
};

async function purgeMine() {
  for (const n of [...(await invoke("list_inbox")), ...(await invoke("list_processed"))]) {
    if (!n.content.startsWith(P)) continue;
    await invoke("archive_note", { id: n.id });
    await invoke("purge_note", { id: n.id });
  }
  for (const t of await invoke("list_tasks")) {
    if (!t.title.startsWith(P)) continue;
    await invoke("archive_task", { id: t.id });
    await invoke("purge_task", { id: t.id });
  }
  for (const b of await invoke("list_boards")) {
    if (b.deleted || !b.deletable || !b.title.startsWith(P)) continue;
    const r = await tryInvoke("delete_board", { id: b.id });
    if (!r.ok) throw new Error(`收场删看板失败(${b.title}):${r.err}`);
  }
  for (const tp of await invoke("list_topics")) {
    if (tp.title.startsWith(P)) await invoke("delete_topic", { id: tp.id });
  }
  await browser.execute(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith("zhujian.board-current.")) localStorage.removeItem(k);
  });
}

describe("应用评审 C · 原生控件漏样式与溢出", () => {
  let taskId;

  before(async () => {
    await goNotebook("board");
    await purgeMine();
    const tid = await invoke("create_topic", { title: LONG_TAG });
    taskId = await invoke("create_task", { title: `${P}带超长标签的一张卡`, dueOn: null, priority: null, topicId: tid });
    const nid = await invoke("capture_note", { content: `${P}带超长标签的一条随记` });
    await invoke("file_note_to_topic", { id: nid, topicId: tid, newTitle: null });
  });

  after(async () => {
    await setSize(1260, 700);
    await purgeMine();
  });

  it("C1:重置空间的确认 = 两枚 .hbtn,「确认重置」实心、「取消」幽灵;焦点落「取消」", async () => {
    await goNotebook("inbox");
    await browser.execute(() => document.getElementById("space-entry").click());
    await $(".space-menu").waitForExist({ timeout: 5000 });
    await browser.execute(() => [...document.querySelectorAll(".space-menu .space-row.action")].find((r) => r.textContent.includes("重置")).click());
    const f = await browser.execute(() => {
      const form = document.querySelector(".space-menu .space-form");
      const [ok, cancel] = form.querySelectorAll(".space-form-acts button");
      const a = getComputedStyle(ok);
      const b = getComputedStyle(cancel);
      return {
        n: form.querySelectorAll("button").length,
        ok: { text: ok.textContent, hbtn: ok.classList.contains("hbtn"), solid: a.backgroundColor === a.borderTopColor, radius: a.borderTopLeftRadius },
        cancel: { text: cancel.textContent, hbtn: cancel.classList.contains("hbtn"), bg: b.backgroundColor, radius: b.borderTopLeftRadius },
        focus: document.activeElement === cancel,
        sameRow: Math.abs(ok.getBoundingClientRect().top - cancel.getBoundingClientRect().top) < 2,
      };
    });
    expect(f).toEqual({
      n: 2,
      ok: { text: "确认重置", hbtn: true, solid: true, radius: f.cancel.radius },
      cancel: { text: "取消", hbtn: true, bg: "rgba(0, 0, 0, 0)", radius: f.cancel.radius },
      focus: true,
      sameRow: true,
    });
    expect(parseFloat(f.cancel.radius)).toBeGreaterThan(10); // 胶囊,不是原生方钮
    // ⛔ 只点「取消」
    await browser.execute(() => document.querySelector(".space-menu .space-form-acts .hbtn:not(.space-danger)").click());
    await $(".space-menu").waitForExist({ timeout: 5000, reverse: true });
  });

  it("C2:随记编辑态的「＋加图」是 .hbtn(胶囊、透明底、有描边),不是原生灰钮", async () => {
    await inboxShow("ideas");
    await $(`.note*=${P}带超长标签的一条随记`).waitForExist({ timeout: 8000 });
    await browser.execute((t) => {
      const n = [...document.querySelectorAll(".v-inbox .note")].find((x) => x.textContent.includes(t));
      n.querySelector(".note-text").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    }, `${P}带超长标签的一条随记`);
    await $(".v-inbox .add-img").waitForExist({ timeout: 5000 });
    const s = await browser.execute(() => {
      const b = document.querySelector(".v-inbox .add-img");
      const cs = getComputedStyle(b);
      return { hbtn: b.classList.contains("hbtn"), bg: cs.backgroundColor, radius: parseFloat(cs.borderTopLeftRadius), border: cs.borderTopStyle, cursor: cs.cursor };
    });
    expect(s.hbtn).toBe(true);
    expect(s.bg).toBe("rgba(0, 0, 0, 0)");
    expect(s.radius).toBeGreaterThan(10);
    expect(s.border).toBe("solid");
    expect(s.cursor).toBe("pointer");
    await browser.execute(() => document.querySelector(".v-inbox .edit-area").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  });

  it("C6:超长标签的筛选 pill 不越出筛选条(900 宽);名字省略、计数还在;悬停给完整名字", async () => {
    await setSize(900, 600);
    for (const [view, bar] of [
      ["inbox", "#idea-topic-filter"],
      ["board", "#topic-filter"],
    ]) {
      await nav(view);
      await $(`.v-${view}`).waitForExist({ timeout: 5000 });
      await browser.waitUntil(
        () => browser.execute((b, t) => [...document.querySelectorAll(`${b} .tf-pill`)].some((p) => p.textContent.includes(t)), bar, P),
        { timeout: 8000, timeoutMsg: `${view}:筛选条里没有那枚超长标签` },
      );
      const g = await browser.execute(
        (b, t) => {
          const pill = [...document.querySelectorAll(`${b} .tf-pill`)].find((p) => p.textContent.includes(t));
          const label = pill.querySelector(".flabel");
          const n = pill.querySelector(".tf-n");
          const pr = pill.getBoundingClientRect();
          const br = pill.parentElement.getBoundingClientRect();
          pill.dispatchEvent(new MouseEvent("mouseenter"));
          return {
            inBar: pr.right <= br.right + 0.5 && pr.left >= br.left - 0.5,
            inWindow: pr.right <= window.innerWidth,
            clipped: label.scrollWidth > label.clientWidth,
            countShown: n.getBoundingClientRect().right <= pr.right && n.getBoundingClientRect().width > 0,
            title: pill.title,
            docOverflow: document.documentElement.scrollWidth > window.innerWidth,
          };
        },
        bar,
        P,
      );
      expect({ view, ...g, title: g.title.split("\n")[0] }).toEqual({
        view,
        inBar: true,
        inWindow: true,
        clipped: true,
        countShown: true,
        title: LONG_TAG,
        docOverflow: false,
      });
    }
    // 短名字的 pill 不带名字 title(没被省略 ⇒ 只剩那句多选提示 / 空)
    const short = await browser.execute(() => {
      const p = document.querySelector("#topic-filter .tf-pill");
      p.dispatchEvent(new MouseEvent("mouseenter"));
      return p.title;
    });
    expect(short).toBe("");
    await setSize(1260, 700);
  });

  it("C5:卡片色板一排挤不下时整枚换行,「无色」自己不折成两行", async () => {
    await goNotebook("board");
    await $(`.tcard*=${P}带超长标签的一张卡`).waitForExist({ timeout: 8000 });
    await boardAction(`${P}带超长标签的一张卡`, "颜色");
    await $(".v-board .card-color-row").waitForExist({ timeout: 5000 });
    const g = await browser.execute(() => {
      const row = document.querySelector(".v-board .card-color-row");
      // 把它那一格钉窄(累积库上列宽不定;窄列是这条要守的形):八枚一排必然放不下
      row.parentElement.style.width = "150px";
      const none = row.querySelector(".color-swatch.none");
      const dots = [...row.querySelectorAll(".color-swatch:not(.none)")].map((d) => d.getBoundingClientRect().width);
      const card = row.closest(".tcard").getBoundingClientRect();
      return {
        noneH: none.getBoundingClientRect().height,
        noneFits: none.scrollWidth <= none.clientWidth,
        dots: [...new Set(dots)],
        inCard: row.getBoundingClientRect().right <= card.right,
        inSlot: row.getBoundingClientRect().right <= row.parentElement.getBoundingClientRect().right + 0.5,
        rows: new Set([...row.children].map((c) => Math.round(c.getBoundingClientRect().top))).size,
      };
    });
    expect(g.rows).toBeGreaterThan(1); // 真的换了行(摆位成立)
    expect({ ...g, rows: 0 }).toEqual({ noneH: 20, noneFits: true, dots: [20], inCard: true, inSlot: true, rows: 0 });
    await esc();
  });

  it("C3:删卡确认里的「不再提示」是应用自己的方框(不是原生白框),照旧勾得上", async () => {
    await browser.execute(() => localStorage.removeItem("ysNotebook.taskArchiveConfirmDismissed"));
    await goNotebook("board");
    await $(`.tcard*=${P}带超长标签的一张卡`).waitForExist({ timeout: 8000 });
    await boardAction(`${P}带超长标签的一张卡`, "删除");
    await $(".v-board .dont-ask input").waitForExist({ timeout: 5000 });
    const g = await browser.execute(() => {
      const inp = document.querySelector(".v-board .dont-ask input");
      const before = getComputedStyle(inp);
      const r = { appearance: before.appearance, w: inp.getBoundingClientRect().width, bg0: before.backgroundColor, type: inp.type };
      inp.click();
      const after = getComputedStyle(inp);
      const cancel = document.querySelector(".v-board .tcard .act.ghost");
      return { ...r, checked: inp.checked, bg1: after.backgroundColor, seal: getComputedStyle(document.querySelector(".v-board .tcard .act.primary")).backgroundColor, focusCancel: document.activeElement === cancel };
    });
    expect(g.appearance).toBe("none");
    expect(g.type).toBe("checkbox");
    expect(g.w).toBe(14);
    expect(g.bg0).toBe("rgba(0, 0, 0, 0)");
    expect(g.checked).toBe(true);
    expect(g.bg1).toBe(g.seal); // 勾上 = 朱砂底(同旁边那枚执行钮)
    expect(g.focusCancel).toBe(true);
    // 取消:卡还在、没写「以后不问」
    await browser.execute(() => document.querySelector(".v-board .tcard .act.ghost").click());
    await $(`.tcard*=${P}带超长标签的一张卡`).waitForExist({ timeout: 8000 });
    expect((await invoke("list_tasks")).some((t) => t.id === taskId)).toBe(true);
  });

  it("C4:管理看板 —— 长列名的角色 pill 封顶到行宽,面板不长横向滚动条(900 宽)", async () => {
    const bid = await invoke("create_board", { title: `${P}长列名的一块`, columns: ["收件", LONG_COL, "做完"], doneIndex: 2 });
    await browser.execute((id) => {
      for (const k of Object.keys(localStorage)) if (k.startsWith("zhujian.board-current.")) localStorage.removeItem(k);
      void id;
    }, bid);
    await goNotebook("board");
    await setSize(900, 600);
    await browser.waitUntil(() => browser.execute((id) => !!document.querySelector(`.bn-item[data-board="${id}"]`), bid), {
      timeout: 8000,
      timeoutMsg: "侧栏里没有新建的那块看板",
    });
    await browser.execute((id) => document.querySelector(`.bn-item[data-board="${id}"]`).click(), bid);
    await browser.waitUntil(() => browser.execute((id) => document.querySelector(`.bn-item[data-board="${id}"]`)?.classList.contains("active"), bid), {
      timeout: 8000,
      timeoutMsg: "没切到新建的那块看板",
    });
    await boardMore("manage-cols");
    await $(".bcm-panel .bcm-pill").waitForExist({ timeout: 5000 });
    const g = await browser.execute((name) => {
      const p = document.querySelector(".bcm-panel");
      const pills = [...p.querySelectorAll(".bcm-pill")].filter((b) => b.textContent === name);
      for (const b of pills) b.dispatchEvent(new MouseEvent("mouseenter"));
      const rowR = pills[0].parentElement.getBoundingClientRect().right;
      return {
        hOverflow: p.scrollWidth > p.clientWidth,
        n: pills.length,
        inRow: pills.every((b) => b.getBoundingClientRect().right <= rowR + 0.5),
        clipped: pills.every((b) => b.scrollWidth > b.clientWidth),
        titles: [...new Set(pills.map((b) => b.title))],
      };
    }, LONG_COL);
    expect(g).toEqual({ hOverflow: false, n: 2, inRow: true, clipped: true, titles: [LONG_COL] });
    await esc();
    await $(".bcm-overlay").waitForExist({ timeout: 5000, reverse: true });
    await setSize(1260, 700);
  });
});

describe("应用评审 C · 标签选择器滚进可视区", () => {
  before(async () => {
    await goNotebook("inbox");
    await purgeMine();
    await clearInbox();
    await invoke("create_topic", { title: `${P}候选甲` });
    await invoke("create_topic", { title: `${P}候选乙` });
    for (let i = 0; i < 8; i++) await invoke("capture_note", { content: `${P}滚动用的第 ${i} 条\n第二行\n第三行` });
  });

  after(async () => {
    await purgeMine();
  });

  it("C7:底边贴着视口下沿的那张卡开标签选择器 ⇒ 输入框与候选整块在可视区内;打字后仍在", async () => {
    await inboxShow("ideas");
    const target = `${P}滚动用的第 3 条`;
    await $(`.note*=${target}`).waitForExist({ timeout: 8000 });
    // 把那张卡的底边对齐到列表可视区的下沿(选择器此刻要长在视口之外)
    const placed = await browser.execute((t) => {
      const main = document.querySelector(".v-inbox main");
      const n = [...document.querySelectorAll(".v-inbox .note")].find((x) => x.textContent.includes(t));
      main.scrollTop += n.getBoundingClientRect().bottom - main.getBoundingClientRect().bottom;
      return { gap: Math.round(n.getBoundingClientRect().bottom - main.getBoundingClientRect().bottom), scrolled: main.scrollTop > 0 };
    }, target);
    expect(placed).toEqual({ gap: 0, scrolled: true }); // 摆位成立(否则下面的断言是空的)
    await inboxAction(target, "标签");
    await $(".v-inbox .topic-picker .topic-choices .choice").waitForExist({ timeout: 5000 });
    const inView = () =>
      browser.execute(() => {
        const main = document.querySelector(".v-inbox main").getBoundingClientRect();
        const p = document.querySelector(".v-inbox .topic-picker").getBoundingClientRect();
        const last = [...document.querySelectorAll(".v-inbox .topic-picker .choice")].pop().getBoundingClientRect();
        return { top: p.top >= main.top - 0.5, bottom: p.bottom <= main.bottom + 0.5, lastChoice: last.bottom <= main.bottom + 0.5 && last.height > 0 };
      });
    expect(await inView()).toEqual({ top: true, bottom: true, lastChoice: true });
    // 打字:候选换了一批(筛出两枚 + 「创建」),整块仍在屏内
    await browser.execute(() => {
      const s = document.querySelector(".v-inbox .topic-search");
      s.value = "候选";
      s.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(await browser.execute(() => document.querySelectorAll(".v-inbox .topic-picker .choice").length)).toBe(3);
    expect(await inView()).toEqual({ top: true, bottom: true, lastChoice: true });
    await esc();
    await $(".v-inbox .topic-picker").waitForExist({ timeout: 5000, reverse: true });
  });
});

describe("应用评审 C · 浮层关掉后焦点有处可落", () => {
  before(async () => {
    await goNotebook("board");
    await purgeMine();
  });

  after(async () => {
    await purgeMine();
  });

  it("C8:键盘开「⋯ → 管理看板」再 Esc ⇒ 焦点回「⋯」;从里面开「新建一块看板」取消回来再 Esc 也回「⋯」", async () => {
    await goNotebook("board");
    await $("#board-more").waitForExist({ timeout: 8000 });
    await browser.execute(() => {
      const more = document.querySelector("#board-more");
      more.focus();
      more.click();
    });
    await browser.execute(() => document.querySelector("#manage-cols").click());
    await $(".bcm-panel .bcm-close").waitForExist({ timeout: 5000 });
    await browser.waitUntil(async () => (await focusDesc()).includes("bcm-close"), { timeout: 5000, timeoutMsg: "面板打开后焦点没进面板" });
    await esc();
    await $(".bcm-overlay").waitForExist({ timeout: 5000, reverse: true });
    expect(await focusDesc()).toBe("button#board-more.hbtn");

    // 管理看板 → 新建一块看板 → 取消(回管理面)→ Esc
    await boardMore("manage-cols");
    await $(".bcm-panel .bcm-close").waitForExist({ timeout: 5000 });
    await browser.execute(() => [...document.querySelectorAll(".bcm-panel .bcm-btn")].find((b) => b.textContent.includes("新建一块看板")).click());
    await $(".bn-new").waitForExist({ timeout: 5000 });
    await esc();
    await $(".bn-new").waitForExist({ timeout: 5000, reverse: true });
    await $(".bcm-panel .bcm-close").waitForExist({ timeout: 5000 });
    await browser.waitUntil(async () => (await focusDesc()).includes("bcm-close"), { timeout: 5000, timeoutMsg: "取消新建后没回到管理面" });
    await esc();
    await $(".bcm-overlay").waitForExist({ timeout: 5000, reverse: true });
    expect(await focusDesc()).toBe("button#board-more.hbtn");
  });

  it("C8:侧栏「+ 新建看板」建好之后 ⇒ 焦点在(重画后的)「+ 新建看板」上,不掉到 body", async () => {
    // 侧栏要有 ≥2 块才展开出那枚钮
    await invoke("create_board", { title: `${P}垫一块`, columns: ["一列"], doneIndex: null });
    await goNotebook("board");
    await $(".sidebar .bn-add").waitForExist({ timeout: 8000 });
    await browser.execute(() => {
      const add = document.querySelector(".sidebar .bn-add");
      window.__oldAdd = add;
      add.focus();
      add.click();
    });
    await $(".bn-new .bcm-col-input").waitForExist({ timeout: 5000 });
    await browser.execute((name) => {
      document.querySelector(".bn-new .bcm-col-input").value = name;
      document.querySelector(".bn-new .bcm-btn.solid-ink").click();
    }, `${P}键盘建的一块`);
    await $(".bn-new").waitForExist({ timeout: 5000, reverse: true });
    // 等侧栏重画完(新那块出现在侧栏里),再读焦点
    await browser.waitUntil(() => browser.execute((n) => [...document.querySelectorAll(".sidebar .bn-item")].some((b) => b.textContent.includes(n)), `${P}键盘建的一块`), {
      timeout: 8000,
      timeoutMsg: "侧栏没画出新建的那块看板",
    });
    await browser.waitUntil(async () => (await browser.execute(() => !window.__oldAdd.isConnected)) === true, {
      timeout: 5000,
      timeoutMsg: "侧栏那枚旧的「+ 新建看板」一直没被重画换掉(这一例要验的正是重画之后)",
    });
    expect(await focusDesc()).toBe("button.bn-add");
    expect(await browser.execute(() => document.activeElement.isConnected && document.activeElement !== window.__oldAdd)).toBe(true);
  });

  it("C8:点卡上的小图看大图、Esc 关掉 ⇒ 焦点在那张卡的 ⋯ 上", async () => {
    await goNotebook("inbox");
    await clearInbox();
    const id = await invoke("capture_note", { content: `${P}带一张图的随记` });
    const png = await browser.execute(() => {
      const c = document.createElement("canvas");
      c.width = 6;
      c.height = 6;
      c.getContext("2d").fillRect(0, 0, 6, 6);
      return c.toDataURL("image/png").split(",")[1];
    });
    await invoke("add_item_image", { itemId: id, mime: "image/png", dataB64: png });
    await inboxShow("ideas");
    const card = await $(`.note*=${P}带一张图的随记`);
    await card.waitForExist({ timeout: 10000 });
    const thumb = await card.$(".img-thumb-img");
    await thumb.waitForExist({ timeout: 10000 });
    await browser.execute(() => document.activeElement?.blur?.());
    expect(await focusDesc()).toBe("BODY");
    await thumb.click();
    const back = await toLightbox();
    await (await $(".img-lightbox")).waitForExist({ timeout: 10000 });
    await browser.keys(["Escape"]);
    await browser.waitUntil(async () => !(await $(".img-lightbox").isExisting()), { timeout: 10000, timeoutMsg: "Esc 没关掉大图" });
    await back();
    const f = await browser.execute((t) => {
      const a = document.activeElement;
      return { btn: a.classList.contains("hk-btn"), own: a.closest(".note")?.textContent.includes(t) ?? false };
    }, `${P}带一张图的随记`);
    expect(f).toEqual({ btn: true, own: true });
  });

  it("C8:删掉屏上最后一张随记 ⇒ 焦点落到记一笔框;还有别的卡时落到后一张的 ⋯", async () => {
    await goNotebook("inbox");
    await clearInbox();
    await invoke("capture_note", { content: `${P}乙(后一张)` });
    await invoke("capture_note", { content: `${P}甲(先删这张)` });
    await inboxShow("ideas");
    await $(`.note*=${P}甲`).waitForExist({ timeout: 8000 });
    // 真键(同 kbd-walk165-d1):焦点进卡 = 选中这张靠的是 focusin,合成 keydown 赶在它前面会落空。
    const del = async (t) => {
      await browser.execute((txt) => {
        const n = [...document.querySelectorAll(".v-inbox .note")].find((x) => x.textContent.includes(txt));
        n.querySelector(".hk-btn").focus();
      }, t);
      await browser.keys("d");
    };
    await del(`${P}甲`);
    await browser.waitUntil(() => browser.execute((t) => ![...document.querySelectorAll(".v-inbox .note")].some((x) => x.textContent.includes(t)), `${P}甲`), {
      timeout: 8000,
      timeoutMsg: "甲没删掉",
    });
    await browser.waitUntil(async () => (await focusDesc()) !== "BODY", { timeout: 5000, timeoutMsg: "删掉甲之后焦点一直在 body" });
    expect(
      await browser.execute((t) => {
        const a = document.activeElement;
        return a.classList.contains("hk-btn") && a.closest(".note").textContent.includes(t);
      }, `${P}乙`),
    ).toBe(true);
    // 最后一张
    await del(`${P}乙`);
    await browser.waitUntil(() => browser.execute(() => document.querySelectorAll(".v-inbox .note").length === 0), { timeout: 8000, timeoutMsg: "乙没删掉" });
    await browser.waitUntil(async () => (await focusDesc()).includes("compose-input"), {
      timeout: 5000,
      timeoutMsg: "删掉最后一张之后焦点没落到记一笔框",
    });
  });
});

describe("应用评审 C · 视口很矮时筛选条跟着内容滚", () => {
  before(async () => {
    await goNotebook("inbox");
    await purgeMine();
    await clearInbox();
    // 几枚标签把筛选条撑到两三行(200% 下它连同页头吃掉大半个视口)
    for (let i = 0; i < 6; i++) {
      const tid = await invoke("create_topic", { title: `${P}矮窗标签${i}` });
      const nid = await invoke("capture_note", { content: `${P}矮窗用的第 ${i} 条` });
      await invoke("file_note_to_topic", { id: nid, topicId: tid, newTitle: null });
      await invoke("create_task", { title: `${P}矮窗卡 ${i}`, dueOn: null, priority: null, topicId: tid });
    }
  });

  after(async () => {
    await browser.execute(async () => {
      await window.__TAURI__.webview.getCurrentWebview().setZoom(1);
    });
    await purgeMine();
  });

  const layout = (view) =>
    browser.execute((v) => {
      const root = document.querySelector(`.view.v-${v}`);
      const hdr = root.querySelector(":scope > header");
      const main = root.querySelector(":scope > main");
      const fr = root.querySelector(":scope > .filter-row");
      return {
        vh: window.innerHeight,
        overflowY: getComputedStyle(root).overflowY,
        hdrPos: getComputedStyle(hdr).position,
        scrollable: root.scrollHeight > root.clientHeight + 1,
        hdrTop: Math.round(hdr.getBoundingClientRect().top),
        hdrBottom: hdr.getBoundingClientRect().bottom,
        filterTop: fr.getBoundingClientRect().top,
        mainTop: main.getBoundingClientRect().top,
        mainH: main.getBoundingClientRect().height,
      };
    }, view);

  it("C9:正常高度(100%)下一切照旧 —— 视图不滚、页头不吸顶、内容区吃满剩余高度", async () => {
    for (const view of ["inbox", "board"]) {
      await goNotebook(view);
      await $(view === "inbox" ? ".v-inbox .note" : ".v-board .tcard").waitForExist({ timeout: 8000 });
      const g = await layout(view);
      expect({ view, overflowY: g.overflowY, hdrPos: g.hdrPos, scrollable: g.scrollable }).toEqual({ view, overflowY: "hidden", hdrPos: "relative", scrollable: false });
      expect(Math.abs(g.mainTop + g.mainH - g.vh)).toBeLessThan(1.5); // main 的底 = 视口的底
    }
  });

  it("C9:界面字号 200%(视口 630×350)⇒ 视图能滚;滚下去筛选条让开、页头仍在顶上、内容够得上来", async () => {
    for (const [view, first] of [
      ["inbox", ".v-inbox .compose-input"],
      ["board", ".v-board .tcard"],
    ]) {
      await goNotebook(view);
      await $(first).waitForExist({ timeout: 8000 });
      await setZoom(2, 350);
      const top = await layout(view);
      expect({ view, overflowY: top.overflowY, hdrPos: top.hdrPos, scrollable: top.scrollable }).toEqual({ view, overflowY: "auto", hdrPos: "sticky", scrollable: true });
      // 内容区至少占视图高的六成(此前只剩页头与筛选条挤剩的那一点,甚至整个在屏外)
      expect(top.mainH).toBeGreaterThanOrEqual(Math.floor(350 * 0.62) - 1);
      // 滚到底:页头还在顶上,筛选条的顶被页头盖住 / 滚出去了,第一件内容在屏内
      const after = await browser.execute(
        (v, sel) => {
          const root = document.querySelector(`.view.v-${v}`);
          root.scrollTop = root.scrollHeight;
          const hdr = root.querySelector(":scope > header").getBoundingClientRect();
          const fr = root.querySelector(":scope > .filter-row").getBoundingClientRect();
          const el = document.querySelector(sel).getBoundingClientRect();
          const main = root.querySelector(":scope > main").getBoundingClientRect();
          return {
            scrolled: root.scrollTop > 0,
            hdrTop: Math.round(hdr.top),
            filterGaveWay: fr.top < hdr.bottom,
            firstInView: el.top >= hdr.bottom - 0.5 && el.bottom <= window.innerHeight + 0.5,
            mainBottomAtViewport: Math.abs(main.bottom - window.innerHeight) < 1.5,
          };
        },
        view,
        first,
      );
      expect({ view, ...after }).toEqual({ view, scrolled: true, hdrTop: 0, filterGaveWay: true, firstInView: true, mainBottomAtViewport: true });
      await setZoom(1, 700);
    }
  });
});

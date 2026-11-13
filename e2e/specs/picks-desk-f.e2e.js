import { browser, $, $$, expect } from "@wdio/globals";
import { boardAction, clearInbox, goNotebook, inboxAction, inboxShow, invoke, tryInvoke } from "./support.js";

// 应用评审取舍题 · 桌面 F 组(第二波,用户 2026-11-13 拍的那几条里能自动化的):
//  F1 随记编辑态与看板卡片就地编辑态,框下常驻一行「回车或点别处保存 · Esc 不要了」;红字那句出来时让位;
//     放大面板里不显(那里是它自己那句 Ctrl+Enter)。
//  F3 复制失败带原因:钮上 / 菜单行里闪短的「复制失败」,同时屏底一条全句;单键触发的直接出全句。
//     ⛔ 默认套件不碰真剪贴板:劫持 `navigator.clipboard.writeText` 让它拒(同 inbox-copy / deeplink 的形)。
//  F5 标签筛选条两行折叠:「更多 N ▾」/「收起 ▴」、选中的不藏、按视图记、拖卡片时自动展开、窗口变窄重算;
//     不满两行时不出这枚钮。
//  F6 同步浮层:第一屏「创建账户」是唯一主钮、加入是一行淡字链接;创建屏两句常显、「同步是可选的…」进「说明」折叠、
//     服务器地址收成一行 +「更改…」。⛔ 这支绝不在地址框收着(= 官方地址)时点「创建」。
//  F7 从备份恢复:三步(① 备份文件 ② 备份码 ③ 开始前要知道)、两只框有真 <label>、第 2 / 3 句在折叠「恢复之后会怎样」里。
//  F8 归档册:库里 ≥ 2 块看板时筛选排恒出现、进册恒选当前看板(没有归档就是那句空态)、切「全部看板」挂来处名;
//     册内重载不改选择;只有一块看板的库不出筛选排。
// F2(自动备份钮改名)锚在 zz-backup-auto.e2e.js;F4(删卡片不再先问)锚在 board-revert / kbd-walk165-d1 / critique-desk-b。
// 阴性对照(各拔一处,对应那一例红;读数在回报):F1 拔 inbox.ts / board.ts 的 editHint;F3 把 hotkey-menu.ts 的拒绝支
// 换回不报;F5 拔 filter-bar.ts 的 hideLast / 拖起展开;F6 把 renderCreate 的 noteFold 换回常显段落;F7 把 after 折叠拆回
// 两段常显;F8 把 renderSealed 的 homeId 换回 null。

const P = "取舍F-";
const HINT = "回车或点别处保存 · Esc 不要了";

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
const boards = () => invoke("list_boards");

async function purgeMine() {
  await browser.execute(() => document.querySelectorAll(".undo-toast, .copy-toast").forEach((n) => n.remove()));
  for (const n of [...(await invoke("list_inbox")), ...(await invoke("list_processed"))]) {
    if (!n.content.startsWith(P)) continue;
    await invoke("archive_note", { id: n.id });
    await invoke("purge_note", { id: n.id });
  }
  for (const t of await invoke("list_sealed_tasks")) if (t.title.startsWith(P)) await invoke("unseal_task", { id: t.id });
  for (const t of await invoke("list_tasks")) if (t.title.startsWith(P)) await invoke("archive_task", { id: t.id });
  for (const t of await invoke("list_archived_tasks")) if (t.title.startsWith(P)) await invoke("purge_task", { id: t.id });
  for (const b of await boards()) {
    if (b.deleted || !b.deletable || !b.title.startsWith(P)) continue;
    const r = await tryInvoke("delete_board", { id: b.id });
    if (!r.ok) throw new Error(`收场删看板失败(${b.title}):${r.err}`);
  }
  for (const t of await invoke("list_topics")) if (t.title.startsWith(P)) await invoke("delete_topic", { id: t.id });
  await browser.execute(() => {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith("zhujian.board-current.") || k.startsWith("zhujian.tagrows-open.")) localStorage.removeItem(k);
    }
  });
}

describe("应用评审取舍 · 桌面 F 组", () => {
  before(async () => {
    await goNotebook("inbox");
    await purgeMine();
  });
  after(async () => {
    await goNotebook("inbox");
    await setSize(1260, 780);
    await purgeMine();
  });

  // ---------------------------------------------------------------- F1
  it("F1:随记编辑态框下一行「回车或点别处保存 · Esc 不要了」;改过按一次 Esc ⇒ 红字那句出来、这行让位", async () => {
    await clearInbox();
    await invoke("capture_note", { content: `${P}编辑提示` });
    await inboxShow("ideas");
    await $(`.note*=${P}编辑提示`).waitForExist({ timeout: 8000 });
    await inboxAction(`${P}编辑提示`, "编辑");
    await $(".note .edit-area").waitForExist({ timeout: 5000 });
    const g = await browser.execute(() => {
      const h = document.querySelector(".note.editing .edit-hint");
      const a = document.querySelector(".note.editing .edit-area");
      if (!h) return null;
      const cs = getComputedStyle(h);
      const soft = getComputedStyle(document.documentElement).getPropertyValue("--ink-soft").trim();
      const probe = document.createElement("span");
      probe.style.color = soft;
      document.body.append(probe);
      const softRgb = getComputedStyle(probe).color;
      probe.remove();
      return {
        text: h.textContent,
        shown: h.offsetParent !== null,
        below: h.getBoundingClientRect().top >= a.getBoundingClientRect().bottom,
        size: cs.fontSize,
        soft: cs.color === softRgb,
        n: document.querySelectorAll(".note.editing .edit-hint").length,
      };
    });
    expect(g).toEqual({ text: HINT, shown: true, below: true, size: "12px", soft: true, n: 1 });
    // 改一个字、按一次 Esc:红字那句出来(它里面已经有「回车或点别处保存」),淡字那行让位、不叠两行
    await browser.execute(() => {
      const a = document.querySelector(".note.editing .edit-area");
      a.value += "改";
      a.dispatchEvent(new Event("input", { bubbles: true }));
      a.focus();
    });
    await esc();
    const armed = await browser.execute(() => ({
      discard: document.querySelector(".note.editing .discard-hint")?.hidden,
      hint: document.querySelector(".note.editing .edit-hint").offsetParent !== null,
    }));
    expect(armed).toEqual({ discard: false, hint: false });
    await esc(); // 再按 = 丢
    await $(".note .edit-area").waitForExist({ timeout: 5000, reverse: true });
    expect((await invoke("list_inbox")).some((n) => n.content === `${P}编辑提示`)).toBe(true); // 没存成「…改」
  });

  it("F1:看板卡片就地编辑态同一句;放大面板里不显这句(那里是 Ctrl+Enter 那句)", async () => {
    await invoke("create_task", { title: `${P}卡片编辑提示` });
    await goNotebook("board");
    await $(`.tcard*=${P}卡片编辑提示`).waitForExist({ timeout: 8000 });
    await boardAction(`${P}卡片编辑提示`, "编辑");
    await $(".tcard .edit-input").waitForExist({ timeout: 5000 });
    const g = await browser.execute(() => {
      const h = document.querySelector(".tcard .edit-form .edit-hint");
      const a = document.querySelector(".tcard .edit-input");
      return h ? { text: h.textContent, shown: h.offsetParent !== null, below: h.getBoundingClientRect().top >= a.getBoundingClientRect().bottom, size: getComputedStyle(h).fontSize } : null;
    });
    expect(g).toEqual({ text: HINT, shown: true, below: true, size: "12px" });
    await browser.execute(() => document.querySelector(".tcard .edit-zoom").click());
    await $(".ze-overlay").waitForExist({ timeout: 5000 });
    const z = await browser.execute(() => ({
      inPanel: document.querySelector(".ze-panel .edit-form .edit-hint").offsetParent !== null,
      panelHint: document.querySelector(".ze-panel > .ze-hint").textContent,
    }));
    expect(z).toEqual({ inPanel: false, panelHint: "Ctrl+Enter 保存 · Esc 不要了" });
    await esc(); // 没改:一下就收
    await $(".ze-overlay").waitForExist({ timeout: 5000, reverse: true });
  });

  // ---------------------------------------------------------------- F3
  it("F3:复制失败带原因 —— 钮上闪短的 + 屏底全句;菜单行里闪短的 + 全句;单键 C 直接全句", async () => {
    await clearInbox();
    await invoke("capture_note", { content: `${P}复制失败` });
    await inboxShow("ideas");
    await $(`.note*=${P}复制失败`).waitForExist({ timeout: 8000 });
    const FULL = "复制失败:Error: 这次不让写";
    const toasts = () => browser.execute(() => [...document.querySelectorAll(".copy-toast")].map((n) => n.textContent));
    const waitFull = async (why) => {
      try {
        await browser.waitUntil(async () => (await toasts()).includes(FULL), { timeout: 5000 });
      } catch {
        throw new Error(`${why}:屏底没有全句。在场的回执:${JSON.stringify(await toasts())}`);
      }
    };
    const clearToasts = () => browser.execute(() => document.querySelectorAll(".copy-toast").forEach((n) => n.remove()));
    await browser.execute(() => {
      navigator.clipboard.writeText = () => Promise.reject(new Error("这次不让写"));
    });
    // ① 钮(顶栏「复制随记」):钮上是短的,全句在屏底
    await browser.execute(() => document.querySelector("#inbox-copy-slot .hbtn").click());
    await browser.waitUntil(async () => (await browser.execute(() => document.querySelector("#inbox-copy-slot .hbtn").textContent)) === "复制失败", {
      timeout: 5000,
      interval: 100, // 钮上那句 1.2 秒后就还原
      timeoutMsg: "钮上没闪「复制失败」",
    });
    await waitFull("点钮");
    await clearToasts();
    // ② ⋯ 菜单里点「复制」:那一行闪短的,全句在屏底
    await inboxAction(`${P}复制失败`, "复制");
    await browser.waitUntil(async () => (await browser.execute(() => [...document.querySelectorAll(".hk-menu .hk-label")].some((l) => l.textContent === "复制失败"))) === true, {
      timeout: 5000,
      interval: 50, // 闪 0.9 秒菜单就收
      timeoutMsg: "菜单行里没闪「复制失败」",
    });
    await waitFull("菜单");
    await browser.waitUntil(async () => !(await $(".hk-menu").isExisting()), { timeout: 5000, timeoutMsg: "闪完菜单没收" });
    await clearToasts();
    // ③ 单键 C(菜单没开):直接全句
    await browser.execute((t) => {
      const c = [...document.querySelectorAll(".note")].find((n) => n.textContent.includes(t));
      c.querySelector(".hk-btn").focus();
    }, `${P}复制失败`);
    await browser.keys("c");
    await waitFull("单键 C");
    expect(await toasts()).not.toContain("复制失败"); // 没有另出一条光秃秃的
    await clearToasts();
  });

  // ---------------------------------------------------------------- F5
  describe("F5 标签筛选条两行折叠", () => {
    // ⚠ 标签名用拉丁字母 + 数字:Linux runner 上汉字窄一半(e2e.md),「放不下」要靠不随字体变的宽度。
    // 40 枚 × 每枚约 150px ≈ 6000px,筛选行宽不到 1100 ⇒ 至少五六行,余量足够。
    const N = 40;
    const tagName = (i) => `${P}tag-${String(i).padStart(2, "0")}-abcdefgh`;
    const bar = "#idea-topic-filter";
    const st = () =>
      browser.execute((sel) => {
        const b = document.querySelector(sel);
        const more = b.parentElement.querySelector(".tf-more");
        let rows = 0;
        let prev = Infinity;
        for (const c of b.children) {
          if (c.offsetParent === null) continue;
          if (c.offsetLeft <= prev) rows += 1;
          prev = c.offsetLeft;
        }
        return {
          rows,
          folded: b.querySelectorAll(".tf-pill[data-fold]").length,
          pills: b.querySelectorAll(".tf-pill[data-topic-id]").length,
          moreInBar: !!b.querySelector(".tf-more"),
          moreHidden: more ? more.hidden : null,
          moreText: more ? more.textContent : null,
          expanded: more ? more.getAttribute("aria-expanded") : null,
          controls: more ? more.getAttribute("aria-controls") : null,
          isButton: more ? more.tagName === "BUTTON" : null,
          stored: localStorage.getItem("zhujian.tagrows-open.inbox"),
          storedBoard: localStorage.getItem("zhujian.tagrows-open.board"),
          activeShown: [...b.querySelectorAll(".tf-pill.active")].map((p) => p.offsetParent !== null),
        };
      }, bar);
    const waitSt = async (pred, msg) => {
      try {
        await browser.waitUntil(async () => pred(await st()), { timeout: 6000 });
      } catch {
        throw new Error(`${msg}\n  现场:${JSON.stringify(await st())}`);
      }
    };
    const clickMore = () => browser.execute((sel) => document.querySelector(sel).parentElement.querySelector(".tf-more").click(), bar);

    before(async () => {
      await clearInbox();
      for (let i = 0; i < N; i++) {
        const tid = await invoke("create_topic", { title: tagName(i) });
        const nid = await invoke("capture_note", { content: `${P}带标签 ${i}` });
        await invoke("file_note_to_topic", { id: nid, topicId: tid, newTitle: null });
      }
      await browser.execute(() => localStorage.removeItem("zhujian.tagrows-open.inbox"));
      await inboxShow("ideas");
      await $(`${bar} .tf-pill[data-topic-id]`).waitForExist({ timeout: 10000 });
    });

    it("默认只显示两行,行尾「更多 N ▾」;N = 收起的枚数;钮在标签行外面、是真按钮", async () => {
      await waitSt((s) => s.moreHidden === false && s.rows <= 2, "默认没折到两行以内");
      const s = await st();
      expect(s.pills).toBeGreaterThanOrEqual(N);
      expect(s.folded).toBeGreaterThan(N / 2); // 真的收起了一大半(前置自证:不是「本来就放得下」)
      expect(s.moreText).toBe(`更多 ${s.folded}▾`);
      expect({ moreInBar: s.moreInBar, isButton: s.isButton, expanded: s.expanded, controls: s.controls }).toEqual({
        moreInBar: false,
        isButton: true,
        expanded: "false",
        controls: "idea-topic-filter",
      });
      expect(s.stored).toBe(null); // 默认态不写存储
    });

    it("点开 ⇒ 全部显示、钮变「收起 ▴」、记住;筛着排在折叠区的那枚再收起 ⇒ 它留在可见行", async () => {
      await clickMore();
      await waitSt((s) => s.expanded === "true" && s.folded === 0, "点「更多」没展开");
      let s = await st();
      expect(s.moreText).toBe("收起▴");
      expect(s.rows).toBeGreaterThan(2);
      expect({ stored: s.stored, storedBoard: s.storedBoard }).toEqual({ stored: "1", storedBoard: null }); // 按视图记:看板那一枚没动
      // 筛最后一枚(默认态下它在折叠区)
      await browser.execute(
        (sel, name) => [...document.querySelectorAll(`${sel} .tf-pill`)].find((p) => p.textContent.includes(name)).click(),
        bar,
        tagName(N - 1),
      );
      await waitSt((s2) => s2.activeShown.length === 1 && s2.expanded === "true", "筛了一枚之后展开态丢了");
      await clickMore();
      await waitSt((s2) => s2.expanded === "false" && s2.folded > 0, "点「收起」没收起");
      s = await st();
      expect(s.activeShown).toEqual([true]); // 选中的不藏
      expect(s.rows).toBeLessThanOrEqual(2);
      expect(s.stored).toBe("0");
      // 清筛选(点「所有」)
      await browser.execute((sel) => document.querySelector(`${sel} .tf-pill`).click(), bar);
      await waitSt((s2) => s2.activeShown.length === 1 && s2.folded > 0, "清筛选后没回到收起态");
    });

    it("重新进这一页:展开 / 收起照上次的来", async () => {
      await browser.execute(() => localStorage.setItem("zhujian.tagrows-open.inbox", "1"));
      await inboxShow("ideas");
      await $(`${bar} .tf-pill[data-topic-id]`).waitForExist({ timeout: 10000 });
      await waitSt((s) => s.expanded === "true" && s.folded === 0, "记着「展开」,重进后却是收起的");
      await browser.execute(() => localStorage.setItem("zhujian.tagrows-open.inbox", "0"));
      await inboxShow("ideas");
      await $(`${bar} .tf-pill[data-topic-id]`).waitForExist({ timeout: 10000 });
      await waitSt((s) => s.expanded === "false" && s.folded > 0 && s.rows <= 2, "记着「收起」,重进后却没折");
    });

    it("窗口变窄 ⇒ 重算(收起的更多、仍不过两行);变回来 ⇒ 数也回来", async () => {
      const wide = (await st()).folded;
      await setSize(900, 780);
      await waitSt((s) => s.folded > wide && s.rows <= 2, "窗口变窄后没重算");
      await setSize(1260, 780);
      await waitSt((s) => s.folded === wide && s.rows <= 2, "窗口变回来后没重算");
    });

    it("把一张随记拖起来 ⇒ 自动展开(收起的标签才接得到);松手 ⇒ 还原,且不改记住的那一档", async () => {
      await browser.execute((t) => {
        const card = [...document.querySelectorAll(".note")].find((c) => c.textContent.includes(t));
        window.__f5dt = new DataTransfer();
        card.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: window.__f5dt }));
      }, `${P}带标签 0`);
      await waitSt((s) => s.expanded === "true" && s.folded === 0, "拖起卡片后标签行没自动展开");
      expect((await st()).stored).toBe("0");
      await browser.execute((t) => {
        const card = [...document.querySelectorAll(".note")].find((c) => c.textContent.includes(t));
        card.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: window.__f5dt }));
      }, `${P}带标签 0`);
      await waitSt((s) => s.expanded === "false" && s.folded > 0, "松手后标签行没还原成收起");
      expect((await st()).stored).toBe("0");
    });

    it("不满两行 ⇒ 不出这枚钮(看板页:只有两枚标签在用)", async () => {
      const topics = await invoke("list_topics");
      const t0 = topics.find((t) => t.title === tagName(0)).id;
      const t1 = topics.find((t) => t.title === tagName(1)).id;
      const a = await invoke("create_task", { title: `${P}看板带标签甲` });
      const b = await invoke("create_task", { title: `${P}看板带标签乙` });
      await invoke("add_task_topic", { id: a, topicId: t0 });
      await invoke("add_task_topic", { id: b, topicId: t1 });
      await goNotebook("board");
      await $("#topic-filter .tf-pill[data-topic-id]").waitForExist({ timeout: 10000 });
      const s = await browser.execute(() => {
        const b2 = document.querySelector("#topic-filter");
        const more = b2.parentElement.querySelector(".tf-more");
        return { exists: !!more, hidden: more?.hidden, folded: b2.querySelectorAll("[data-fold]").length, shown: more ? more.offsetParent !== null : null };
      });
      expect(s).toEqual({ exists: true, hidden: true, folded: 0, shown: false });
    });
  });

  // ---------------------------------------------------------------- F6
  it("F6:同步第一屏 —— 「创建账户」是唯一主钮,加入是一行淡字链接(整句可点、是真按钮)", async () => {
    await goNotebook("inbox");
    expect((await invoke("sync_status")).configured).toBe(false); // 前置:未配置态才有这两屏
    await browser.execute(() => {
      localStorage.removeItem("zhujian.last-server");
      document.getElementById("sync-entry").click();
    });
    await $(".sync-panel").waitForExist({ timeout: 5000 });
    const g = await browser.execute(() => {
      const prim = [...document.querySelectorAll(".sync-panel .hbtn.primary")];
      const link = document.querySelector(".sync-panel .sync-join-link");
      const create = prim[0];
      return {
        primary: prim.map((b) => b.textContent),
        link: link ? { tag: link.tagName, text: link.textContent, isHbtn: link.classList.contains("hbtn"), below: link.getBoundingClientRect().top >= create.getBoundingClientRect().bottom } : null,
        plainJoin: [...document.querySelectorAll(".sync-panel .hbtn")].some((b) => b.textContent === "用配对码加入"),
      };
    });
    expect(g).toEqual({
      primary: ["创建账户(第一台设备)"],
      link: { tag: "BUTTON", text: "已有账户?用配对码加入", isHbtn: false, below: true },
      plainJoin: false,
    });
    await browser.execute(() => document.querySelector(".sync-panel .sync-join-link").click());
    await browser.waitUntil(async () => (await $$(".sync-panel .sync-input")).length === 2, { timeout: 5000, timeoutMsg: "点那行链接没进「用配对码加入」页" });
    await esc(); // 回首页
    await browser.waitUntil(async () => (await $$(".sync-panel .sync-input")).length === 0, { timeout: 5000 });
  });

  it("F6:创建屏 —— 两句常显、「同步是可选的…」在「说明」折叠里、地址收成一行 +「更改…」,点了才摊开;「创建」是主钮", async () => {
    // 接着上一例:浮层开着、在首页;预填 = 官方地址(上一例清过 last-server)
    await browser.execute(() => [...document.querySelectorAll(".sync-panel .hbtn.primary")].find((b) => b.textContent.startsWith("创建账户")).click());
    await $(".sync-panel .sync-server-line").waitForExist({ timeout: 5000 });
    const g = await browser.execute(() => {
      const body = document.querySelector(".sync-panel .sync-body");
      const notes = [...body.querySelectorAll(":scope > .sync-note")].map((p) => p.textContent);
      const fold = body.querySelector(":scope > details.settings-notes");
      const line = body.querySelector(".sync-server-line");
      const acts = [...body.querySelectorAll(".sync-actions button")].map((b) => ({ t: b.textContent, primary: b.classList.contains("primary") }));
      return {
        notes,
        fold: fold ? { open: fold.open, summary: fold.querySelector("summary").textContent, text: [...fold.querySelectorAll("p")].map((p) => p.textContent).join("") } : null,
        line: line.querySelector("span").textContent,
        change: { tag: line.querySelector(".sync-server-change").tagName, text: line.querySelector(".sync-server-change").textContent },
        inputs: body.querySelectorAll("input").length,
        acts,
      };
    });
    expect(g.notes).toEqual([
      "把本机创建为账户的第一台设备,其他设备之后配对加入。",
      "账户的钥匙只在你的设备上,服务器没有:这台丢了又没有别的设备和备份,账户就回不来。",
    ]);
    expect(g.fold.open).toBe(false);
    expect(g.fold.summary).toBe("说明");
    expect(g.fold.text).toMatch(/^同步是可选的:不开,记的东西只存在这台电脑上。/); // 一句没删,只是收着
    expect(g.line).toBe("服务器:官方(sync.zhujian.app)");
    expect(g.change).toEqual({ tag: "BUTTON", text: "更改…" });
    expect(g.inputs).toBe(0);
    expect(g.acts).toEqual([
      { t: "创建", primary: true },
      { t: "返回", primary: false },
    ]);
    // 点「更改…」:原来那一组回来(标签 + 框 + 框下那句),焦点进框,那一行收走
    await browser.execute(() => document.querySelector(".sync-panel .sync-server-change").click());
    await $(".sync-panel .sync-input").waitForExist({ timeout: 5000 });
    const f = await browser.execute(() => ({
      label: document.querySelector(".sync-panel .sync-label").textContent,
      value: document.querySelector(".sync-panel .sync-input").value,
      hint: document.querySelector(".sync-panel .sync-hint").textContent,
      focused: document.activeElement === document.querySelector(".sync-panel .sync-input"),
      line: !!document.querySelector(".sync-panel .sync-server-line"),
    }));
    expect(f).toEqual({
      label: "服务器地址",
      value: "wss://sync.zhujian.app",
      hint: "官方服务器,一般不用改;自建的填你自己的(那是另一套账户)。",
      focused: true,
      line: false,
    });
    // ⛔ 不点「创建」(框里是官方地址)。两下 Esc:回首页、关浮层。
    await esc();
    await esc();
    await $(".sync-panel").waitForExist({ timeout: 5000, reverse: true });
    expect((await invoke("sync_status")).configured).toBe(false);
  });

  // ---------------------------------------------------------------- F7
  it("F7:从备份恢复 —— 三步;两只框有真 <label>;第 4 / 1 句常显,第 2 / 3 句在「恢复之后会怎样」里;四句都在「开始恢复」之前", async () => {
    await goNotebook("inbox");
    await browser.execute(() => document.getElementById("settings-entry").click());
    await $(".settings-panel").waitForExist({ timeout: 5000 });
    await browser.execute(() => document.querySelector('.settings-cat[data-cat="backup"]').click());
    await $(".bkup-body").waitForExist({ timeout: 5000 });
    await browser.execute(() => {
      const b = [...document.querySelectorAll(".settings-pane[data-cat='backup'] button")].find((x) => x.textContent.trim() === "恢复…");
      b.click();
    });
    await $(".bkup-restore input").waitForExist({ timeout: 5000 });
    const g = await browser.execute(() => {
      const form = document.querySelector(".bkup-restore");
      const kids = [...form.children].map((n) => {
        if (n.classList.contains("bkup-step")) return `${n.tagName}:${n.textContent}`;
        if (n.tagName === "DETAILS") return `DETAILS:${n.querySelector("summary").textContent}`;
        if (n.classList.contains("bkup-file-row")) return "FILEROW";
        if (n.tagName === "INPUT") return "CODE";
        if (n.classList.contains("bkup-acts")) return `ACTS:${n.textContent.trim()}`;
        if (n.classList.contains("bkup-out")) return "OUT";
        return `${n.tagName}.${n.classList.contains("err") ? "err" : "sub"}:${n.textContent.slice(0, 8)}`;
      });
      const file = document.getElementById("bkup-restore-file");
      const code = document.getElementById("bkup-restore-code");
      const after = form.querySelector("details.bkup-after");
      const shown = (s) => [...form.querySelectorAll("p")].some((p) => p.textContent.includes(s) && p.offsetParent !== null && p.getClientRects().length > 0 && (p.closest("details")?.open ?? true));
      return {
        kids,
        fileLabel: [...file.labels].map((l) => l.textContent),
        codeLabel: [...code.labels].map((l) => l.textContent),
        afterOpen: after.open,
        afterText: [...after.querySelectorAll("p")].map((p) => p.textContent.slice(0, 10)),
        lead4: shown("跑起来之后不能取消"),
        lead1: shown("恢复绝不覆盖任何现有数据"),
        lead2: shown("恢复出来的空间不同步"),
        lead3: shown("恢复回来的是备份那一刻的数据"),
      };
    });
    expect(g.kids).toEqual([
      "LABEL:① 备份文件",
      "FILEROW",
      "P.sub:上面「已有备份」",
      "LABEL:② 备份码",
      "CODE",
      "P.sub:每台设备各一串;",
      "P:③ 开始前要知道",
      "P.err:跑起来之后不能取",
      "P.sub:恢复绝不覆盖任何",
      "DETAILS:恢复之后会怎样",
      "ACTS:开始恢复",
      "OUT",
    ]);
    expect(g.fileLabel).toEqual(["① 备份文件"]);
    expect(g.codeLabel).toEqual(["② 备份码"]);
    expect(g.afterOpen).toBe(false);
    expect(g.afterText).toEqual(["恢复出来的空间不同步", "恢复回来的是备份那一"]);
    expect({ lead4: g.lead4, lead1: g.lead1, lead2: g.lead2, lead3: g.lead3 }).toEqual({ lead4: true, lead1: true, lead2: false, lead3: false });
    // 点开折叠:那两句读得到
    await browser.execute(() => document.querySelector(".bkup-restore details.bkup-after summary").click());
    expect(await browser.execute(() => document.querySelector(".bkup-restore details.bkup-after").open)).toBe(true);
    // 点标签 = 焦点进它那只框(真 label 的行为)
    await browser.execute(() => document.querySelector("label[for='bkup-restore-code']").click());
    expect(await browser.execute(() => document.activeElement.id)).toBe("bkup-restore-code");
    await browser.execute(() => document.querySelector(".settings-overlay").dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    await $(".settings-overlay").waitForExist({ timeout: 5000, reverse: true });
  });

  // ---------------------------------------------------------------- F8
  describe("F8 归档册的看板筛选排", () => {
    const FLOW = `${P}周报`;
    const A1 = `${P}任务归档一`;
    const A2 = `${P}任务归档二`;
    const sealed = () =>
      browser.execute(() => ({
        pills: [...document.querySelectorAll(".sealed-boards .tf-pill")].map((p) => p.textContent.trim()),
        active: [...document.querySelectorAll(".sealed-boards .tf-pill.active")].map((p) => p.textContent.trim()),
        cards: [...document.querySelectorAll(".sealed-view .tcard")].map((c) => ({
          title: (c.querySelector(".ttitle")?.textContent ?? "").trim(),
          from: c.querySelector(".board-tag")?.textContent ?? null,
        })),
        none: document.querySelector(".sealed-view .sealed-none")?.textContent ?? null,
        stats: document.querySelector(".sealed-view .sealed-stats")?.textContent ?? null,
        centered: document.querySelector("#board.centered .big")?.textContent ?? null,
      }));
    const waitSealed = async (pred, msg) => {
      try {
        await browser.waitUntil(async () => pred(await sealed()), { timeout: 8000 });
      } catch {
        throw new Error(`${msg}\n  现场:${JSON.stringify(await sealed())}`);
      }
    };
    const pick = (name) => browser.execute((n) => [...document.querySelectorAll(".sealed-boards .tf-pill")].find((p) => p.textContent.trim() === n).click(), name);
    const navClick = async (name) => {
      await browser.execute((n) => {
        const b = [...document.querySelectorAll("#board-nav .bn-item")].find((x) => x.querySelector(".bn-name").textContent.trim() === n);
        if (!b) throw new Error(`侧栏没有看板「${n}」`);
        b.click();
      }, name);
      await browser.waitUntil(async () => (await browser.execute(() => document.querySelector(".v-board header h1")?.textContent)) === name, {
        timeout: 8000,
        timeoutMsg: `页头没换成「${name}」`,
      });
    };
    const toggleSealed = () => browser.execute(() => document.querySelector("#seal-toggle").click());
    const seal = async (title) => {
      const id = await invoke("create_task", { title });
      await invoke("update_task_status", { id, to: "done" });
      await invoke("seal_task", { id });
      return id;
    };
    let a2;

    before(async () => {
      // 前置自证:此刻库里只有种子看板一块活的,且别的 spec 没留下归档(否则「只有一块看板」那一例量的不是它)
      const live = (await boards()).filter((b) => !b.deleted);
      if (live.length !== 1) throw new Error(`前置不成立:活看板不止一块(${live.map((b) => b.title).join(" / ")})—— 前面的 spec 没收干净`);
      await browser.execute(() => {
        for (const k of Object.keys(localStorage)) if (k.startsWith("zhujian.board-current.")) localStorage.removeItem(k);
      });
      await seal(A1);
      a2 = await seal(A2);
    });

    it("只有一块看板的库:归档册照旧不出筛选排、卡上不挂来处名", async () => {
      await goNotebook("board");
      await $("#seal-toggle").waitForExist({ timeout: 8000 });
      await toggleSealed();
      await waitSealed((s) => s.cards.some((c) => c.title === A1), "归档册没画出来");
      const s = await sealed();
      expect(s.pills).toEqual([]);
      expect(s.cards.filter((c) => c.title.startsWith(P)).map((c) => c.from)).toEqual([null, null]);
      await toggleSealed();
    });

    it("两块看板:从没有归档的那块进册 ⇒ 筛选排在、选的是它、说「这块看板还没有归档的卡片」;切「全部看板」⇒ 卡出来、挂来处名", async () => {
      await invoke("create_board", { title: FLOW, columns: ["待处理", "进行中", "已完成"], doneIndex: 2 });
      await goNotebook("board");
      await navClick(FLOW);
      await toggleSealed();
      await waitSealed((s) => s.pills.length > 0, "两块看板了,归档册却没有筛选排");
      let s = await sealed();
      expect(s.pills).toEqual(["全部看板", "任务", FLOW]); // 当前看板恒在,哪怕它一张归档都没有
      expect(s.active).toEqual([FLOW]);
      expect(s.cards).toEqual([]);
      expect(s.none).toBe("这块看板还没有归档的卡片");
      expect(s.stats).toContain("累计 0"); // 统计跟着筛选走
      await pick("全部看板");
      await waitSealed((x) => x.active[0] === "全部看板" && x.cards.length >= 2, "切「全部看板」后卡没出来");
      s = await sealed();
      expect(s.cards.filter((c) => c.title.startsWith(P)).map((c) => c.from)).toEqual(["任务", "任务"]);
      // 筛着单块看板时也挂来处名(同手机)
      await pick("任务");
      await waitSealed((x) => x.active[0] === "任务" && x.cards.length >= 2, "筛「任务」后卡没出来");
      expect((await sealed()).cards.filter((c) => c.title.startsWith(P)).map((c) => c.from)).toEqual(["任务", "任务"]);
    });

    it("册内重载(取消归档一张)不改当前选择;退出再进 ⇒ 又是当前看板", async () => {
      // 接着上一例:在周报看板的归档册里,筛着「任务」
      expect(typeof a2).toBe("string");
      await boardAction(A2, "取消归档"); // 走卡上的 ⋯:做完册子自己重载
      await waitSealed((s) => !s.cards.some((c) => c.title === A2), "取消归档后册子没重载");
      expect((await sealed()).active).toEqual(["任务"]); // 没被拉回「周报」
      await toggleSealed(); // 回看板
      await browser.waitUntil(async () => !(await $(".sealed-view").isExisting()), { timeout: 8000 });
      await toggleSealed(); // 再进
      await waitSealed((s) => s.pills.length > 0, "再进归档册没画出来");
      expect((await sealed()).active).toEqual([FLOW]);
    });

    it("整本都空的多看板库:筛选排照出;「全部看板」上说整本那句", async () => {
      for (const t of await invoke("list_sealed_tasks")) if (t.title.startsWith(P)) await invoke("unseal_task", { id: t.id });
      const others = (await invoke("list_sealed_tasks")).length;
      if (others > 0) return; // 别的 spec 留了归档:这一格量不了(不是本例的事),前三例已经守住主体
      for (const t of await invoke("list_tasks")) if (t.title.startsWith(P)) await invoke("archive_task", { id: t.id }); // 完成列里那几张也清掉(它们算「有内容」)
      await goNotebook("board");
      await navClick(FLOW);
      await browser.keys("g"); // 0 张归档:钮可能不显,G 照开
      await waitSealed((s) => s.pills.length > 0, "整本都空时筛选排没出");
      let s = await sealed();
      expect(s.pills[0]).toBe("全部看板");
      expect(s.pills).toContain(FLOW); // 别的 spec 在种子看板完成列里留了卡的话,「任务」也会在(它算有内容),不钉全等
      expect(s.active).toEqual([FLOW]);
      expect(s.none).toBe("这块看板还没有归档的卡片");
      await pick("全部看板");
      await waitSealed((x) => x.active[0] === "全部看板", "没切到「全部看板」");
      s = await sealed();
      expect(s.none).toBe("还没有归档的卡片");
      await browser.keys("g");
    });
  });
});

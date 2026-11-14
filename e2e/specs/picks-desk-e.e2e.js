import { browser, $, $$, expect } from "@wdio/globals";
import { boardMore, clearInbox, goNotebook, goShow, inboxAction, inboxShow, invoke, toLightbox, typeText } from "./support.js";

// 应用评审取舍题 · 桌面 E 组(用户 2026-11-13 拍的那几条里能自动化的):
//  E1 宽屏上随记内容区有阅读宽度(页头 / 筛选条通栏);默认窗宽 1260 下不咬(侧栏收起也不咬);
//  E2 侧栏收起后同步入口是一枚图标 + 角标(状态点还是那一枚、类名不变),展开态图标不显;
//  E3 管理看板里「这块看板」那几行被拒时,红字紧跟在那一行后面,列清单下那格共用的不亮;
//  E5 纸条里 `/tag 词` 列出名字含这个词的已有标签:↓ + 回车用已有那枚;不选直接回车照旧拿打的字;
//  E6 同步浮层:二级页上 Esc 先回首页、再按才关(备份码那一步的 Esc 在 backup.e2e.js,那里才有没设过备份的库);
//  E7 编辑态点小图看大图、Esc 关掉 ⇒ 焦点回写字框。
// 阴性对照(各拔一处,对应那一例红):E1 拔 inbox.css 的 max-width;E2 拔 notebook.html 折叠态 .sync-ico 的 display:flex;
// E3 把 write() 的 showRowErr 换回 showErr;E5 拔 main.ts 的 argOptions;E6 把 sync.ts 的 escapeOneLevel 换回 closePanel;
// E7 拔 item-images.ts 编辑态那句 refocus。

const P = "取舍E-";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

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
const setCollapsed = async (want) => {
  const is = await browser.execute(() => document.body.classList.contains("sb-collapsed"));
  if (is !== want) await browser.execute(() => document.getElementById("sidebar-toggle").click());
  // 侧栏宽有 0.18s 过渡:等它停在目标宽度上再量
  await browser.waitUntil(async () => Math.abs((await browser.execute(() => document.querySelector(".sidebar").getBoundingClientRect().width)) - (want ? 52 : 172)) <= 1, {
    timeout: 5000,
    timeoutMsg: `侧栏没${want ? "收起" : "展开"}到位:${await browser.execute(() => document.querySelector(".sidebar").getBoundingClientRect().width)}`,
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
  for (const t of await invoke("list_topics")) {
    if (t.title.startsWith(P)) await invoke("delete_topic", { id: t.id });
  }
}

describe("应用评审取舍 · 桌面 E 组", () => {
  before(async () => {
    await goNotebook("inbox");
    await purgeMine();
  });
  after(async () => {
    await goNotebook("inbox");
    await setCollapsed(false);
    await setSize(1260, 700);
    await purgeMine();
  });

  it("E1:宽屏上随记内容区封顶、靠左,页头与筛选条通栏;默认窗宽下不咬(侧栏收起也不咬)", async () => {
    await clearInbox();
    await invoke("capture_note", { content: `${P}宽屏上这一条不该一行拉到底` });
    await inboxShow("ideas");
    await (await $(`.note*=${P}宽屏上这一条不该一行拉到底`)).waitForExist({ timeout: 10000 });
    const read = () =>
      browser.execute(() => {
        const w = (sel) => document.querySelector(sel).getBoundingClientRect();
        const main = document.querySelector(".v-inbox main");
        const cs = getComputedStyle(main);
        return {
          room: main.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
          compose: w(".v-inbox .compose").width,
          timeline: w(".v-inbox .timeline").width,
          left: w(".v-inbox .timeline").left - main.getBoundingClientRect().left,
          header: w(".v-inbox header").width,
          filter: w("#filter-row").width,
          view: w(".v-inbox").width,
        };
      });

    // 默认窗宽:内容区占满可用宽(一个像素不变);侧栏收起后多出来的那一百多像素也照样占满
    await setCollapsed(false);
    await setSize(1260, 700);
    let r = await read();
    expect(r.timeline).toBe(r.room);
    expect(r.compose).toBe(r.room);
    await setCollapsed(true);
    r = await read();
    expect(r.timeline).toBe(r.room);
    await setCollapsed(false);

    // 宽屏:内容区封顶(比可用宽窄得多)、仍贴左;页头与筛选条照旧通栏
    await setSize(1920, 700);
    r = await read();
    expect(r.room).toBeGreaterThan(1600); // 自证:这一态真有那么宽的地方可铺
    expect(r.timeline).toBeLessThanOrEqual(1160);
    expect(r.compose).toBe(r.timeline);
    expect(r.left).toBe(30);
    expect(r.header).toBe(r.view);
    expect(r.filter).toBe(r.view);
    await setSize(1260, 700);
  });

  it("E2:侧栏收起 ⇒ 同步入口是一枚与导航同尺寸的图标,状态点缩到它右下当角标;展开态图标不显、点在原位", async () => {
    await goNotebook("inbox");
    const read = () =>
      browser.execute(() => {
        const R = (n) => n.getBoundingClientRect();
        const entry = document.getElementById("sync-entry");
        const ico = entry.querySelector(".sync-ico");
        const svg = ico.querySelector("svg");
        const dot = document.getElementById("sync-dot");
        const nav = document.querySelector('.sidebar nav button[data-view="inbox"] .nav-ico svg');
        return {
          icoShown: getComputedStyle(ico).display !== "none",
          ico: { w: R(svg).width, h: R(svg).height, cx: R(svg).left + R(svg).width / 2, cy: R(svg).top + R(svg).height / 2 },
          nav: { w: R(nav).width, cx: R(nav).left + R(nav).width / 2 },
          dot: { cx: R(dot).left + R(dot).width / 2, cy: R(dot).top + R(dot).height / 2, pos: getComputedStyle(dot).position, cls: dot.className },
          title: entry.title,
        };
      });
    await setCollapsed(false);
    const open = await read();
    expect(open.icoShown).toBe(false);
    expect(open.dot.pos).toBe("static");

    await setCollapsed(true);
    const shut = await read();
    expect(shut.icoShown).toBe(true);
    expect(shut.ico.w).toBe(shut.nav.w); // 与导航那几枚同尺寸
    expect(Math.abs(shut.ico.cx - shut.nav.cx)).toBeLessThanOrEqual(1); // 同一根竖轴
    // 角标:落在图标右下那一角上(圆心在图标中心的右下、不出图标外框太远)
    expect(shut.dot.cx).toBeGreaterThan(shut.ico.cx);
    expect(shut.dot.cy).toBeGreaterThan(shut.ico.cy);
    expect(shut.dot.cx - shut.ico.cx).toBeLessThanOrEqual(shut.ico.w / 2 + 2);
    expect(shut.dot.cls).toBe(open.dot.cls); // 还是那一枚点、那一套状态类
    expect(shut.title).toBe(open.title); // 悬停提示沿用展开态那一句
    expect(shut.title.length).toBeGreaterThan(0);
    await setCollapsed(false);
  });

  it("E3:管理看板里换「完成列」被拒 ⇒ 红字紧跟在「完成列」那一行后面;列清单下那格共用的不亮;换一行再错只留一句", async () => {
    await goNotebook("board");
    const tid = await invoke("create_task", { title: `${P}占着完成列的一张`, dueOn: null, priority: null, topicId: null });
    const t = (await invoke("list_tasks")).find((x) => x.id === tid);
    await invoke("reorder_task", { id: tid, fromStatus: t.status, toStatus: "done", baseTargetIds: [], orderedIds: [tid] });
    await boardMore("manage-cols");
    await $(".bcm-board").waitForExist({ timeout: 5000 });
    // 「完成列」那一行的第一枚 =「不设」:完成列里有卡 ⇒ core 拒
    await browser.execute(() => document.querySelectorAll(".bcm-board .bcm-role-row")[1].querySelector(".bcm-pill").click());
    await $(".bcm-row-err").waitForExist({ timeout: 5000 });
    const got = await browser.execute(() => {
      const rows = [...document.querySelectorAll(".bcm-board .bcm-role-row")];
      const errs = [...document.querySelectorAll(".bcm-row-err")];
      const shared = document.querySelector(".bcm-panel > .bcm-err");
      return { n: errs.length, afterDoneRow: errs[0].previousElementSibling === rows[1], text: errs[0].textContent, sharedHidden: shared.hidden };
    });
    expect(got.n).toBe(1);
    expect(got.afterDoneRow).toBe(true);
    expect(got.text.length).toBeGreaterThan(0);
    expect(got.sharedHidden).toBe(true);

    // 看板名清空点保存 ⇒ 那句落在「看板名」那一行后面,上一句收掉
    await browser.execute(() => {
      const row = document.querySelectorAll(".bcm-board .bcm-role-row")[2];
      const input = row.querySelector("input");
      input.value = "";
      row.querySelector(".bcm-btn").click();
    });
    const got2 = await browser.execute(() => {
      const rows = [...document.querySelectorAll(".bcm-board .bcm-role-row")];
      const errs = [...document.querySelectorAll(".bcm-row-err")];
      return { n: errs.length, afterNameRow: errs[0]?.previousElementSibling === rows[2] };
    });
    expect(got2).toEqual({ n: 1, afterNameRow: true });

    await esc();
    await $(".bcm-panel").waitForExist({ timeout: 5000, reverse: true });
    await invoke("archive_task", { id: tid });
    await invoke("purge_task", { id: tid });
  });

  describe("E5:纸条里 /tag 先列已有标签", () => {
    const HOME = `${P}家里`;
    const WORD = `${P}家`;
    const rows = () =>
      browser.execute(() => [...document.querySelectorAll("#cap-cmd .cmd-row")].map((n) => ({ t: n.querySelector(".cmd-name").textContent + "|" + n.querySelector(".cmd-label").textContent, hi: n.classList.contains("hi") })));
    const chips = () => browser.execute(() => [...document.querySelectorAll("#cap-mods .cap-chip")].map((c) => c.firstElementChild.textContent));
    const typeTag = async () => {
      const ta = await $("#capture");
      await ta.waitForExist({ timeout: 10000 });
      await ta.click();
      await ta.setValue(`/tag ${WORD}`);
      // 候选名单是开窗后异步取的:等到那一行出现(等不到 = 没列,正是这一例要红的地方)
      await browser.waitUntil(async () => (await rows()).some((r) => r.t === `|#${HOME}`), {
        timeout: 6000,
        timeoutMsg: `打了「/tag ${WORD}」没列出已有的「${HOME}」:${JSON.stringify(await rows())}`,
      });
    };

    before(async () => {
      await goNotebook("inbox");
      await clearInbox();
      await invoke("create_topic", { title: HOME });
      await invoke("create_topic", { title: `${P}不相干` });
    });
    afterEach(async () => {
      // 没记下的修饰(chip)是会留到下一次开窗的草稿:每例收尾清掉
      await browser.execute(() => {
        localStorage.removeItem("zhujian.capture-mods");
        localStorage.removeItem("zhujian.capture-draft");
      });
    });

    it("列出名字含这个词的已有标签(不相干的不列),高亮默认在命令那一行;↓ + 回车 ⇒ 用已有那枚,存下来不新建", async () => {
      await goShow("/index.html");
      await typeTag();
      const r = await rows();
      expect(r.map((x) => x.t)).toEqual(["/tag|打标签", `|#${HOME}`]);
      expect(r.map((x) => x.hi)).toEqual([true, false]);
      await browser.keys(["ArrowDown"]);
      expect((await rows()).map((x) => x.hi)).toEqual([false, true]);
      await browser.keys(["Enter"]);
      await browser.waitUntil(async () => (await chips()).length === 1, { timeout: 4000, timeoutMsg: "回车后没挂上标签 chip" });
      expect(await chips()).toEqual([`#${HOME}`]);
      expect(await browser.execute(() => document.getElementById("capture").value)).toBe("");

      const BODY = `${P}挂到已有的那枚上`;
      await typeText(BODY);
      await browser.keys(["Enter"]);
      await browser.waitUntil(async () => (await invoke("list_ideas")).some((n) => n.content === BODY && n.topics.some((t) => t.title === HOME)), {
        timeout: 8000,
        timeoutMsg: "那一条没带着已有的那枚标签入库",
      });
      const titles = (await invoke("list_topics")).map((t) => t.title).filter((t) => t.startsWith(P));
      expect(titles.sort()).toEqual([`${P}不相干`, HOME].sort()); // 没有新建「取舍E-家」
    });

    it("不选、直接回车 ⇒ 照旧拿打的那几个字(chip 是打的词);点候选那一行同样用已有那枚", async () => {
      await goShow("/index.html");
      await typeTag();
      await browser.keys(["Enter"]);
      await browser.waitUntil(async () => (await chips()).length === 1, { timeout: 4000, timeoutMsg: "回车后没挂上标签 chip" });
      expect(await chips()).toEqual([`#${WORD}`]);

      // 再来一枚:这回用鼠标点候选(mousedown,焦点不离开写字框)
      await typeTag();
      await browser.execute(() => {
        const row = [...document.querySelectorAll("#cap-cmd .cmd-opt")][0];
        row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      });
      await browser.waitUntil(async () => (await chips()).length === 2, { timeout: 4000, timeoutMsg: "点候选没挂上第二枚 chip" });
      expect(await chips()).toEqual([`#${WORD}`, `#${HOME}`]);
      expect(await browser.execute(() => document.activeElement.id)).toBe("capture");
      // 已挂上的那枚不再列
      const ta = await $("#capture");
      await ta.setValue(`/tag ${WORD}`);
      await browser.waitUntil(async () => (await rows()).length >= 1, { timeout: 4000 });
      expect((await rows()).map((x) => x.t)).toEqual(["/tag|打标签"]);
      // ⚠ 别写 setValue(""):WebKitGTK 的驱动拒空串(Missing text parameter,903 公开 CI 实红);清场走页内。
      await browser.execute(() => {
        const c = document.querySelector("#capture");
        c.value = "";
        c.dispatchEvent(new Event("input", { bubbles: true }));
      });
    });
  });

  it("E6:同步浮层在「创建账户」/「用配对码加入」页上按 Esc ⇒ 先回首页、浮层还在;首页上再按才关,焦点回侧栏那枚钮", async () => {
    await goNotebook("inbox");
    const clickIn = (label) =>
      browser.execute((l) => {
        const b = [...document.querySelectorAll(".sync-panel button")].find((n) => n.textContent.includes(l));
        if (!b) throw new Error("同步浮层里没有按钮:" + l);
        b.click();
      }, label);
    // 二级页的记号:左上那枚「‹ 返回」(909 E10;首页没有)。创建账户页的地址框默认收着(F 组 F6),不能再拿输入框个数认页。
    const onSub = () => browser.execute(() => !!document.querySelector(".sync-panel .sync-back"));
    for (const entry of ["创建账户", "用配对码加入"]) {
      await (await $("#sync-entry")).click();
      await $(".sync-panel").waitForExist({ timeout: 5000 });
      await clickIn(entry);
      await browser.waitUntil(onSub, { timeout: 5000, timeoutMsg: `没进「${entry}」那一页` });
      // 焦点在这一页的第一个控件上(换页落第一个控件):Esc 从它身上发
      await esc();
      await browser.waitUntil(async () => !(await onSub()), { timeout: 5000, timeoutMsg: `「${entry}」页上按 Esc 没回首页` });
      expect(await $(".sync-panel").isExisting()).toBe(true);
      expect(await (await $(".sync-panel")).getText()).toContain("创建账户"); // 首页那两枚入口又在了
      expect(await browser.execute(() => document.querySelector(".sync-panel").contains(document.activeElement))).toBe(true);
      await esc();
      await $(".sync-panel").waitForExist({ timeout: 5000, reverse: true });
      expect(await browser.execute(() => document.activeElement.id)).toBe("sync-entry");
    }
  });

  it("E7:编辑态点小图看大图、Esc 关掉 ⇒ 焦点回写字框,光标还在原处", async () => {
    await goNotebook("inbox");
    await clearInbox();
    const BODY = `${P}编辑着看大图`;
    const id = await invoke("capture_note", { content: BODY });
    await invoke("add_item_image", { itemId: id, mime: "image/png", dataB64: PNG });
    await inboxShow("ideas");
    const card = await $(`.note*=${BODY}`);
    await card.waitForExist({ timeout: 10000 });
    await inboxAction(BODY, "编辑");
    const area = await card.$(".edit-area");
    await area.waitForExist({ timeout: 5000 });
    await area.click();
    await browser.execute(() => {
      const a = document.querySelector(".note .edit-area");
      a.focus();
      a.setSelectionRange(3, 3);
    });
    const thumb = await card.$(".img-editor .img-thumb-img");
    await thumb.waitForExist({ timeout: 10000 });
    await thumb.click();
    const back = await toLightbox();
    await (await $(".img-lightbox")).waitForExist({ timeout: 10000 });
    await browser.keys(["Escape"]);
    await browser.waitUntil(async () => !(await $(".img-lightbox").isExisting()), { timeout: 10000, timeoutMsg: "Esc 没关掉大图" });
    await back();
    const f = await browser.execute(() => {
      const a = document.activeElement;
      return { area: a.classList.contains("edit-area"), caret: a.selectionStart };
    });
    expect(f).toEqual({ area: true, caret: 3 });
    expect(await card.$(".edit-area").isExisting()).toBe(true); // 编辑态还开着
    // 收尾:没改字,Esc 一下退出编辑态
    await browser.keys(["Escape"]);
    await card.$(".edit-area").waitForExist({ timeout: 5000, reverse: true });
  });
});

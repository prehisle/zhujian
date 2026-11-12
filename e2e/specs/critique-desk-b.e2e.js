import { browser, $, expect } from "@wdio/globals";
import { boardMore, goNotebook, invoke } from "./support.js";

// 应用评审修复 · 桌面 B 组(看板页头收纳 / 设置通用页重排 / 切视图键 / 长文历史「复制这一版」/ 帮助入口):
//  B1 看板页头:「+ 新建卡片」是这一页唯一的实心主钮;「复制看板」「管理看板」住进「⋯」菜单(点开才建、Esc 关、焦点还回);
//     「顺序」留在页头,窄档里带状态词(不再是无字的 ↕);
//  B2 设置「通用」页:节名与控件同一行、说明在行下;长说明只留第一句常显,其余在行下的「说明」折叠里(一句没删);
//  B3 Ctrl+1 … Ctrl+5 依侧栏顺序切视图,记一笔框里也生效、正在改一条的框里不跳;快捷键表与侧栏悬停提示写着;
//  B4 长文历史每一版一枚「复制这一版」:放进剪贴板的是那一版的 Markdown 源;历史仍只读(版本数不变);
//  B5 设置左栏最底下「用户指南 ↗」,哪一类下都在,地址与「关于」那枚同一个。
// 页头挑档(fitHeader)与「⋯」在空看板 / 窄列下的形由 board.e2e / trash-walk159 / board-seal 那几例守。

const P = "评审B-";
const nav = (view) => browser.execute((v) => document.querySelector(`.sidebar nav button[data-view="${v}"]`).click(), view);
const curView = () => browser.execute(() => document.querySelector(".sidebar nav button.active")?.dataset.view);
const ctrl = (key, target = "document.body") =>
  browser.execute(
    (k, sel) => {
      const ev = new KeyboardEvent("keydown", { key: k, ctrlKey: true, bubbles: true, cancelable: true });
      (sel === "document.body" ? document.body : document.querySelector(sel)).dispatchEvent(ev);
      return ev.defaultPrevented;
    },
    key,
    target,
  );
const hookClipboard = () =>
  browser.execute(() => {
    // 拦写入侧(同 deeplink.e2e.js 的形,⛔ 别碰真剪贴板)
    window.__clips = [];
    navigator.clipboard.writeText = (t) => {
      window.__clips.push(t);
      return Promise.resolve();
    };
  });
const openSettings = async () => {
  await browser.execute(() => document.getElementById("settings-entry").click());
  await $(".settings-panel").waitForExist({ timeout: 5000 });
};
const closeSettings = async () => {
  await browser.execute(() => document.querySelector(".settings-close").click());
  await $(".settings-overlay").waitForExist({ timeout: 5000, reverse: true });
};

describe("应用评审 B · 看板页头收纳", () => {
  const T = `${P}页头的一张卡`;
  let id;

  before(async () => {
    id = await invoke("create_task", { title: T });
    await goNotebook("board");
    await $(`.tcard*=${T}`).waitForExist({ timeout: 8000 });
  });

  after(async () => {
    await invoke("archive_task", { id });
    await invoke("purge_task", { id });
  });

  it("B1:「+ 新建卡片」是页头唯一的实心主钮;页头上不再摆「复制看板」「管理看板」", async () => {
    const h = await browser.execute(() => {
      const tools = document.querySelector(".v-board .head-tools");
      const add = document.querySelector("#add-task");
      const cs = getComputedStyle(add);
      const ghost = getComputedStyle(document.querySelector("#trash-toggle"));
      return {
        ids: [...tools.children].map((n) => n.id),
        primary: [...tools.querySelectorAll(".hbtn.primary")].map((n) => n.id),
        addBg: cs.backgroundColor,
        addBorder: cs.borderTopColor,
        ghostBg: ghost.backgroundColor,
        addText: add.innerText.replace(/\s+/g, " ").trim(),
        inHeader: !!tools.querySelector("#manage-cols, #copy-board, .copy-slot"),
      };
    });
    expect(h.ids).toEqual(["due-soon", "board-sort", "add-task", "board-more", "seal-toggle", "trash-toggle"]);
    expect(h.primary).toEqual(["add-task"]);
    expect(h.addBg).not.toBe(h.ghostBg); // 实心:有底色,且底与边同色(幽灵钮底是透明的)
    expect(h.addBg).toBe(h.addBorder);
    expect(h.addText).toContain("新建卡片");
    expect(h.inHeader).toBe(false);
    // 原有的单键一个没丢:N 照旧开新建框
    await browser.execute(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "n", bubbles: true, cancelable: true })));
    await browser.waitUntil(async () => !(await browser.execute(() => document.querySelector("#compose").hidden)), {
      timeout: 5000,
      timeoutMsg: "N 没打开新建框",
    });
    await browser.execute(() => document.querySelector("#compose-close").click());
  });

  it("B1:「⋯」点开两项、焦点进第一项;Esc 关、焦点还给「⋯」;「复制看板」写剪贴板并说「已复制」", async () => {
    await hookClipboard();
    await browser.execute(() => document.querySelector("#board-more").click());
    const m = await browser.execute(() => {
      const menu = document.querySelector(".board-more-menu");
      return {
        items: [...menu.querySelectorAll(".hk-item")].map((x) => `${x.id}=${x.textContent}`),
        focus: document.activeElement?.id,
        expanded: document.querySelector("#board-more").getAttribute("aria-expanded"),
        // 点得到吗:菜单项中心命中的就是它自己(不被别的层盖着)
        hit: [...menu.querySelectorAll(".hk-item")].every((x) => {
          const r = x.getBoundingClientRect();
          return x.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
        }),
      };
    });
    expect(m).toEqual({ items: ["copy-board=复制看板", "manage-cols=管理看板"], focus: "copy-board", expanded: "true", hit: true });

    // Esc:只关菜单(身后的看板不动),焦点回「⋯」
    await browser.execute(() => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    const closed = await browser.execute(() => ({
      menu: !!document.querySelector(".board-more-menu"),
      focus: document.activeElement?.id,
      expanded: document.querySelector("#board-more").getAttribute("aria-expanded"),
    }));
    expect(closed).toEqual({ menu: false, focus: "board-more", expanded: "false" });

    // 点别处也关
    await browser.execute(() => document.querySelector("#board-more").click());
    await browser.execute(() => document.querySelector("#board").dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(await browser.execute(() => !!document.querySelector(".board-more-menu"))).toBe(false);

    await boardMore("copy-board");
    await browser.waitUntil(async () => (await browser.execute(() => window.__clips.length)) === 1, {
      timeout: 5000,
      timeoutMsg: "「复制看板」没写剪贴板",
    });
    expect(await browser.execute(() => window.__clips[0])).toContain(`- [ ] ${T}`);
    expect(await browser.execute(() => !!document.querySelector(".board-more-menu"))).toBe(false);
    await browser.waitUntil(async () => (await browser.execute(() => document.body.innerText.includes("已复制"))) === true, {
      timeout: 5000,
      timeoutMsg: "复制完没有回执",
    });
  });

  it("B1:「⋯ → 管理看板」打开列管理面;进回收站「⋯」随「新建」一起收起", async () => {
    await boardMore("manage-cols");
    await $(".bcm-panel").waitForExist({ timeout: 5000 });
    await browser.execute(() => document.querySelector(".bcm-panel .bcm-close").click());
    await $(".bcm-overlay").waitForExist({ timeout: 5000, reverse: true });

    await browser.execute(() => document.querySelector("#trash-toggle").click());
    await browser.waitUntil(async () => (await browser.execute(() => document.querySelector("#board-more").hidden)) === true, {
      timeout: 5000,
      timeoutMsg: "回收站里「⋯」没收起",
    });
    expect(await browser.execute(() => document.querySelector("#add-task").hidden)).toBe(true);
    await browser.execute(() => document.querySelector("#trash-toggle").click());
    await browser.waitUntil(async () => (await browser.execute(() => document.querySelector("#board-more").hidden)) === false, { timeout: 5000 });
  });

  it("B1:「顺序」换档,窄档里的状态词跟着换(手动 / 最新 / 最早),不是无字的记号", async () => {
    const read = () =>
      browser.execute(() => {
        // 在同一次 execute 里把页头钉进窄档(= FIT_TIERS[2])量、再原样还回(同 task-time 那例的手法)
        const hdr = document.querySelector(".v-board header");
        const was = hdr.getAttribute("class") ?? "";
        hdr.classList.remove("hdr-nok", "hdr-short", "hdr-letter");
        const full = document.querySelector("#board-sort").innerText.trim();
        hdr.classList.add("hdr-nok", "hdr-short");
        const short = document.querySelector("#board-sort").innerText.trim();
        hdr.setAttribute("class", was);
        return { full, short };
      });
    const seen = [];
    for (let i = 0; i < 3; i++) {
      seen.push(await read());
      await browser.execute(() => document.querySelector("#board-sort").click());
      await browser.pause(150);
    }
    expect(seen).toEqual([
      { full: "顺序:手动", short: "手动" },
      { full: "顺序:最新在前", short: "最新" },
      { full: "顺序:最早在前", short: "最早" },
    ]);
    expect(await read()).toEqual({ full: "顺序:手动", short: "手动" }); // 点满三下回到手动(别把排序档留给后面的 spec)
  });
});

describe("应用评审 B · 设置", () => {
  before(async () => {
    await goNotebook("inbox");
  });

  it("B2:通用页每节 = 节名与控件同一行、说明在行下;长说明第一句常显,其余在「说明」折叠里", async () => {
    await openSettings();
    await browser.execute(() => document.querySelector('.settings-cat[data-cat="general"]').click());
    const rows = await browser.execute(() =>
      [...document.querySelectorAll(".settings-pane[data-cat='general'] .settings-item")].map((it) => {
        const h = it.querySelector("h2");
        const row = h.closest(".hkset-row");
        const ctl = [...row.children].find((c) => !c.classList.contains("hkset-name") && !c.classList.contains("hkset-desc"));
        const desc = row.querySelector(".hkset-desc");
        const fold = it.querySelector("details.settings-notes");
        const hr = h.getBoundingClientRect();
        const cr = ctl?.getBoundingClientRect();
        return {
          name: h.textContent,
          // 同一行:节名与控件的纵向区间相交,控件在节名右边
          sameLine: cr ? cr.top < hr.bottom && cr.bottom > hr.top && cr.left >= hr.right : null,
          descBelow: desc.getBoundingClientRect().top >= hr.bottom - 1,
          desc: desc.textContent,
          fold: fold ? { open: fold.open, text: [...fold.querySelectorAll(".settings-sub")].map((p) => p.textContent).join("") } : null,
          overflow: row.scrollWidth > row.clientWidth + 1,
        };
      }),
    );
    expect(rows.map((r) => r.name)).toEqual(["空间", "开机自动启动", "外观", "语言", "界面字号", "压缩大图", "删卡片前确认", "本机别名", "截止提醒", "意见反馈"]);
    for (const r of rows) {
      expect({ name: r.name, descBelow: r.descBelow, overflow: r.overflow }).toEqual({ name: r.name, descBelow: true, overflow: false });
      // 意见反馈那一节例外:说明写的是「下面这个地址」,地址行排在说明下面,节名那一行没有控件。
      expect({ name: r.name, sameLine: r.sameLine }).toEqual({ name: r.name, sameLine: r.name === "意见反馈" ? null : true });
    }
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    // 有折叠的正是那五节,默认收着;常显的那一句自己读得通,其余几句一字不少地在折叠里。
    expect(rows.filter((r) => r.fold).map((r) => r.name)).toEqual(["语言", "压缩大图", "删卡片前确认", "本机别名", "截止提醒"]);
    for (const r of rows.filter((x) => x.fold)) expect({ name: r.name, open: r.fold.open }).toEqual({ name: r.name, open: false });
    expect(by["截止提醒"].desc).toBe("应用没开着时不会响。");
    expect(by["截止提醒"].fold.text).toMatch(/^开着时,每天到点用一条系统通知报逾期、今天到期与 \d+ 天内到期的卡片数/);
    expect(by["截止提醒"].fold.text).toContain("开关与时刻只属于这台设备,不同步。");
    expect(by["删卡片前确认"].desc).toBe("开着时,在看板上删一张卡片会先问一句(删了也只是进回收站)。");
    expect(by["删卡片前确认"].fold.text).toBe("在那句确认里勾过「不再提示」,这里就是关;想再被问,点「开」。只影响这台设备。");
    expect(by["本机别名"].desc).toBe("给这台设备起个名字,比如「书房台式机」,别的设备上就能看出每条是哪台记的。");
    expect(by["本机别名"].fold.text).toBe("名字会同步给这个空间里的其他设备;每个空间分别起。");
    expect(by["压缩大图"].fold.text).toContain("长截图不会被压成窄条。已存的图不受影响。只影响这台设备。");
    expect(by["语言"].fold.text).toBe("只影响这台电脑,不会同步。");
    // 折叠点得开
    await browser.execute(() => document.querySelector(".settings-pane[data-cat='general'] details.settings-notes summary").click());
    expect(await browser.execute(() => document.querySelector(".settings-pane[data-cat='general'] details.settings-notes").open)).toBe(true);
    await closeSettings();
  });

  it("B5:左栏最底下「用户指南 ↗」哪一类下都在,地址与「关于」那枚同一个;它不是一类", async () => {
    await openSettings();
    const seen = [];
    for (const cat of ["general", "hotkeys", "backup", "about"]) {
      await browser.execute((c) => document.querySelector(`.settings-cat[data-cat="${c}"]`).click(), cat);
      seen.push(
        await browser.execute(() => {
          const g = document.querySelector(".settings-nav .settings-guide");
          const nav = document.querySelector(".settings-nav");
          const r = g.getBoundingClientRect();
          return {
            text: g.textContent,
            shown: r.width > 0 && r.height >= 24,
            last: nav.lastElementChild === g,
            atBottom: nav.getBoundingClientRect().bottom - r.bottom < 24,
            on: g.classList.contains("on"),
          };
        }),
      );
    }
    for (const s of seen) expect(s).toEqual({ text: "用户指南 ↗", shown: true, last: true, atBottom: true, on: false });
    const urls = await browser.execute(() => ({
      nav: document.querySelector(".settings-guide").title,
      about: [...document.querySelectorAll(".about-links a")].find((a) => a.textContent === "用户指南").getAttribute("href"),
      cats: document.querySelectorAll(".settings-cat").length,
    }));
    expect(urls.nav).toBe(urls.about);
    expect(urls.nav).toBe("https://zhujian.app/docs/");
    expect(urls.cats).toBe(4);
    await closeSettings();
  });
});

describe("应用评审 B · 切视图的快捷键", () => {
  it("B3:Ctrl+1 … Ctrl+5 各到各的视图(依侧栏顺序);侧栏悬停提示带着键", async () => {
    await goNotebook("inbox");
    const order = await browser.execute(() => [...document.querySelectorAll(".sidebar nav button[data-view]")].map((b) => b.dataset.view));
    expect(order).toEqual(["inbox", "board", "docs", "topics", "search"]);
    // 倒着按一遍再回到第一页:每一下都真换了页
    for (const n of [5, 4, 3, 2, 1]) {
      expect(await ctrl(String(n))).toBe(true);
      await browser.waitUntil(async () => (await curView()) === order[n - 1], { timeout: 8000, timeoutMsg: `Ctrl+${n} 没到 ${order[n - 1]}` });
      await $(`#view > .v-${order[n - 1]}`).waitForExist({ timeout: 8000 });
    }
    const titles = await browser.execute(() => [...document.querySelectorAll(".sidebar nav button[data-view]")].map((b) => b.title));
    expect(titles).toEqual(["随记 (Ctrl+1)", "看板 (Ctrl+2)", "长文 (Ctrl+3)", "标签 (Ctrl+4)", "搜索 (Ctrl+5)"]);
    // 没有第六页:Ctrl+6 不动、也不吞
    expect(await ctrl("6")).toBe(false);
    expect(await curView()).toBe("inbox");
  });

  it("B3:记一笔框里也生效;正在改一条的框里不跳(键照样吞掉);设置开着时不换身后的页", async () => {
    await goNotebook("inbox");
    await $(".v-inbox .compose-input").waitForExist({ timeout: 8000 });
    await browser.execute(() => document.querySelector(".v-inbox .compose-input").focus());
    expect(await ctrl("2", ".v-inbox .compose-input")).toBe(true);
    await browser.waitUntil(async () => (await curView()) === "board", { timeout: 8000, timeoutMsg: "记一笔框里按 Ctrl+2 没到看板" });

    const id = await invoke("capture_note", { content: `${P}B3 正在改的一条` });
    try {
      await nav("inbox");
      await $(`.note*=${P}B3 正在改的一条`).waitForExist({ timeout: 8000 });
      await browser.execute((t) => {
        const n = [...document.querySelectorAll(".v-inbox .note")].find((x) => x.textContent.includes(t));
        n.querySelector(".note-text").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      }, `${P}B3`);
      await $(".v-inbox .edit-area").waitForExist({ timeout: 5000 });
      await browser.execute(() => document.querySelector(".v-inbox .edit-area").focus());
      expect(await ctrl("2", ".v-inbox .edit-area")).toBe(true); // 吞掉
      expect(await browser.execute(() => !!document.querySelector(".v-inbox .edit-area"))).toBe(true); // 没跳
      expect(await curView()).toBe("inbox");
      await browser.execute(() => document.querySelector(".v-inbox .edit-area").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    } finally {
      await invoke("archive_note", { id });
      await invoke("purge_note", { id });
    }

    // 设置浮层开着:按键到不了身后(holdKeyboard),页不换
    await goNotebook("inbox");
    await openSettings();
    await browser.execute(() => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "2", ctrlKey: true, bubbles: true, cancelable: true })));
    expect(await curView()).toBe("inbox");
    // 快捷键表写着这一行
    await browser.execute(() => document.querySelector('.settings-cat[data-cat="hotkeys"]').click());
    const rows = await browser.execute(() =>
      [...document.querySelectorAll(".keysheet-list dt")].map((dt) => `${dt.textContent}=${dt.nextElementSibling.textContent}`),
    );
    expect(rows.some((r) => r.startsWith("Ctrl+1 – Ctrl+5=") && r.includes("切换视图"))).toBe(true);
    await closeSettings();
  });
});

describe("应用评审 B · 长文历史「复制这一版」", () => {
  const V1 = `# ${P}历史篇\n\n第一版的一句。\n\n- [ ] 一项`;
  const V2 = `# ${P}历史篇\n\n第二版改过的一句。\n\n- [x] 一项\n- 再加一项`;
  let id;

  before(async () => {
    id = await invoke("capture_doc", { content: V1 });
    await invoke("edit_note", { id, content: V2 });
  });

  after(async () => {
    await invoke("archive_note", { id });
    await invoke("purge_note", { id });
  });

  it("B4:每一版(含当前)一枚;放进剪贴板的是那一版的 Markdown 源;说「已复制这一版的原文」;不落新版", async () => {
    await goNotebook("docs");
    await browser.waitUntil(
      () => browser.execute((t) => [...document.querySelectorAll(".v-docs .doc-card-title")].some((n) => n.textContent.includes(t)), `${P}历史篇`),
      { timeout: 8000, timeoutMsg: "长文列表里没有那一篇" },
    );
    await browser.execute((t) => {
      [...document.querySelectorAll(".v-docs .doc-card")].find((n) => n.querySelector(".doc-card-title").textContent.includes(t)).click();
    }, `${P}历史篇`);
    await $(".v-docs .doc-page .md").waitForExist({ timeout: 8000 });
    await browser.execute(() => document.querySelectorAll(".v-docs .doc-bar .hbtn")[2].click()); // 历史
    await $(".v-docs .hv-out .diff").waitForExist({ timeout: 8000 });

    const rows = await browser.execute(() =>
      [...document.querySelectorAll(".v-docs .hv-row")].map((r) => ({
        copy: r.querySelector(".hv-copy")?.textContent ?? null,
        // 行不被这枚钮挤破:不横向溢出、钮自己不折字
        overflow: r.scrollWidth > r.clientWidth + 1,
        oneLine: r.querySelector(".hv-copy").getBoundingClientRect().height < 40,
      })),
    );
    expect(rows).toEqual([
      { copy: "复制这一版", overflow: false, oneLine: true },
      { copy: "复制这一版", overflow: false, oneLine: true },
    ]);

    await hookClipboard();
    // 第 0 行 = 当前版,第 1 行 = 上一版
    for (const [i, want] of [
      [1, V1],
      [0, V2],
    ]) {
      await browser.execute((n) => {
        window.__clips = [];
        document.querySelectorAll(".v-docs .hv-copy")[n].click();
      }, i);
      await browser.waitUntil(async () => (await browser.execute(() => window.__clips.length)) === 1, {
        timeout: 5000,
        timeoutMsg: `第 ${i} 行的「复制这一版」没写剪贴板`,
      });
      expect(await browser.execute(() => window.__clips[0])).toBe(want);
      await browser.waitUntil(async () => (await browser.execute(() => document.body.innerText.includes("已复制这一版的原文"))) === true, {
        timeout: 5000,
        timeoutMsg: "复制完没有那句回执",
      });
    }
    // 只读:版本数没变、正文没变,页上没有「恢复」
    expect((await invoke("list_revisions", { id, before: null })).total).toBe(1);
    expect((await invoke("list_docs")).find((d) => d.id === id).content).toBe(V2);
    expect(await browser.execute(() => document.querySelector(".v-docs .hv").innerText.includes("恢复"))).toBe(false);
  });

  it("B4:写剪贴板失败 ⇒ 说「复制失败」,不说已复制", async () => {
    // 接着上一例,还在历史页上
    await browser.execute(() => {
      navigator.clipboard.writeText = () => Promise.reject(new Error("denied"));
      document.querySelectorAll(".v-docs .hv-copy")[0].click();
    });
    await browser.waitUntil(async () => (await browser.execute(() => document.body.innerText.includes("复制失败"))) === true, {
      timeout: 5000,
      timeoutMsg: "写剪贴板失败没有照实说",
    });
  });
});

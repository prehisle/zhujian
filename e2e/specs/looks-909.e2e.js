// 909 电脑版观感补看修的那几条里「能锁的行为」(brief 的验收节):
//   E4 看板卡元信息行:空的截止 / 优先级 / 颜色格不占位 ——「💬 N」与标题左缘对齐,相邻两项之间就是一份间距;
//   E5 长文编辑单栏(视口 < 1180)时工具条与编辑框同宽:「保存」右缘 = 编辑框右缘;
//   E6 字号放大、顶栏那组钮折到第二行时靠左,与页标题左缘同列(看板 / 长文 / 标签 / 随记);
//   E7 小字加深:留言时间 / 「销毁」/ 随记内嵌留言的标题、筛选条轴名与计数、看板列头计数 = --ink-soft;计数与药丸同色;
//   E8 留言「记下」= 圆头药丸、满朱、与留言框同高;
//   E9 管理看板浮层:钮是圆头药丸,钮与输入框同高 31;
//   E10 同步浮层二级页:「‹ 返回」在子层左上、页底只剩主钮(靠右、主钮样式);输入框高 31;Esc 照旧退一层;
//   E11 设置里的别名框 / 提醒时刻框圆角 8;
//   E13 标签筛选行折下去的那几行从第一枚 pill 那一列起、「更多」贴着最后一枚;
//   E14 冲突条 / 深链提示条的关闭钮是「✕」;
//   E3 英文档:竖图缩略框里的角标恒一行、不出框(放不下全称换短称)。
// 判据一律量**几何 / 计算样式**,不判 class(memory `gates-green-is-not-looks-right`)。
// ⚠ Linux CI 缺中文字体、字形度量不同:凡要断言「同高」的控件都是 CSS 钉死的高,这里只比钉死的那几样;
//   靠「放不放得下」的前置(E6 / E13)用 200% 档,留足余量(.claude/rules/e2e.md 900 那条)。
import { $, expect, browser } from "@wdio/globals";
import { invoke, goNotebook, inboxShow, inboxAction, boardMore, openSyncServerField } from "./support.js";

const P = "L909-";
const R = (n) => Math.round(n * 10) / 10;

/** 一个令牌此刻解析成的颜色(拿一个临时元素去量,别在测试里抄色值)。 */
const tokenColor = (name) =>
  browser.execute((n) => {
    const d = document.createElement("span");
    d.style.color = `var(${n})`;
    document.body.append(d);
    const c = getComputedStyle(d).color;
    d.remove();
    return c;
  }, name);

/** 改被驱动那只窗自己的大小(同 support.js goNotebook 的手法),等视口跟上。 */
async function setWin(w) {
  await browser.execute(async (x) => {
    const W = window.__TAURI__.window;
    await W.getCurrentWindow().setSize(new W.LogicalSize(x, 700));
  }, w);
  await browser.waitUntil(async () => Math.abs((await browser.execute(() => window.innerWidth)) - w) < 4, {
    timeout: 5000,
    timeoutMsg: `视口宽一直没到 ${w}`,
  });
}

/** 只改本窗的 WebView 缩放(不落 localStorage、不广播 —— 不影响别的 spec)。 */
const setZoom = (f) => browser.execute(async (z) => window.__TAURI__.webview.getCurrentWebview().setZoom(z), f);

const esc = () => browser.execute(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));

describe("909 电脑版观感补看", () => {
  let taskId;
  before(async () => {
    // 一张只有留言的卡(截止 / 优先级 / 颜色三格全空)与一张带截止 + 优先级的卡;一条带留言的随记;一篇长文;
    // 一组标签(够 200% 时把标签筛选行折成两行以上)。
    taskId = await invoke("create_task", { title: `${P}只有留言的卡`, topicId: null });
    await invoke("add_item_comment", { itemId: taskId, content: `${P}一句留言` });
    const t2 = await invoke("create_task", { title: `${P}带截止的卡`, topicId: null });
    const d = new Date(Date.now() + 3 * 86400000);
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    await invoke("set_task_due", { id: t2, dueOn: ymd });
    await invoke("set_task_priority", { id: t2, priority: 1 });
    const nid = await invoke("capture_note", { content: `${P}带留言的随记` });
    await invoke("add_item_comment", { itemId: nid, content: `${P}随记上的留言` });
    await invoke("capture_doc", { content: `# ${P}长文\n\n正文一句。` });
    for (let i = 0; i < 8; i++) {
      const id = await invoke("create_topic", { title: `${P}标签${i}` });
      await invoke("file_note_to_topic", { id: await invoke("capture_note", { content: `${P}挂标签${i}` }), topicId: id, newTitle: null });
    }
  });

  it("E4:空的截止 / 优先级 / 颜色格不占位 ——「💬 N」与标题左缘对齐,相邻两项一份间距", async () => {
    await goNotebook("board");
    await $(`.tcard*=${P}只有留言的卡`).waitForExist({ timeout: 8000 });
    await $(`.tcard*=${P}带截止的卡`).waitForExist({ timeout: 8000 });
    const r = await browser.execute((p) => {
      const card = (t) => [...document.querySelectorAll(".v-board .tcard")].find((c) => c.textContent.includes(t));
      const read = (c) => {
        const title = c.querySelector(".ttitle").getBoundingClientRect().left;
        const meta = [...c.querySelectorAll(".task-meta")].find((m) => m.offsetParent !== null && !m.classList.contains("task-topic"));
        const kids = [...meta.children].filter((k) => k.offsetParent !== null && k.getBoundingClientRect().width > 0);
        const gap = parseFloat(getComputedStyle(meta).columnGap);
        return {
          firstDx: R(kids[0].getBoundingClientRect().left - title),
          gaps: kids.slice(1).map((k, i) => R(k.getBoundingClientRect().left - kids[i].getBoundingClientRect().right - gap)),
          n: kids.length,
          first: kids[0].className,
        };
      };
      const R = (n) => Math.round(n * 10) / 10;
      return { comment: read(card(`${p}只有留言的卡`)), due: read(card(`${p}带截止的卡`)) };
    }, P);
    expect(r.comment.first).toContain("cm-badge"); // 前置:量的真是那枚「💬」
    expect(r.comment.firstDx).toBe(0);
    expect(r.due.n).toBeGreaterThanOrEqual(2); // 前置:截止 + 优先级两项都在(否则「一份间距」恒真)
    expect(r.due.firstDx).toBe(0);
    for (const g of r.due.gaps) expect(Math.abs(g)).toBeLessThanOrEqual(0.5);
  });

  it("E7:看板列头计数、筛选条轴名与计数 = --ink-soft;计数与药丸同一档色", async () => {
    await goNotebook("board");
    await $(".v-board .col-count").waitForExist({ timeout: 8000 });
    const soft = await tokenColor("--ink-soft");
    const r = await browser.execute(() => {
      const c = (e) => (e ? getComputedStyle(e).color : null);
      const pill = [...document.querySelectorAll(".tf-pill")].find((p) => p.offsetParent !== null && !p.classList.contains("active") && !p.classList.contains("empty") && p.querySelector(".tf-n"));
      const act = document.querySelector(".tf-pill.active");
      return {
        col: c(document.querySelector(".v-board .col-count")),
        axis: c(document.querySelector(".tf-axis")),
        pill: c(pill),
        pillN: c(pill?.querySelector(".tf-n")),
        act: c(act),
        actN: c(act?.querySelector(".tf-n")),
      };
    });
    expect(r.col).toBe(soft);
    expect(r.axis).toBe(soft);
    expect(r.pill).not.toBe(null);
    expect(r.pillN).toBe(r.pill);
    expect(r.actN).toBe(r.act);
  });

  it("E8 / E7:看板留言浮层 ——「记下」满朱圆头、与留言框同高;时间与「销毁」= --ink-soft", async () => {
    await goNotebook("board");
    const card = await $(`.tcard*=${P}只有留言的卡`);
    await card.waitForExist({ timeout: 8000 });
    await browser.execute((c) => c.querySelector(".cm-badge").click(), card);
    await $(".cm-panel .cm-item").waitForExist({ timeout: 5000 });
    const soft = await tokenColor("--ink-soft");
    const seal = await tokenColor("--seal");
    const r = await browser.execute(() => {
      const s = document.querySelector(".cm-send");
      const i = document.querySelector(".cm-input");
      const cs = getComputedStyle(s);
      return {
        sendH: Math.round(s.getBoundingClientRect().height * 10) / 10,
        inputH: Math.round(i.getBoundingClientRect().height * 10) / 10,
        bottomDy: Math.round((s.getBoundingClientRect().bottom - i.getBoundingClientRect().bottom) * 10) / 10,
        radius: cs.borderTopLeftRadius,
        bg: cs.backgroundColor,
        meta: getComputedStyle(document.querySelector(".cm-meta")).color,
        del: getComputedStyle(document.querySelector(".cm-del")).color,
      };
    });
    await esc();
    await $(".cm-panel").waitForExist({ timeout: 5000, reverse: true });
    expect(r.radius).toBe("999px");
    expect(r.bg).toBe(seal);
    expect(Math.abs(r.sendH - r.inputH)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(r.bottomDy)).toBeLessThanOrEqual(0.5);
    expect(r.meta).toBe(soft);
    expect(r.del).toBe(soft);
  });

  it("E7:随记内嵌留言的标题 = --ink-soft", async () => {
    await inboxShow("ideas");
    await $(`.note*=${P}带留言的随记`).waitForExist({ timeout: 8000 });
    await inboxAction(`${P}带留言的随记`, "留言");
    await $(".cm-panel.cm-inline .cm-title").waitForExist({ timeout: 5000 });
    const soft = await tokenColor("--ink-soft");
    const c = await browser.execute(() => getComputedStyle(document.querySelector(".cm-panel.cm-inline .cm-title")).color);
    await esc();
    expect(c).toBe(soft);
  });

  it("E9:管理看板浮层 —— 钮是圆头药丸,钮与输入框同高 31", async () => {
    await goNotebook("board");
    await boardMore("manage-cols");
    await $(".bcm-panel .bcm-col-input").waitForExist({ timeout: 5000 });
    const r = await browser.execute(() => {
      const P = document.querySelector(".bcm-panel");
      const btns = [...P.querySelectorAll(".bcm-btn")].filter((b) => b.offsetParent !== null);
      const ins = [...P.querySelectorAll(".bcm-col-input")].filter((b) => b.offsetParent !== null);
      const h = (e) => Math.round(e.getBoundingClientRect().height * 10) / 10;
      return { nb: btns.length, ni: ins.length, bh: [...new Set(btns.map(h))], ih: [...new Set(ins.map(h))], pill: btns.every((b) => getComputedStyle(b).borderTopLeftRadius === "999px"), ir: [...new Set(ins.map((i) => getComputedStyle(i).borderTopLeftRadius))] };
    });
    await browser.execute(() => document.querySelector(".bcm-overlay")?.remove());
    expect(r.nb).toBeGreaterThan(2);
    expect(r.ni).toBeGreaterThan(0);
    expect(r.pill).toBe(true);
    expect(r.bh).toEqual([31]);
    expect(r.ih).toEqual([31]);
    expect(r.ir).toEqual(["8px"]);
  });

  it("E5:长文编辑单栏(窗 1120)时「保存」右缘 = 编辑框右缘", async () => {
    await goNotebook("docs");
    const card = await $(`.doc-card*=${P}长文`);
    await card.waitForExist({ timeout: 8000 });
    await browser.execute((c) => c.click(), card);
    await $(".v-docs .doc-page .md").waitForExist({ timeout: 8000 });
    await browser.execute(() => [...document.querySelectorAll(".v-docs .doc-bar .hbtn")].find((b) => b.querySelector(".lbl")?.textContent === "编辑").click());
    await $(".v-docs .doc-area").waitForExist({ timeout: 8000 });
    await setWin(1120);
    try {
      const r = await browser.execute(() => {
        const btns = [...document.querySelectorAll(".v-docs .doc-bar button")].filter((b) => b.offsetParent !== null);
        const save = btns[btns.length - 1];
        return {
          single: getComputedStyle(document.querySelector(".v-docs .doc-preview")).display === "none", // 前置:真在单栏那一档
          saveText: save.textContent.trim(),
          dx: Math.round((save.getBoundingClientRect().right - document.querySelector(".v-docs .doc-ed").getBoundingClientRect().right) * 10) / 10,
        };
      });
      expect(r.single).toBe(true);
      expect(r.saveText).toBe("保存");
      expect(Math.abs(r.dx)).toBeLessThanOrEqual(0.5);
    } finally {
      await setWin(1260);
    }
    await esc(); // 没改字:离开编辑器回阅读页
  });

  it("E6:字号 200% 时顶栏那组钮折到第二行、与页标题左缘同列(看板 / 长文 / 标签 / 随记)", async () => {
    const read = () =>
      browser.execute(() => {
        const h = document.querySelector("#view > .view > header");
        const h1 = h.querySelector(":scope > h1").getBoundingClientRect();
        const t = h.querySelector(":scope > .head-tools").getBoundingClientRect();
        return { row2: t.top >= h1.bottom, dx: Math.round((t.left - h1.left) * 10) / 10 };
      });
    const out = {};
    for (const v of ["board", "docs", "topics", "inbox"]) {
      await goNotebook(v);
      await $(`.v-${v} header .head-tools`).waitForExist({ timeout: 8000 });
      await setZoom(2);
      try {
        await browser.waitUntil(async () => (await read()).row2 && (await read()).dx === 0, { timeout: 5000 }).catch(() => {});
        out[v] = await read();
      } finally {
        await setZoom(1);
      }
    }
    for (const [v, r] of Object.entries(out)) expect({ v, ...r }).toEqual({ v, row2: true, dx: 0 });
  });

  it("E13:字号 200% 时标签筛选行折下去的那几行从第一枚 pill 那一列起,「更多」贴着最后一枚", async () => {
    await goNotebook("inbox");
    await $("#idea-topic-filter .tf-axis").waitForExist({ timeout: 8000 });
    await setZoom(2);
    try {
      const read = () =>
        browser.execute(() => {
          const bar = document.querySelector("#idea-topic-filter");
          const kids = [...bar.children].filter((c) => c.offsetParent !== null && !c.classList.contains("tf-axis"));
          const first = kids[0].getBoundingClientRect();
          const lines = [];
          let prev = Infinity;
          for (const k of kids) {
            const l = k.getBoundingClientRect().left;
            // 左缘回到上一枚的左边或原地 = 换行;折下去那枚与第一枚同列时两者左缘只差亚像素 ⇒ 留 0.5 的余量
            if (l <= prev + 0.5) lines.push(Math.round((l - first.left) * 10) / 10);
            prev = l;
          }
          const more = document.querySelector(".tf-more");
          const last = kids[kids.length - 1].getBoundingClientRect();
          const gap = parseFloat(getComputedStyle(bar).columnGap);
          const m = more && !more.hidden ? more.getBoundingClientRect() : null;
          return { lines, more: m ? { dx: Math.round((m.left - last.right - gap) * 10) / 10, sameLine: Math.abs(m.bottom - last.bottom) < last.height } : null };
        });
      await browser.waitUntil(async () => (await read()).lines.length >= 2, { timeout: 5000 }).catch(() => {});
      const r = await read();
      expect(r.lines.length).toBeGreaterThanOrEqual(2); // 前置:真折了行(否则「同列」恒真)
      for (const dx of r.lines) expect(Math.abs(dx)).toBeLessThanOrEqual(0.5);
      expect(r.more).not.toBe(null); // 前置:两行以上 ⇒ 折叠钮在
      expect(Math.abs(r.more.dx)).toBeLessThanOrEqual(1);
      expect(r.more.sameLine).toBe(true);
    } finally {
      await setZoom(1);
    }
  });

  it("E11:设置里的别名框 / 提醒时刻框圆角 8", async () => {
    await goNotebook("inbox");
    await browser.execute(() => document.querySelector("#settings-entry").click());
    await $(".settings-panel").waitForExist({ timeout: 8000 });
    await browser.execute(() => document.querySelector('.settings-cat[data-cat="general"]').click());
    const r = await browser.execute(() => ["alias-input", "remind-time"].map((c) => getComputedStyle(document.querySelector(`.settings-pane[data-cat="general"] .${c}`)).borderTopLeftRadius));
    await esc();
    expect(r).toEqual(["8px", "8px"]);
  });

  it("E14:随记页冲突条、深链提示条的关闭钮是「✕」,点按区 24×24", async () => {
    await inboxShow("ideas");
    // 冲突条那两枚钮挂载时就建好(有没有冲突只管显隐),字形看得到;点按区由热区门禁核(它被藏着时量不出几何)。
    const hk = await browser.execute(() => document.querySelector("#hkb-banner .hkb-x")?.textContent ?? null);
    await browser.execute((id) => window.__zhujianOfferClipboardDeepLink(`zhujian://open?space=main&item=${id}`), taskId);
    await browser.waitUntil(() => browser.execute(() => !!document.querySelector("#deeplink-pill.show .deeplink-pill-dismiss")), { timeout: 5000, timeoutMsg: "深链提示条没弹" });
    const dl = await browser.execute(() => {
      const b = document.querySelector("#deeplink-pill .deeplink-pill-dismiss");
      const z = getComputedStyle(b, "::before");
      return { t: b.textContent, w: parseFloat(z.width), h: parseFloat(z.height) };
    });
    await browser.execute(() => document.querySelector("#deeplink-pill .deeplink-pill-dismiss").click());
    expect(hk).toBe("✕");
    expect(dl.t).toBe("✕");
    expect(dl.w).toBeGreaterThanOrEqual(24);
    expect(dl.h).toBeGreaterThanOrEqual(24);
  });

  it("E10:同步浮层二级页 ——「‹ 返回」在子层左上,页底只剩主钮(靠右、主钮样式),输入框高 31;Esc 退一层", async () => {
    await goNotebook("inbox");
    const clickIn = (label) =>
      browser.execute((l) => {
        const b = [...document.querySelectorAll(".sync-panel button")].find((n) => n.textContent.includes(l));
        if (!b) throw new Error("同步浮层里没有按钮:" + l);
        b.click();
      }, label);
    const read = () =>
      browser.execute(() => {
        const body = document.querySelector(".sync-panel .sync-body");
        const back = body.querySelector(".sync-back");
        const br = body.getBoundingClientRect();
        const acts = [...body.querySelectorAll(".sync-actions")].pop();
        const btns = acts ? [...acts.querySelectorAll("button")].filter((b) => b.offsetParent !== null) : [];
        const R = (n) => Math.round(n * 10) / 10;
        return {
          back: back ? { text: back.textContent, first: body.firstElementChild === back, dx: R(back.getBoundingClientRect().left - br.left) } : null,
          acts: btns.map((b) => ({ t: b.textContent, primary: b.classList.contains("primary"), dr: R(br.right - b.getBoundingClientRect().right) })),
          inputs: [...body.querySelectorAll("input.sync-input")].filter((i) => i.offsetParent !== null).map((i) => R(i.getBoundingClientRect().height)),
        };
      });
    const onHome = async () => (await read()).back === null;
    await browser.execute(() => document.getElementById("sync-entry").click());
    await $(".sync-panel").waitForExist({ timeout: 5000 });
    // 未配置态:创建账户 / 用配对码加入
    await clickIn("创建账户");
    await openSyncServerField();
    const c = await read();
    expect(c.back).toEqual({ text: "‹ 返回", first: true, dx: 0 });
    expect(c.acts).toEqual([{ t: "创建", primary: true, dr: 0 }]);
    expect(c.inputs).toEqual([31]);
    await esc();
    await browser.waitUntil(onHome, { timeout: 5000, timeoutMsg: "创建账户页按 Esc 没回首页" });
    await clickIn("用配对码加入");
    await $(".sync-panel .sync-back").waitForExist({ timeout: 5000 });
    const j = await read();
    expect(j.back).toEqual({ text: "‹ 返回", first: true, dx: 0 });
    expect(j.acts).toEqual([{ t: "加入", primary: true, dr: 0 }]);
    expect(j.inputs).toEqual([31, 31]);
    await browser.execute(() => document.querySelector(".sync-panel .sync-back").click()); // 点「‹ 返回」也回首页
    await browser.waitUntil(onHome, { timeout: 5000, timeoutMsg: "点「‹ 返回」没回首页" });
    // 已配置态(喂一枚状态事件,同 sync-ui.e2e.js):高级 → 修改服务器;Esc 一层一层退
    await browser.execute(
      () =>
        window.__TAURI__.event.emit("sync-status", {
          space: "main",
          status: { configured: true, state: "online", account_id: "01JQACCOUNT0000000000000000", device_id: "01JQ8F0000AAAAAAAAAAAAAAAA", server_url: "wss://sync.example.invalid", peers_online: 0, error: null, frozen: [], suspended: 0, skew: false, clock_skew: false, roster: null },
        }),
    );
    await browser.waitUntil(() => browser.execute(() => [...document.querySelectorAll(".sync-panel button")].some((b) => b.textContent.includes("高级"))), { timeout: 5000, timeoutMsg: "喂进去的已配置状态没把面板翻到状态页" });
    await clickIn("高级");
    await $(".sync-panel .sync-back").waitForExist({ timeout: 5000 });
    const a = await read();
    expect(a.back).toEqual({ text: "‹ 返回", first: true, dx: 0 });
    expect(a.acts.map((x) => x.t)).not.toContain("‹ 返回");
    await clickIn("修改服务器");
    await $(".sync-panel input.sync-input").waitForExist({ timeout: 5000 });
    const s = await read();
    expect(s.back).toEqual({ text: "‹ 返回", first: true, dx: 0 });
    expect(s.acts).toEqual([{ t: "保存", primary: true, dr: 0 }]);
    expect(s.inputs).toEqual([31]);
    expect(await browser.execute(() => document.activeElement?.classList.contains("sync-input"))).toBe(true); // 换页焦点照旧落到第一个内容控件,不是「‹ 返回」
    await esc();
    await browser.waitUntil(() => browser.execute(() => !document.querySelector(".sync-panel input.sync-input") && !!document.querySelector(".sync-panel .sync-back")), { timeout: 5000, timeoutMsg: "改服务器页按 Esc 没回「高级」" });
    await esc();
    await browser.waitUntil(onHome, { timeout: 5000, timeoutMsg: "「高级」页按 Esc 没回首页" });
    await esc();
    await $(".sync-panel").waitForExist({ timeout: 5000, reverse: true });
  });

  it("E3:英文档 —— 竖图缩略框(最窄 36)里的角标恒一行、不出框;放不下全称时换短称", async () => {
    await goNotebook("inbox");
    const png = (w, h) =>
      browser.execute(
        (a, b) => {
          const c = document.createElement("canvas");
          c.width = a;
          c.height = b;
          const x = c.getContext("2d");
          x.fillStyle = "#6a9";
          x.fillRect(0, 0, a, b);
          return c.toDataURL("image/png").split(",")[1];
        },
        w,
        h,
      );
    const id = await invoke("capture_note", { content: `${P}竖图角标` });
    await invoke("add_item_image", { itemId: id, mime: "image/png", dataB64: await png(300, 900) }); // 框 36
    await invoke("add_item_image", { itemId: id, mime: "image/png", dataB64: await png(1080, 1920) }); // 框 41(手机截图)
    await invoke("add_item_image", { itemId: id, mime: "image/png", dataB64: await png(600, 800) }); // 框 54(竖拍照片)
    await browser.execute(() => {
      localStorage.setItem("zhujian.lang", "en");
      return window.__TAURI__.event.emit("lang-changed", "en");
    });
    try {
      await browser.waitUntil(async () => (await browser.execute(() => document.documentElement.lang)) === "en", { timeout: 10000, timeoutMsg: "没换成英文" });
      await inboxShow("ideas");
      const note = await $(`.note*=${P}竖图角标`);
      await note.waitForExist({ timeout: 8000 });
      await browser.waitUntil(
        () => browser.execute((n) => [...n.querySelectorAll(".img-thumb-img")].filter((i) => i.naturalWidth > 0).length === 3, note),
        { timeout: 10000, timeoutMsg: "三张缩略图没画齐" },
      );
      const r = await browser.execute(
        (n) =>
          [...n.querySelectorAll(".img-thumb")].map((b) => {
            const g = b.querySelector(".img-badge");
            const lh = parseFloat(getComputedStyle(g).lineHeight);
            const br = b.getBoundingClientRect();
            const gr = g.getBoundingClientRect();
            return { box: Math.round(br.width), text: g.textContent, oneLine: gr.height < lh * 1.5 + 4, inside: gr.right <= br.right + 0.5, fits: g.scrollWidth <= g.clientWidth };
          }),
        note,
      );
      expect(r.map((x) => x.box)).toEqual([36, 41, 54]); // 前置:真是那三种窄框
      for (const x of r) expect({ box: x.box, oneLine: x.oneLine, inside: x.inside, fits: x.fits }).toEqual({ box: x.box, oneLine: true, inside: true, fits: true });
      expect(r[0].text).toBe("#1"); // 36 宽放不下「Image 1」⇒ 短称
      expect(r[2].text).toBe("Image 3"); // 竖拍照片那一档放得下全称
    } finally {
      await browser.execute(() => {
        localStorage.removeItem("zhujian.lang");
        return window.__TAURI__.event.emit("lang-changed", "auto");
      });
      await browser.waitUntil(async () => (await browser.execute(() => document.documentElement.lang)) === "zh", { timeout: 10000, timeoutMsg: "退回自动之后没回到中文" });
    }
  });
});

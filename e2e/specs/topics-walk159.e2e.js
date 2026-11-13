import { $, $$, expect, browser } from "@wdio/globals";
import { invoke, goNotebook, inboxShow, inboxAction } from "./support.js";

// W3 走查修复(backlog 用户面 159)桌面第一波 · 标签那几条:
//   A8  新建 / 改名 / 改色都给回执;新建后滚到那一行并闪一下;改名改色后列表留在那行;重命名面板 Esc 能关(WD-07 / 05)
//   A9  删除标签 / 合并的确认钮不落在原钮的位置(WD-10)
//   A11 撞名:字留在框里、红字在框下、不带「出错:」(WD-33)
//   A16 标签页展开里清单画成方框、长条折八行(WD-21)
//   A22 无色标签:标签页名字与有色行对齐、看板卡与随记卡同一个样;窄了「工作」不竖排(WD-27 / 22)
//   Q3  删除 / 合并的确认照手机的字说清后果,做完都给回执(WD-14 / 15)
//   Q10 挂标签的选择器里子标签写全名(WD-32)
//   Q12 颜色面板点色点就收起、没有「完成」;「类型」框下一行说明(WD-34 / 35)

async function armRecorder() {
  await browser.execute(() => {
    window.__toasts = [];
    window.__flashes = [];
    window.__obs?.disconnect();
    window.__obs = new MutationObserver((ms) => {
      for (const m of ms) {
        if (m.type === "childList")
          for (const n of m.addedNodes)
            if (n instanceof HTMLElement && (n.classList.contains("copy-toast") || n.classList.contains("undo-toast")))
              window.__toasts.push(n.textContent);
        if (m.type === "attributes" && m.target.classList?.contains("just-born"))
          window.__flashes.push(m.target.querySelector(".topic-title")?.textContent ?? "");
      }
    });
    window.__obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  });
}
async function waitToast(text) {
  await browser.waitUntil(async () => (await browser.execute(() => window.__toasts.slice())).includes(text), {
    timeout: 8000,
    timeoutMsg: `没等到回执「${text}」;记到的:${JSON.stringify(await browser.execute(() => window.__toasts))}`,
  });
}
async function setField(sel, value) {
  await browser.execute(
    (s, v) => {
      const el = document.querySelector(s);
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    sel,
    value,
  );
}
const keyOn = (sel, key) =>
  browser.execute(
    (s, k) => document.querySelector(s).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })),
    sel,
    key,
  );
async function clickTopicAction(title, label) {
  await browser.execute(
    (t, lbl) => {
      const sec = [...document.querySelectorAll(".v-topics .topic")].find((s) => s.querySelector(".topic-title")?.textContent === t);
      [...sec.querySelectorAll(".tbtn")].find((b) => b.textContent === lbl).click();
    },
    title,
    label,
  );
}
/** 这一行此刻在不在列表的可视区里,连同量到的读数(红了能自证:找没找到、行框与列表上下沿、scrollTop)。 */
const rowGeom = (title) =>
  browser.execute(
    (t) => {
      const list = document.querySelector(".v-topics #list");
      const sec = [...document.querySelectorAll(".v-topics .topic")].find((s) => s.querySelector(".topic-title")?.textContent === t);
      if (!sec) return { inView: false, found: false, scrollTop: list.scrollTop, rows: document.querySelectorAll(".v-topics .topic").length };
      const r = sec.querySelector(".topic-head").getBoundingClientRect();
      const l = list.getBoundingClientRect();
      return { inView: r.top >= l.top - 1 && r.bottom <= l.bottom + 1, found: true, head: [r.top, r.bottom], list: [l.top, l.bottom], scrollTop: list.scrollTop };
    },
    title,
  );
const rowInView = async (title) => (await rowGeom(title)).inView;

describe("W3 159 · 标签(桌面第一波)", () => {
  before(async () => {
    // 凑够一屏放不下的标签,新建的那枚才会排在屏外
    for (let i = 0; i < 30; i++) await invoke("create_topic", { title: `W159-凑数-${String(i).padStart(2, "0")}` });
  });

  it("A8:新建标签 → 回执 + 滚到那一行并闪一下(它排在列表末尾、屏外)", async () => {
    await goNotebook("topics");
    await $(".topic-title*=W159-凑数-00").waitForExist({ timeout: 10000 });
    await armRecorder();
    await browser.execute(() => {
      document.querySelector(".v-topics #list").scrollTop = 0;
    });
    await $("#new-toggle").click();
    await setField("#nt-title", "W159-新建的标签");
    await keyOn("#nt-title", "Enter");
    await waitToast("已建标签「W159-新建的标签」");
    await browser.waitUntil(async () => rowInView("W159-新建的标签"), { timeout: 5000, timeoutMsg: "新建的那一行没滚进眼前" });
    expect(await browser.execute(() => window.__flashes)).toContain("W159-新建的标签");
  });

  it("A8 + Q12:改名 / 改色后列表留在那一行、各给回执;颜色面板没有「完成」、点色点就收起;重命名面板 Esc 能关", async () => {
    const T = "W159-改名前";
    await invoke("create_topic", { title: T });
    await goNotebook("topics");
    await $(`.topic-title*=${T}`).waitForExist({ timeout: 10000 });
    await armRecorder();
    // 滚到底(这一行在末尾)
    await browser.execute(() => {
      const l = document.querySelector(".v-topics #list");
      l.scrollTop = l.scrollHeight;
    });
    expect(await rowInView(T)).toBe(true);

    // Esc 关重命名面板
    await clickTopicAction(T, "重命名");
    await $(".te-title").waitForDisplayed({ timeout: 5000 });
    await keyOn(".te-title", "Escape");
    await $(".topic-edit").waitForExist({ reverse: true, timeout: 5000 });

    // 改名
    await clickTopicAction(T, "重命名");
    await $(".te-title").waitForDisplayed({ timeout: 5000 });
    await setField(".te-title", "W159-改名后");
    await keyOn(".te-title", "Enter");
    await waitToast("已改名为「W159-改名后」");
    await browser.waitUntil(async () => rowInView("W159-改名后"), { timeout: 5000, timeoutMsg: "改名后那一行跑到屏外了" });
    expect(await browser.execute(() => document.querySelector(".v-topics #list").scrollTop)).toBeGreaterThan(0);

    // 整表重画留在原处(不是「跳回顶、再滚回来」):拿列表中段那一行改名,它顶在视口上沿 ——
    // 列表若先归 0 再由 revealRow 补救,会把它滚到正中、scrollTop 变了(末行那条区分不出:滚到正中也钳在最底)。
    const MID = "W159-凑数-15";
    const s0 = await browser.execute((t) => {
      const sec = [...document.querySelectorAll(".v-topics .topic")].find((s) => s.querySelector(".topic-title")?.textContent === t);
      sec.scrollIntoView({ block: "start" });
      return document.querySelector(".v-topics #list").scrollTop;
    }, MID);
    expect(s0).toBeGreaterThan(200);
    // 随机红过(全量里那一行顶比列表顶高约 3px、scrollTop 没动)⇒ 记下改名前的现场,红了自带读数:
    // 那一行改名前离列表顶多远、它上面每一行多高、指针悬在哪一行(悬停会让那一行多出操作钮)。
    const snap = () =>
      browser.execute((t) => {
        const list = document.querySelector(".v-topics #list");
        const secs = [...document.querySelectorAll(".v-topics .topic")];
        const i = secs.findIndex((s) => s.querySelector(".topic-title")?.textContent.startsWith(t));
        return {
          gap: i < 0 ? null : secs[i].querySelector(".topic-head").getBoundingClientRect().top - list.getBoundingClientRect().top,
          above: secs.slice(0, i).map((s) => [s.querySelector(".topic-title")?.textContent, Math.round(s.getBoundingClientRect().height * 100) / 100]),
          hover: document.querySelector(".v-topics .topic:hover .topic-title")?.textContent ?? null,
          listTop: list.getBoundingClientRect().top,
        };
      }, MID);
    const before15 = await snap();
    await clickTopicAction(MID, "重命名");
    await $(".te-title").waitForDisplayed({ timeout: 5000 });
    await setField(".te-title", "W159-凑数-15改");
    await keyOn(".te-title", "Enter");
    await waitToast("已改名为「W159-凑数-15改」");
    const s1 = await browser.execute(() => document.querySelector(".v-topics #list").scrollTop);
    expect(Math.abs(s1 - s0)).toBeLessThanOrEqual(2);
    // ⚠ 别写回 toMatchObject({ inView: true }):它的差异只印期望里那一个键,读数全吞了(165 收口实红一次,啥也没留下)。
    const g15 = await rowGeom("W159-凑数-15改");
    if (!g15.inView) {
      const after15 = await snap();
      const changed = after15.above.filter(([name, h], k) => before15.above[k]?.[0] !== name || before15.above[k]?.[1] !== h);
      throw new Error(
        `改名后那一行不在眼前:${JSON.stringify({ ...g15, s0, s1 })}
  改名前离列表顶 ${before15.gap}px、改名后 ${after15.gap}px;列表顶 ${before15.listTop} → ${after15.listTop};` +
          `悬停行 ${before15.hover} → ${after15.hover};上面高度变了的行(改名后):${JSON.stringify(changed)},改名前同位:${JSON.stringify(changed.map((c) => before15.above[after15.above.indexOf(c)]))}`,
      );
    }

    // 行框顶边被裁掉几像素、名字整个看得见 —— 也算在眼前,改完不跳(W4 T1)。上面那步「贴顶」在 150% 缩放下
    // 也会落成这一形(整表重画还原 scrollTop 后那行高出视口上沿零点几像素),但落不落得上看缩放与取整,
    // 100% 缩放(Linux CI)恒落不上 ⇒ 这里把它摆死:贴顶再往下滚 4px。判据若改回按行框严格比,这一步必跳 290。
    const CLIP = "W159-凑数-10";
    const s2 = await browser.execute((t) => {
      const sec = [...document.querySelectorAll(".v-topics .topic")].find((s) => s.querySelector(".topic-title")?.textContent === t);
      sec.scrollIntoView({ block: "start" });
      const l = document.querySelector(".v-topics #list");
      l.scrollTop += 4;
      return l.scrollTop;
    }, CLIP);
    // 前提自证:行框顶边确实在视口上沿之上,名字整个在里面 —— 否则这一步测的不是这一形。
    const pre = await browser.execute((t) => {
      const sec = [...document.querySelectorAll(".v-topics .topic")].find((s) => s.querySelector(".topic-title")?.textContent === t);
      const l = document.querySelector(".v-topics #list").getBoundingClientRect();
      const h = sec.querySelector(".topic-head").getBoundingClientRect();
      const n = sec.querySelector(".topic-title").getBoundingClientRect();
      return { headClipped: h.top < l.top - 1, nameInView: n.top >= l.top && n.bottom <= l.bottom };
    }, CLIP);
    expect(pre).toEqual({ headClipped: true, nameInView: true });
    await clickTopicAction(CLIP, "重命名");
    await $(".te-title").waitForDisplayed({ timeout: 5000 });
    await setField(".te-title", "W159-凑数-10改");
    await keyOn(".te-title", "Enter");
    await waitToast("已改名为「W159-凑数-10改」");
    const s3 = await browser.execute(() => document.querySelector(".v-topics #list").scrollTop);
    expect(Math.abs(s3 - s2)).toBeLessThanOrEqual(2);

    // 改色:面板里只有色点,没有「完成」;点一个色点 → 收起 + 回执 + 仍在眼前
    await clickTopicAction("W159-改名后", "颜色");
    const panel = await browser.execute((t) => {
      const sec = [...document.querySelectorAll(".v-topics .topic")].find((s) => s.querySelector(".topic-title")?.textContent === t);
      return { swatches: sec.querySelectorAll(".color-swatch").length, buttons: [...sec.querySelectorAll(".topic-actions .tbtn")].map((b) => b.textContent) };
    }, "W159-改名后");
    expect(panel.swatches).toBe(9);
    expect(panel.buttons).toEqual([]);
    await browser.execute((t) => {
      const sec = [...document.querySelectorAll(".v-topics .topic")].find((s) => s.querySelector(".topic-title")?.textContent === t);
      sec.querySelector(".color-swatch:not(.none)").click();
    }, "W159-改名后");
    await waitToast("已给「W159-改名后」换了颜色");
    await browser.waitUntil(async () => rowInView("W159-改名后"), { timeout: 5000, timeoutMsg: "改色后那一行跑到屏外了" });
    expect(await $$(".v-topics .color-swatch").length).toBe(0);

    // 颜色面板 Esc 也收得起
    await clickTopicAction("W159-改名后", "颜色");
    await $(".v-topics .color-swatch").waitForExist({ timeout: 3000 });
    await browser.keys("Escape");
    await $(".v-topics .color-swatch").waitForExist({ reverse: true, timeout: 3000 });
  });

  it("A11 + Q12:撞名 —— 字留在框里、红字在框下、不带「出错:」(新建与改名两处)", async () => {
    const T = "W159-重名";
    await invoke("create_topic", { title: T });
    await invoke("create_topic", { title: "W159-将被改名" });
    await goNotebook("topics");
    await $(`.topic-title*=${T}`).waitForExist({ timeout: 10000 });

    await $("#new-toggle").click();
    await setField("#nt-title", T);
    await keyOn("#nt-title", "Enter");
    await browser.waitUntil(async () => (await $("#nt-err").getText()) !== "", { timeout: 5000 });
    const c = await browser.execute(() => {
      const i = document.querySelector("#nt-title").getBoundingClientRect();
      const e = document.querySelector("#nt-err").getBoundingClientRect();
      return { text: document.querySelector("#nt-err").textContent, value: document.querySelector("#nt-title").value, below: e.top >= i.bottom - 1 };
    });
    expect(c).toEqual({ text: `标签「${T}」已存在`, value: T, below: true });
    // 大小写不同也算撞(core 213e3c7a):报的是已有那枚的原写法,打的小写留在框里
    const lower = T.toLowerCase();
    await browser.execute(() => {
      document.querySelector("#nt-err").textContent = ""; // 上一句红字先抹掉,下面读到的必是这一次的
    });
    await setField("#nt-title", lower);
    await keyOn("#nt-title", "Enter");
    await browser.waitUntil(
      async () => (await browser.execute(() => document.querySelector("#nt-title").value)) === lower && (await $("#nt-err").getText()) !== "",
      { timeout: 5000 },
    );
    expect(await browser.execute(() => [document.querySelector("#nt-err").textContent, document.querySelector("#nt-title").value])).toEqual([
      `标签「${T}」已存在`,
      lower,
    ]);
    expect((await invoke("list_topics")).filter((x) => x.title.toLowerCase() === lower)).toHaveLength(1);
    await keyOn("#nt-title", "Escape");

    await clickTopicAction("W159-将被改名", "重命名");
    await $(".te-title").waitForDisplayed({ timeout: 5000 });
    await setField(".te-title", T);
    await keyOn(".te-title", "Enter");
    await browser.waitUntil(async () => (await $(".te-err").getText()) !== "", { timeout: 5000 });
    const r = await browser.execute(() => {
      const i = document.querySelector(".te-title").getBoundingClientRect();
      const e = document.querySelector(".te-err").getBoundingClientRect();
      return { text: document.querySelector(".te-err").textContent, value: document.querySelector(".te-title").value, below: e.top >= i.bottom - 1 };
    });
    expect(r).toEqual({ text: `标签「${T}」已存在`, value: T, below: true });
    await keyOn(".te-title", "Escape");
  });

  it("A9 + Q3:删除标签 —— 确认说清后果、执行钮不在原位(双击第二下落在「取消」上);做完给回执", async () => {
    const T = "W159-删的标签";
    const ids = [];
    for (const c of ["W159-删标签-随记甲", "W159-删标签-随记乙"]) {
      const id = await invoke("capture_note", { content: c });
      ids.push(id);
    }
    const tid = await invoke("file_note_to_topic", { id: ids[0], topicId: null, newTitle: T });
    await invoke("file_note_to_topic", { id: ids[1], topicId: tid, newTitle: null });
    await goNotebook("topics");
    await $(`.topic-title*=${T}`).waitForExist({ timeout: 10000 });
    await armRecorder();

    // 模拟手快双击:第一下点「删除」,第二下落在同一个坐标上
    const r = await browser.execute((t) => {
      const sec = [...document.querySelectorAll(".v-topics .topic")].find((s) => s.querySelector(".topic-title")?.textContent === t);
      sec.scrollIntoView({ block: "center" });
      const del = [...sec.querySelectorAll(".tbtn")].find((b) => b.textContent === "删除");
      const b = del.getBoundingClientRect();
      const cx = b.left + b.width / 2;
      const cy = b.top + b.height / 2;
      del.click();
      const q = sec.querySelector(".td-q")?.textContent ?? "";
      const under = document.elementFromPoint(cx, cy);
      const underText = under?.textContent ?? "";
      under?.click();
      return { q, underText };
    }, T);
    expect(r.q).toBe(`删除标签「${T}」?2 项只摘掉这枚标签,内容不动`);
    expect(r.underText).toBe("取消");
    expect((await invoke("list_topics")).some((x) => x.title === T)).toBe(true); // 第二下没删掉它

    await clickTopicAction(T, "删除");
    await clickTopicAction(T, "删除"); // 确认态里那枚
    await waitToast(`已删除标签「${T}」`);
    expect((await invoke("list_topics")).some((x) => x.title === T)).toBe(false);
  });

  it("A9 + Q3:合并 —— 确认另起一行说清后果,原「合并」钮置灰(双击第二下什么也不发生);做完给回执", async () => {
    const KEEP = "W159-合并留下";
    const GONE = "W159-合并并掉";
    const k = await invoke("capture_note", { content: "W159-合并-随记K" });
    await invoke("file_note_to_topic", { id: k, topicId: null, newTitle: KEEP });
    const g = await invoke("capture_note", { content: "W159-合并-随记G" });
    await invoke("file_note_to_topic", { id: g, topicId: null, newTitle: GONE });
    await goNotebook("topics");
    await $(`.topic-title*=${KEEP}`).waitForExist({ timeout: 10000 });
    await armRecorder();
    await $("#merge-toggle").click();
    await browser.execute((a, b) => {
      for (const t of [a, b])
        [...document.querySelectorAll(".v-topics .topic")].find((s) => s.querySelector(".topic-title")?.textContent === t).querySelector(".topic-head").click();
    }, KEEP, GONE);

    const r = await browser.execute(() => {
      const m = document.querySelector("#mb-merge");
      m.click();
      const a = m.getBoundingClientRect();
      const y = document.querySelector("#mb-yes").getBoundingClientRect();
      const st = {
        disabled: m.disabled,
        confirm: !document.querySelector("#mb-confirm").hidden,
        q: document.querySelector("#mb-q").textContent,
        // 「并入」不在「合并」头顶(横向错开):真双击时第二下哪怕手抖往上偏一点,也落不到它身上
        apart: y.right < a.left || y.left > a.right,
      };
      m.click(); // 双击的第二下(灰钮:不该并)
      return st;
    });
    expect(r.disabled).toBe(true);
    expect(r.confirm).toBe(true);
    expect(r.apart).toBe(true);
    expect(r.q).toBe(`把「${GONE}」并入「${KEEP}」?1 项转挂「${KEEP}」,「${GONE}」删除`);
    expect((await invoke("list_topics")).some((x) => x.title === GONE)).toBe(true);

    await browser.execute(() => document.querySelector("#mb-yes").click());
    await waitToast(`已合并:「${GONE}」并入「${KEEP}」`);
    expect((await invoke("list_topics")).some((x) => x.title === GONE)).toBe(false);
  });

  it("A16:标签页展开 —— 清单画成方框、长条折八行", async () => {
    const T = "W159-展开看";
    const id = await invoke("capture_note", {
      content: ["W159-展开-清单", "- [ ] 房租", "- [x] 话费", ...Array.from({ length: 20 }, (_, i) => `凑行 ${i}`)].join("\n"),
    });
    await invoke("file_note_to_topic", { id, topicId: null, newTitle: T });
    await goNotebook("topics");
    await $(`.topic-title*=${T}`).waitForExist({ timeout: 10000 });
    await browser.execute((t) => {
      [...document.querySelectorAll(".v-topics .topic")].find((s) => s.querySelector(".topic-title")?.textContent === t).querySelector(".topic-head").click();
    }, T);
    const note = await $(".tnote-text*=W159-展开-清单");
    await note.waitForExist({ timeout: 8000 });
    const r = await browser.execute((p) => ({
      boxes: p.querySelectorAll(".ckline").length,
      raw: p.textContent.includes("- [ ]") || p.textContent.includes("- [x]"),
      clamped: p.classList.contains("clamped"),
      cut: p.scrollHeight > p.clientHeight,
      btn: p.nextElementSibling?.classList.contains("fold-toggle") ?? false,
    }), note);
    expect(r).toEqual({ boxes: 2, raw: false, clamped: true, cut: true, btn: true });
  });

  it("A22:无色标签 —— 标签页名字与有色行对齐;看板卡上那枚与随记卡上那枚长成一个样;窄了两个字的名字不竖排", async () => {
    await invoke("create_topic", { title: "W159-无色" });
    const colored = await invoke("create_topic", { title: "W159-有色" });
    await invoke("set_topic_color", { id: colored, color: "#3f8272" });
    await goNotebook("topics");
    await $(".topic-title*=W159-有色").waitForExist({ timeout: 10000 });
    const x = await browser.execute(() => {
      const left = (t) =>
        [...document.querySelectorAll(".v-topics .topic")]
          .find((s) => s.querySelector(".topic-title")?.textContent === t)
          .querySelector(".topic-title")
          .getBoundingClientRect().left;
      return { plain: left("W159-无色"), tinted: left("W159-有色") };
    });
    expect(Math.abs(x.plain - x.tinted)).toBeLessThan(1);

    // 窄:把列表压到 320 宽,两个字的名字仍是一行
    await invoke("create_topic", { title: "工作" });
    await goNotebook("topics");
    await $(".topic-title=工作").waitForExist({ timeout: 10000 });
    const narrow = await browser.execute(() => {
      document.querySelector(".v-topics #list").style.width = "320px";
      const el = [...document.querySelectorAll(".v-topics .topic-title")].find((e) => e.textContent === "工作");
      const lh = parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.5;
      return { h: el.getBoundingClientRect().height, lh };
    });
    expect(narrow.h).toBeLessThan(narrow.lh * 1.5);

    // 看板卡 vs 随记卡:同一枚无色标签,底色 / 描边 / 字色一样,前面不画东西
    const nid = await invoke("capture_note", { content: "W159-A22 随记" });
    const tagId = (await invoke("list_topics")).find((t) => t.title === "W159-无色").id;
    await invoke("file_note_to_topic", { id: nid, topicId: tagId, newTitle: null });
    const task = await invoke("create_task", { title: "W159-A22 任务" });
    await invoke("add_task_topic", { id: task, topicId: tagId });
    const look = (sel) =>
      browser.execute((s) => {
        const c = document.querySelector(s);
        const cs = getComputedStyle(c);
        const before = getComputedStyle(c, "::before").content;
        return { bg: cs.backgroundColor, border: cs.borderTopColor, color: cs.color, before: before === "none" || before === "normal" ? "" : before };
      }, sel);
    await goNotebook("board");
    await $(".tcard*=W159-A22 任务").waitForExist({ timeout: 10000 });
    await browser.execute(() => {
      const card = [...document.querySelectorAll(".tcard")].find((c) => c.textContent.includes("W159-A22 任务"));
      card.querySelector(".chip.topic.set").id = "w159-board-chip";
    });
    const b = await look("#w159-board-chip");
    await inboxShow("ideas");
    await $(".note*=W159-A22 随记").waitForExist({ timeout: 10000 });
    await browser.execute(() => {
      const card = [...document.querySelectorAll(".note")].find((c) => c.textContent.includes("W159-A22 随记"));
      card.querySelector(".tag").id = "w159-inbox-tag";
    });
    const i = await look("#w159-inbox-tag");
    expect(b).toEqual(i);
    expect(b.before).toBe("");
  });

  it("Q10:挂标签的选择器里子标签写全名(和卡上一致)", async () => {
    await invoke("create_topic", { title: "W159父" });
    await invoke("create_topic", { title: "W159父/汇报" });
    await invoke("capture_note", { content: "W159-Q10 挂标签的那条" });
    await inboxShow("ideas");
    await $(".note*=W159-Q10 挂标签的那条").waitForExist({ timeout: 10000 });
    await inboxAction("W159-Q10 挂标签的那条", "标签");
    await $(".topic-choices .choice.child").waitForExist({ timeout: 5000 });
    const kids = await browser.execute(() =>
      [...document.querySelectorAll(".topic-choices .choice.child")].map((b) => b.textContent).filter((x) => x.includes("汇报")),
    );
    expect(kids).toEqual(["W159父/汇报"]); // 此前是「汇报」两个字(只有后半段)
  });

  it("Q12:「类型」框下一行小字说明类型是干什么的,收起就没了", async () => {
    const T = "W159-类型说明";
    await invoke("create_topic", { title: T });
    await goNotebook("topics");
    await $(`.topic-title*=${T}`).waitForExist({ timeout: 10000 });
    await clickTopicAction(T, "类型");
    const hint = await $(".v-topics .tk-hint");
    await hint.waitForDisplayed({ timeout: 5000 });
    expect(await hint.getText()).toContain("筛选条");
    await keyOn(".tk-input", "Escape");
    await hint.waitForExist({ reverse: true, timeout: 5000 });
  });
});

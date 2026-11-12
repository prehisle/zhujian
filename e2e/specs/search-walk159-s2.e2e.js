import { $, expect, browser } from "@wdio/globals";
import { invoke, goNotebook, inboxShow } from "./support.js";

// W3 走查修复(backlog 用户面 159)桌面第二波 · 搜索 / 筛选 / 回收站时刻 —— 走真后端(单空间就够)的那几条:
//   A4   只在改过的旧版本里命中:结果卡标「命中改过的旧版本」、落点卡写一句去「历史」里看(WD-02)
//   A5   时间轴滚到深处再筛 / 打过滤词 = 回到筛出来那一串的最新那条(顶上);清掉筛选仍回原处(WD-03)
//   A17  从搜索结果点进去、再点侧栏「搜索」回来,词、结果、滚动位置都还在(WD-28)
//   Q8   随记页 / 看板筛着时写「筛出 N 条」、过滤词标红(WD-20)
//   Q9   Ctrl+F 打开搜索、光标进搜索框,快捷键页写着(WD-19)
//   Q12  回收站命中写「回收站 · 任务 / 随记 / 长文」(WD-31);搜索框 ↓ 进第一条、✕ 不进 Tab 序(WD-29)
//   WD-37 两个回收站的卡写「删于 …」(删除时刻,不是创建时刻)
// 多空间那几条(Q4 / A2 / A10 / A12 / Q6 / A11 / WD-39)在 space-walk159-s2.e2e.js。

const TOK = "W159S2";

async function search(q) {
  await browser.execute((v) => {
    const input = document.getElementById("q");
    input.value = v;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }, q);
  await browser.waitUntil(async () => browser.execute(() => !!document.querySelector(".v-search .count")), {
    timeout: 8000,
    timeoutMsg: `搜「${q}」没出结果`,
  });
}
const nav = (view) => browser.execute((v) => document.querySelector(`button[data-view="${v}"]`).click(), view);
const hitBadges = (text) =>
  browser.execute(
    (t) =>
      [...document.querySelectorAll(".v-search .hit")]
        .filter((h) => h.querySelector(".hit-text").textContent.includes(t))
        .map((h) => [...h.querySelectorAll(".badge")].map((b) => b.textContent)),
    text,
  );

describe("W3 159 · 搜索 / 筛选 / 回收站时刻(桌面第二波)", () => {
  after(async () => {
    await inboxShow("ideas");
    await browser.execute(() => {
      const box = document.querySelector("#idea-filter");
      if (box && box.value) {
        box.value = "";
        box.dispatchEvent(new Event("input", { bubbles: true }));
      }
      [...document.querySelectorAll("#idea-topic-filter .tf-pill")].find((p) => p.textContent.startsWith("所有"))?.click();
    });
  });

  it("A4:只在旧版本里命中 → 结果卡标「命中改过的旧版本」,落点卡写一句去「历史」里看;当前命中不标", async () => {
    const old = await invoke("capture_note", { content: `${TOK}-A4 青柠旧词 原来这么写` });
    await invoke("edit_note", { id: old, content: `${TOK}-A4 改过了,新版本里没那个词` });
    await invoke("capture_note", { content: `${TOK}-A4 现在就有 青柠旧词` });

    await goNotebook("search");
    await search("青柠旧词");
    const badges = { old: await hitBadges("改过了"), now: await hitBadges("现在就有") };
    expect(badges).toEqual({ old: [["随记", "命中改过的旧版本"]], now: [["随记"]] });

    // 点旧版本那条:落点卡带常亮高亮,并写着那句旁注
    await browser.execute(() =>
      [...document.querySelectorAll(".v-search .hit")].find((h) => h.textContent.includes("改过了")).click(),
    );
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const c = document.querySelector(".v-inbox .note.just-located");
          return !!c && c.textContent.includes("改过了") && !!c.querySelector(".locate-note");
        }),
      { timeout: 10000, timeoutMsg: "落点卡上没有「去历史里看」那句旁注" },
    );
    const note = await browser.execute(() => document.querySelector(".v-inbox .note.just-located .locate-note").textContent);
    expect(note).toContain("改过之前的版本");
    expect(note).toContain("历史");

    // 当前就命中的那条点进去:没有旁注(旁注只活一次跳转,别串到下一条)
    await nav("search");
    await $(".v-search .hit").waitForExist({ timeout: 8000 });
    await browser.execute(() =>
      [...document.querySelectorAll(".v-search .hit")].find((h) => h.textContent.includes("现在就有")).click(),
    );
    await browser.waitUntil(async () => browser.execute(() => !!document.querySelector(".v-inbox .note.just-located")), {
      timeout: 10000,
    });
    expect(await browser.execute(() => document.querySelectorAll(".v-inbox .locate-note").length)).toBe(0);
  });

  it("Q12:回收站命中写「回收站 · 任务 / 随记 / 长文」,点任务那条进看板回收站", async () => {
    const idea = await invoke("capture_note", { content: `${TOK}-Q12 删掉的随记` });
    await invoke("archive_note", { id: idea });
    const task = await invoke("create_task", { title: `${TOK}-Q12 删掉的任务` });
    await invoke("archive_task", { id: task });
    const doc = await invoke("capture_note", { content: `# ${TOK}-Q12 删掉的长文\n\n正文` });
    await invoke("set_doc", { id: doc, on: true });
    await invoke("archive_note", { id: doc });

    await goNotebook("search");
    await search(`${TOK}-Q12`);
    expect({
      idea: await hitBadges("删掉的随记"),
      task: await hitBadges("删掉的任务"),
      doc: await hitBadges("删掉的长文"),
    }).toEqual({ idea: [["回收站 · 随记"]], task: [["回收站 · 卡片"]], doc: [["回收站 · 长文"]] });

    await browser.execute(() =>
      [...document.querySelectorAll(".v-search .hit")].find((h) => h.textContent.includes("删掉的任务")).click(),
    );
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const c = document.querySelector(".v-board .tcard.archived.just-located");
          return !!c && c.textContent.includes("删掉的任务");
        }),
      { timeout: 10000, timeoutMsg: "回收站里的任务命中没落到看板回收站那张卡上" },
    );
    for (const id of [idea, doc]) await invoke("purge_note", { id });
    await invoke("purge_task", { id: task });
  });

  it("Q12:搜索框里按 ↓ 进第一条、↑ 回框;✕ 不在 Tab 序里(此前 Tab 先落 ✕、回车把词清了)", async () => {
    for (let i = 0; i < 3; i++) await invoke("capture_note", { content: `${TOK}-KEY 第 ${i} 条` });
    await goNotebook("search");
    await search(`${TOK}-KEY`);
    const r = await browser.execute(() => {
      const q = document.getElementById("q");
      q.focus();
      q.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
      const hits = [...document.querySelectorAll(".v-search .hit")];
      const first = document.activeElement === hits[0];
      hits[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
      const second = document.activeElement === hits[1];
      hits[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
      hits[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
      return { first, second, backToBox: document.activeElement === q, clearTab: document.getElementById("clear").tabIndex, value: q.value };
    });
    expect(r).toEqual({ first: true, second: true, backToBox: true, clearTab: -1, value: `${TOK}-KEY` });
  });

  it("A17:搜索结果滚到半截点进去,再点侧栏「搜索」回来 —— 词、结果、滚动位置都还在", async () => {
    for (let i = 0; i < 30; i++) await invoke("capture_note", { content: `${TOK}-A17 流水 ${i}\n第二行\n第三行\n第四行` });
    await goNotebook("search");
    await search(`${TOK}-A17`);
    const top = await browser.execute(() => {
      const l = document.querySelector(".v-search #list");
      l.scrollTop = 900;
      return l.scrollTop;
    });
    expect(top).toBeGreaterThan(400);
    // 点一条眼前的结果(落在可视区里的那张)
    await browser.execute(() => {
      const l = document.querySelector(".v-search #list").getBoundingClientRect();
      const h = [...document.querySelectorAll(".v-search .hit")].find((x) => x.getBoundingClientRect().top > l.top);
      h.click();
    });
    await $(".v-inbox").waitForExist({ timeout: 8000 });
    await nav("search");
    await browser.waitUntil(
      async () =>
        browser.execute(
          (want) => {
            const l = document.querySelector(".v-search #list");
            return !!document.querySelector(".v-search .hit") && Math.abs(l.scrollTop - want) <= 2;
          },
          top,
        ),
      {
        timeout: 8000,
        timeoutMsg: `回到搜索没还原滚动位:want≈${top} got=${await browser.execute(() => document.querySelector(".v-search #list")?.scrollTop)}`,
      },
    );
    expect(await browser.execute(() => document.getElementById("q").value)).toBe(`${TOK}-A17`);
  });

  it("Q9:Ctrl+F 从随记页打开搜索、光标进搜索框;正在改一条的框里不跳;快捷键页写着 Ctrl+F", async () => {
    await inboxShow("ideas");
    await browser.execute(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true })));
    await $(".v-search").waitForExist({ timeout: 8000 });
    await browser.waitUntil(async () => browser.execute(() => document.activeElement?.id === "q"), {
      timeout: 5000,
      timeoutMsg: "Ctrl+F 打开了搜索,可光标没进搜索框",
    });

    // 在编辑一条随记的框里按 Ctrl+F:不跳(跳走 = unmount 只拆监听不存,改了一半的字就丢了)
    const id = await invoke("capture_note", { content: `${TOK}-Q9 正在改的一条` });
    await inboxShow("ideas");
    await $(`.note*=${TOK}-Q9 正在改的一条`).waitForExist({ timeout: 8000 });
    await browser.execute((t) => {
      const n = [...document.querySelectorAll(".v-inbox .note")].find((x) => x.textContent.includes(t));
      n.querySelector(".note-text").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    }, `${TOK}-Q9`);
    await $(".v-inbox .edit-area").waitForExist({ timeout: 5000 });
    const stayed = await browser.execute(() => {
      const a = document.querySelector(".v-inbox .edit-area");
      a.focus();
      const ev = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true });
      a.dispatchEvent(ev);
      return { prevented: ev.defaultPrevented, stillInbox: !!document.querySelector(".v-inbox .edit-area") };
    });
    expect(stayed).toEqual({ prevented: true, stillInbox: true });
    await browser.execute(() => document.querySelector(".v-inbox .edit-area").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await invoke("archive_note", { id });
    await invoke("purge_note", { id });

    // 设置 → 快捷键页
    await browser.execute(() => document.getElementById("settings-entry").click());
    await $(".settings-panel").waitForExist({ timeout: 5000 });
    await browser.execute(() => document.querySelector('.settings-cat[data-cat="hotkeys"]').click());
    const rows = await browser.waitUntil(
      async () =>
        browser
          .execute(() => [...document.querySelectorAll(".keysheet dt")].map((dt) => `${dt.textContent}=${dt.nextElementSibling?.textContent ?? ""}`))
          .then((r) => (r.length ? r : false)),
      { timeout: 8000, timeoutMsg: "设置的快捷键页没打开(速查表一行都没有)" },
    );
    expect(rows.some((r) => r.startsWith("Ctrl+F=") && r.includes("打开搜索"))).toBe(true);
    await browser.execute(() => document.querySelector(".settings-close").click());
    await browser.waitUntil(async () => !(await $(".settings-overlay").isExisting()), { timeout: 5000 });
  });

  it("WD-37:两个回收站的卡都写「删于 …」(删除时刻),不再写创建时刻 / 什么都不写", async () => {
    const idea = await invoke("capture_note", { content: `${TOK}-WD37 随记` });
    await invoke("archive_note", { id: idea });
    const task = await invoke("create_task", { title: `${TOK}-WD37 任务` });
    await invoke("archive_task", { id: task });
    const want = {
      idea: (await invoke("list_archived")).find((r) => r.id === idea).archived_at,
      task: (await invoke("list_archived_tasks")).find((r) => r.id === task).archived_at,
    };
    expect(typeof want.idea).toBe("string");
    expect(typeof want.task).toBe("string");
    // 前端的时间件(when)就地算出期望串,与卡上那行逐字比。165 / W5 Q14 起两端一个写法:今天「今天 15:18」、今年别的天
    // 「11月5日 15:18」、跨年带年(手机 ui.ts::fmtWhen 同规)。
    const fmt = (iso) =>
      browser.execute((s) => {
        const d = new Date(s);
        const now = new Date();
        const p = (n) => String(n).padStart(2, "0");
        const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
        if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
        const md = `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
        return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}年${md}`;
      }, iso);

    await inboxShow("archived");
    const cardIn = (sel, t) => browser.execute((s, x) => [...document.querySelectorAll(s)].some((c) => c.textContent.includes(x)), sel, t);
    await browser.waitUntil(async () => cardIn(".v-inbox .note.archived", `${TOK}-WD37 随记`), { timeout: 8000, timeoutMsg: "随记回收站里没有那条" });
    const ideaTime = await browser.execute((t) => {
      const n = [...document.querySelectorAll(".v-inbox .note.archived")].find((x) => x.textContent.includes(t));
      return n.querySelector(".note-time").firstChild.textContent;
    }, `${TOK}-WD37 随记`);
    expect(ideaTime).toBe(`删于 ${await fmt(want.idea)}`);

    await goNotebook("board");
    await browser.execute(() => document.getElementById("trash-toggle").click());
    await browser.waitUntil(async () => cardIn(".v-board .tcard.archived", `${TOK}-WD37 任务`), { timeout: 8000, timeoutMsg: "看板回收站里没有那张" });
    const taskTime = await browser.execute((t) => {
      const c = [...document.querySelectorAll(".v-board .tcard.archived")].find((x) => x.textContent.includes(t));
      return c.querySelector(".deleted-at")?.textContent ?? "(没有)";
    }, `${TOK}-WD37 任务`);
    expect(taskTime).toBe(`删于 ${await fmt(want.task)}`);
    await browser.execute(() => document.getElementById("trash-toggle").click());
    await invoke("purge_note", { id: idea });
    await invoke("purge_task", { id: task });
  });

  it("Q8 + A5:随记页筛着写「筛出 N 条」、过滤词标红;深处点标签 / 打过滤词回到那一串顶上,清掉回原处", async () => {
    const tag = await invoke("create_topic", { title: `${TOK}-标签` });
    for (let i = 0; i < 40; i++) {
      const id = await invoke("capture_note", { content: `${TOK}-A5 流水 ${i}${i % 4 === 0 ? " 发票" : ""}\n第二行\n第三行` });
      if (i % 2 === 0) await invoke("file_note_to_topic", { id, topicId: tag, newTitle: null });
    }
    await inboxShow("ideas");
    await $(`.note*=${TOK}-A5 流水 39`).waitForExist({ timeout: 10000 });
    const listTop = () => browser.execute(() => document.querySelector(".v-inbox #list").scrollTop);
    const deep = await browser.execute(() => {
      const l = document.querySelector(".v-inbox #list");
      l.scrollTop = l.scrollHeight;
      return l.scrollTop;
    });
    expect(deep).toBeGreaterThan(1500);

    // 点标签:回到筛出来那一串的顶上(此前停在 deep 钳出来的尾巴)
    await browser.execute((t) => [...document.querySelectorAll("#idea-topic-filter .tf-pill")].find((p) => p.textContent.startsWith(t)).click(), `${TOK}-标签`);
    await browser.waitUntil(async () => (await browser.execute(() => document.getElementById("idea-filter-count").textContent)) === "筛出 20 条", {
      timeout: 8000,
      timeoutMsg: `筛标签后条数不对:${await browser.execute(() => document.getElementById("idea-filter-count").textContent)}`,
    });
    expect(await listTop()).toBe(0);

    // 往下滚一截再打过滤词:又回顶上;词标红
    await browser.execute(() => (document.querySelector(".v-inbox #list").scrollTop = 600));
    await browser.execute(() => {
      const box = document.getElementById("idea-filter");
      box.value = "发票";
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await browser.waitUntil(async () => (await browser.execute(() => document.getElementById("idea-filter-count").textContent)) === "筛出 10 条", {
      timeout: 8000,
      timeoutMsg: `打过滤词后条数不对:${await browser.execute(() => document.getElementById("idea-filter-count").textContent)}`,
    });
    expect(await listTop()).toBe(0);
    const marks = await browser.execute(() => {
      const ms = [...document.querySelectorAll(".v-inbox .note-text mark.filter-hit")];
      return { n: ms.length, words: [...new Set(ms.map((m) => m.textContent))] };
    });
    expect(marks).toEqual({ n: 10, words: ["发票"] });

    // 清掉两维:回到筛之前读到的地方(既有规矩,157 G4 / P11),条数收起
    await browser.execute(() => {
      const box = document.getElementById("idea-filter");
      box.value = "";
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await browser.waitUntil(async () => browser.execute(() => document.querySelectorAll(".v-inbox mark.filter-hit").length === 0), { timeout: 8000 });
    await browser.execute(() => [...document.querySelectorAll("#idea-topic-filter .tf-pill")].find((p) => p.textContent.startsWith("所有")).click());
    await browser.waitUntil(async () => browser.execute(() => document.getElementById("idea-filter-count").hidden), { timeout: 8000 });
    await browser.waitUntil(async () => Math.abs((await listTop()) - deep) <= 2, {
      timeout: 5000,
      timeoutMsg: `清掉筛选没回原处:want≈${deep} got=${await listTop()}`,
    });
    await invoke("delete_topic", { id: tag });
  });

  it("Q8:看板筛着写「筛出 N 条」、标题里的过滤词标红", async () => {
    for (const s of ["甲 报销", "乙", "丙 报销"]) await invoke("create_task", { title: `${TOK}-Q8B ${s}` });
    await goNotebook("board");
    await $(`.tcard*=${TOK}-Q8B 乙`).waitForExist({ timeout: 8000 });
    expect(await browser.execute(() => document.getElementById("board-filter-count").hidden)).toBe(true);
    await browser.execute((q) => {
      const box = document.getElementById("board-filter");
      box.value = q;
      box.dispatchEvent(new Event("input", { bubbles: true }));
    }, `${TOK}-Q8B`);
    await browser.waitUntil(async () => (await browser.execute(() => document.getElementById("board-filter-count").textContent)) === "筛出 3 条", {
      timeout: 8000,
    });
    const m = await browser.execute(() => [...document.querySelectorAll(".v-board .ttitle mark.filter-hit")].map((x) => x.textContent));
    expect(m).toEqual(["W159S2-Q8B", "W159S2-Q8B", "W159S2-Q8B"]);
    await browser.execute(() => {
      const box = document.getElementById("board-filter");
      box.value = "";
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await browser.waitUntil(async () => browser.execute(() => document.getElementById("board-filter-count").hidden), { timeout: 8000 });
  });
});

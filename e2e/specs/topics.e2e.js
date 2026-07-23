import { $, expect, browser } from "@wdio/globals";
import { invoke, goNotebook } from "./support.js";

// Seed a tag holding several processed notes by hand: capture each note, then
// file the first into a brand-new topic and the rest into that same topic by id.
// They land processed and filed under that single tag. Returns the note ids.
// (Backend command names still use "topic"; the UI calls it 标签.)
async function seedTopicWithNotes(title, contents) {
  const ids = [];
  let topicId = null;
  for (const c of contents) {
    const id = await invoke("capture_note", { content: c });
    ids.push(id);
    topicId = await invoke("file_note_to_topic", {
      id,
      topicId,
      newTitle: topicId ? null : title,
    });
  }
  return ids;
}

// Set a field deterministically (CJK-safe).
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

// Click a per-tag row action (重命名/删除) — they are opacity:0 until hover, so
// drive them programmatically (the same escape hatch used for other hover reveals).
async function clickTopicAction(topicText, label) {
  await browser.execute(
    (t, lbl) => {
      const sec = [...document.querySelectorAll(".topic")].find((s) => s.textContent.includes(t));
      const btn = [...sec.querySelectorAll(".tbtn")].find((b) => b.textContent === lbl);
      btn.click();
    },
    topicText,
    label,
  );
}

describe("标签 · 浏览与收缩展开", () => {
  it("展开标签 → 看到它名下的想法,再点收起", async () => {
    const T = "E2E-标签-甲";
    await seedTopicWithNotes(T, ["E2E-想法-A1", "E2E-想法-A2"]);

    await goNotebook("topics");
    const sec = await $(`.topic*=${T}`);
    await sec.waitForExist({ timeout: 10000 });

    // The flat row shows a notes/tasks count.
    await expect(sec.$(".topic-count")).toHaveText("2 条灵感 · 0 个任务");

    // Clicking the row expands it INLINE (no separate page) — both notes show under 想法.
    await sec.$(".topic-head").click();
    const noteA1 = await $(".tnote-text*=E2E-想法-A1");
    await noteA1.waitForExist({ timeout: 10000 });
    await expect(noteA1).toBeDisplayed();
    await expect(await $(".tnote-text*=E2E-想法-A2")).toExist();

    // Clicking the row again collapses it (no back button).
    await sec.$(".topic-head").click();
    await (await $(".tnote-text*=E2E-想法-A1")).waitForExist({ reverse: true, timeout: 10000 });
  });

  it("展开 → 看到挂这个标签的任务(标签把想法和任务聚到一起)", async () => {
    const T = "E2E-标签-任务壬";
    const tid = await invoke("create_topic", { title: T });
    await invoke("create_task", { title: "E2E-标签任务-甲", topicId: tid });

    await goNotebook("topics");
    const sec = await $(`.topic*=${T}`);
    await sec.waitForExist({ timeout: 10000 });
    await expect(sec.$(".topic-count")).toHaveText("0 条灵感 · 1 个任务");

    await sec.$(".topic-head").click();
    const task = await $(".dtask-title*=E2E-标签任务-甲");
    await task.waitForExist({ timeout: 10000 });
    await expect(task).toBeDisplayed();
  });

  it("前缀分组:父/子 缩进到父下只显后缀;没有同名父的照平铺显全名", async () => {
    const P = "E2E-父组-丙";
    await invoke("create_topic", { title: P });
    await invoke("create_topic", { title: `${P}/子刊` });
    await invoke("create_topic", { title: "E2E-孤前缀/尾巴" }); // 没有同名父标签

    await goNotebook("topics");
    await (await $(`.topic-title*=${P}`)).waitForExist({ timeout: 10000 });

    // 分组是纯视觉层级:子行带 .child、标题只显后缀、悬停 title 是全名,并收进父行紧跟的
    // .topic-kids 子容器里(父行仍是列表直接子、nextElementSibling = .topic-kids;子标签
    // 建得更晚,不分组的话按「最近变动在前」会排到父前面——收进容器即分组生效)。
    const got = await browser.execute((parent) => {
      const secs = [...document.querySelectorAll(".topic")];
      const byTitle = (txt) => secs.find((s) => s.querySelector(".topic-title").textContent === txt);
      const parentSec = byTitle(parent);
      const childSec = byTitle("子刊");
      const orphanSec = byTitle("E2E-孤前缀/尾巴");
      const kids = parentSec ? parentSec.nextElementSibling : null;
      return {
        parentFlat: parentSec ? !parentSec.classList.contains("child") : null,
        childIndented: childSec ? childSec.classList.contains("child") : null,
        childFullName: childSec ? childSec.querySelector(".topic-title").title : null,
        childInParentKids:
          !!kids && kids.classList.contains("topic-kids") && !!childSec && kids.contains(childSec),
        orphanFlatFullName: orphanSec ? !orphanSec.classList.contains("child") : null,
      };
    }, P);
    expect(got).toEqual({
      parentFlat: true,
      childIndented: true,
      childFullName: `${P}/子刊`,
      childInParentKids: true,
      orphanFlatFullName: true,
    });
  });

  it("想法归档后,空标签仍留在列表里(可管理),计数归零", async () => {
    const content = "E2E-标签-乙-源";
    const [noteId] = await seedTopicWithNotes("E2E-标签-乙", [content]);

    await goNotebook("topics");
    await expect(await $(".topic-title*=E2E-标签-乙")).toExist();

    // Soft-delete its only note. The management list keeps the now-empty tag so it
    // can still be renamed/deleted.
    await invoke("archive_note", { id: noteId });

    await goNotebook("topics");
    const sec = await $(".topic*=E2E-标签-乙");
    await sec.waitForExist({ timeout: 10000 });
    await expect(sec.$(".topic-count")).toHaveText("0 条灵感 · 0 个任务");
  });
});

describe("标签 · 人工维护(CRUD)", () => {
  it("新建标签 → 出现在列表,落库", async () => {
    const T = "E2E-新建-辛";

    await goNotebook("topics");
    await $("#new-toggle").click();
    await $("#nt-title").waitForDisplayed({ timeout: 5000 });
    await setField("#nt-title", T);
    await $("#nt-create").click();

    const sec = await $(`.topic*=${T}`);
    await sec.waitForExist({ timeout: 10000 });

    // Backend is the source of truth: the tag exists.
    const topics = await invoke("list_topics_full");
    expect(topics.some((t) => t.title === T)).toBe(true);
  });

  it("重命名标签 → 改名落库", async () => {
    const id = await invoke("create_topic", { title: "E2E-改前-壬" });

    await goNotebook("topics");
    await (await $(".topic-title*=E2E-改前-壬")).waitForExist({ timeout: 10000 });

    await clickTopicAction("E2E-改前-壬", "重命名");
    await $(".te-title").waitForDisplayed({ timeout: 5000 });
    await setField(".te-title", "E2E-改后-癸");
    await $(".te-actions .go").click();

    await browser.waitUntil(
      async () => {
        const t = (await invoke("list_topics_full")).find((x) => x.id === id);
        return t && t.title === "E2E-改后-癸";
      },
      { timeout: 8000 },
    );
  });

  it("删除标签 → 标签消失,但想法仍在(已归类可查)", async () => {
    const [noteId] = await seedTopicWithNotes("E2E-删标签-子", ["E2E-删标签-源想法"]);

    await goNotebook("topics");
    await (await $(".topic-title*=E2E-删标签-子")).waitForExist({ timeout: 10000 });

    // 删除 is a two-step confirm in the row actions.
    await clickTopicAction("E2E-删标签-子", "删除");
    await clickTopicAction("E2E-删标签-子", "删除"); // confirm

    await browser.waitUntil(
      async () => !(await invoke("list_topics_full")).some((t) => t.title === "E2E-删标签-子"),
      { timeout: 8000 },
    );
    // The note survives — only the tag projection was removed.
    expect((await invoke("list_processed")).some((n) => n.id === noteId)).toBe(true);
  });
});

describe("标签 · 手动排序 + 类型(1c)", () => {
  // 合成 HTML5 拖拽:dragstart 落被拖行的手柄、drop 落目标行 —— clientY 缺省 0 < 目标行中点,
  // 故走 drop-before(插到目标之前),等价真实拖到目标上半区(board-tag-drag 同手法)。
  async function dragTopicBefore(dragTitle, targetTitle) {
    await browser.execute(
      (dt, tt) => {
        const secs = [...document.querySelectorAll(".topic")];
        const byTitle = (txt) => secs.find((s) => s.querySelector(".topic-title")?.textContent === txt);
        const drag = byTitle(dt);
        const target = byTitle(tt);
        const handle = drag.querySelector(".topic-drag");
        const xfer = new DataTransfer();
        handle.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: xfer }));
        target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: xfer }));
        target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: xfer }));
        handle.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: xfer }));
      },
      dragTitle,
      targetTitle,
    );
  }

  it("给标签点类型(人名)→ 徽标显示 + 落库;清除回无类型", async () => {
    const T = "E2E-类型-甲";
    const id = await invoke("create_topic", { title: T });

    await goNotebook("topics");
    await (await $(`.topic-title*=${T}`)).waitForExist({ timeout: 10000 });

    // 打开「类型」→ 输入「人名」→ 保存。
    await clickTopicAction(T, "类型");
    await $(".tk-input").waitForDisplayed({ timeout: 5000 });
    await setField(".tk-input", "人名");
    await clickTopicAction(T, "保存");

    await browser.waitUntil(
      async () => {
        const t = (await invoke("list_topics_full")).find((x) => x.id === id);
        return t && t.kind === "人名";
      },
      { timeout: 8000 },
    );
    const sec = await $(`.topic*=${T}`);
    await expect(sec.$(".topic-kind.on")).toHaveText("人名");

    // 清除 → 回无类型(kind = null)。
    await clickTopicAction(T, "类型");
    await $(".tk-input").waitForDisplayed({ timeout: 5000 });
    await clickTopicAction(T, "清除");
    await browser.waitUntil(
      async () => {
        const t = (await invoke("list_topics_full")).find((x) => x.id === id);
        return t && t.kind === null;
      },
      { timeout: 8000 },
    );
  });

  it("拖动手柄调整标签顺序:把丙拖到甲之前 → 顺序变更并落库", async () => {
    const A = "E2E-序-甲子";
    const B = "E2E-序-乙丑";
    const C = "E2E-序-丙寅";
    const ida = await invoke("create_topic", { title: A });
    const idb = await invoke("create_topic", { title: B });
    const idc = await invoke("create_topic", { title: C });

    await goNotebook("topics");
    await (await $(`.topic-title*=${C}`)).waitForExist({ timeout: 10000 });

    // 建档序 = 甲 乙 丙(新标签落末尾,position 递增)。拖 丙 到 甲 之前 → 丙 甲 乙。
    await dragTopicBefore(C, A);

    await browser.waitUntil(
      async () => {
        const trees = await invoke("list_topics_full");
        const order = trees.filter((t) => [ida, idb, idc].includes(t.id)).map((t) => t.id);
        return order.length === 3 && order[0] === idc && order[1] === ida && order[2] === idb;
      },
      { timeout: 8000 },
    );
  });
});

describe("标签合并(手动把碎标签并成一个)", () => {
  // The merge bar is a bottom footer; in the harness window it can sit below the
  // fold and WebDriver deems it "not interactable" (a window-size artifact). Drive
  // those clicks programmatically, the same escape hatch used elsewhere.
  const clickJs = async (sel) => {
    const elem = await $(sel);
    await elem.waitForExist({ timeout: 10000 });
    await browser.execute((el) => el.click(), elem);
  };

  it("两个标签合并成一个:源标签消失,想法都归到存续标签之下", async () => {
    const KEEP = "E2E-合并-存续丙";
    const GONE = "E2E-合并-并入丁";
    await seedTopicWithNotes(KEEP, ["E2E-合并-想法K"]);
    await seedTopicWithNotes(GONE, ["E2E-合并-想法G"]);

    await goNotebook("topics");
    await (await $(`.topic-title*=${KEEP}`)).waitForExist({ timeout: 10000 });

    // Enter merge mode; select the survivor first (default survivor) then the other.
    await $("#merge-toggle").click();
    await (await $(`.topic*=${KEEP}`)).$(".topic-head").click();
    await (await $(`.topic*=${GONE}`)).$(".topic-head").click();

    // The merge button arms on the first click, commits on the second.
    await clickJs("#mb-merge");
    await clickJs("#mb-merge");

    // The flat list no longer shows notes inline, so verify the merge via the backend:
    // the survivor now holds both notes; the merged-in tag is gone.
    await browser.waitUntil(
      async () => {
        const trees = await invoke("list_topics_full");
        const keep = trees.find((t) => t.title === KEEP);
        const gone = trees.find((t) => t.title === GONE);
        return (
          keep &&
          !gone &&
          keep.notes.length === 2 &&
          keep.notes.some((n) => n.content === "E2E-合并-想法K") &&
          keep.notes.some((n) => n.content === "E2E-合并-想法G")
        );
      },
      { timeout: 10000 },
    );
    await expect(await $(`.topic-title*=${GONE}`)).not.toExist();
  });

  it("合并时可改名,并可点标签块改存续目标", async () => {
    const FIRST = "E2E-改名-先选戊";
    const KEEP = "E2E-改名-后定己";
    await seedTopicWithNotes(FIRST, ["E2E-改名-想法1"]);
    await seedTopicWithNotes(KEEP, ["E2E-改名-想法2"]);

    await goNotebook("topics");
    await (await $(`.topic-title*=${FIRST}`)).waitForExist({ timeout: 10000 });

    await $("#merge-toggle").click();
    // Select FIRST (becomes default survivor) then KEEP.
    await (await $(`.topic*=${FIRST}`)).$(".topic-head").click();
    await (await $(`.topic*=${KEEP}`)).$(".topic-head").click();

    // Re-crown the survivor by clicking KEEP's chip label in the merge bar.
    await clickJs(`.mb-chip-label*=${KEEP}`);

    // Type a fresh title (CJK via execute + input event), then merge.
    const RENAMED = "E2E-改名-合并后庚";
    const rename = await $("#mb-rename");
    await browser.execute(
      (el, v) => {
        el.value = v;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      },
      rename,
      RENAMED,
    );
    await clickJs("#mb-merge");
    await clickJs("#mb-merge");

    // The survivor kept its identity but wears the new title and holds both notes; the
    // other source and the survivor's old title are gone.
    await browser.waitUntil(
      async () => {
        const trees = await invoke("list_topics_full");
        const merged = trees.find((t) => t.title === RENAMED);
        return (
          merged &&
          merged.notes.length === 2 &&
          !trees.some((t) => t.title === FIRST) &&
          !trees.some((t) => t.title === KEEP)
        );
      },
      { timeout: 10000 },
    );
    await (await $(`.topic-title*=${RENAMED}`)).waitForExist({ timeout: 10000 });
  });
});

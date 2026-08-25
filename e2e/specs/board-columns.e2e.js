import { browser, $, $$, expect } from "@wdio/globals";
import { goNotebook, invoke, shownText, tryInvoke } from "./support.js";

// 列管理面(B-f 第 2 段):新建 / 改名 / 拖排序 / 删,以及那几道「不许」。
//
// ⭐ **这一份是 484 欠下的那半字据**:第 1 段收口时明写「自定义列 / 已删列的收容区今天造
// 不出来(写命令面还没接壳)⇒ 那两条路只有代码与注释、没有跑过的字据」。写路径接上之后,
// 「自定义列」那半在这里真跑了;⚠ 「**已删的列还扣着卡**」那半仍然造不出来 —— 那要一枚
// **对端**发来的 tombstone(本端 core 会先拒非空列),桌面 e2e 没有第二台设备。
//
// ⚠ 断言口径一律**落库为准**:`list_board_columns` 是后端的读模型,DOM 只是它的投影。

const listCols = () => invoke("list_board_columns");
const taskCols = async () => (await listCols()).filter((c) => c.kind === "task" && !c.deleted);
const colById = async (id) => (await listCols()).find((c) => c.id === id);

/** 把当前库里所有**自定义**任务列删掉,让每只用例互不干扰(种子六列删不掉,也不该删)。 */
async function clearCustomColumns() {
  for (const c of await listCols()) {
    // 种子四列的 id 是旧字面量;自定义列的 id 是 26 位 ULID —— 但这里不靠 id 形态认人,
    // 靠 core 给的 `deletable`(⛔ 别在测试里重写那条判据),再加「不是种子那四个」。
    if (!c.deletable || c.deleted) continue;
    if (["todo", "doing", "confirming", "done"].includes(c.id)) continue;
    const r = await tryInvoke("delete_board_column", { id: c.id });
    if (!r.ok) throw new Error(`清场删列失败(${c.id}):${r.err}`);
  }
}

/** 打开列管理面(顶栏那枚「管理列」)。 */
async function openManager() {
  await browser.execute(() => document.querySelector("#manage-cols").click());
  await $(".bcm-panel").waitForExist({ timeout: 5000 });
  await $(".bcm-list .bcm-col").waitForExist({ timeout: 5000 });
}

async function closeManager() {
  await browser.execute(() => document.querySelector(".bcm-overlay")?.remove());
}

/** 面板里那一行的 DOM 顺序(= position 顺序的投影)。 */
function managerRowIds() {
  return browser.execute(() => [...document.querySelectorAll(".bcm-list .bcm-col")].map((s) => s.dataset.col));
}

/** 点某一行上文字为 `label` 的那枚钮(⛔ 别按下标点:行里按钮数随 deletable 变)。 */
async function rowButton(colId, label) {
  const found = await browser.execute(
    (id, lbl) => {
      const row = document.querySelector(`.bcm-col[data-col="${id}"]`);
      if (!row) return "no-row";
      const b = [...row.querySelectorAll(".bcm-btn")].find((x) => x.textContent.trim() === lbl);
      if (!b) return "no-btn";
      if (b.disabled) return "disabled";
      b.click();
      return "ok";
    },
    colId,
    label,
  );
  if (found !== "ok") throw new Error(`点「${label}」失败(${colId}):${found}`);
}

describe("看板列管理 · 新建 / 改名 / 排序 / 删", () => {
  // ⚠ **看板一张卡都没有时画的是空态,一枚 `.col` 都不存在**(`board.ts`:
  // `if (visible.length === 0) renderEmpty()`)—— 那是 0036 之前就有的行为,与本案无关。
  // ⇒ 凡是要断言「列身画出来了」的用例,库里必须先有一张卡。种一张、跑完收走。
  const KEEP = "列管理-常驻卡";
  let keepId = null;

  before(async () => {
    await goNotebook("board");
    await clearCustomColumns();
    keepId = await invoke("create_task", { title: KEEP });
    await goNotebook("board");
  });

  after(async () => {
    await closeManager();
    await clearCustomColumns();
    if (keepId) {
      await invoke("archive_task", { id: keepId });
      await invoke("purge_task", { id: keepId });
    }
  });

  it("新建一列 → 落库、落在最右、看板上多出这一列", async () => {
    await goNotebook("board");
    const before = (await taskCols()).length;
    await openManager();
    await browser.execute((v) => {
      const input = document.querySelector(".bcm-new .bcm-col-input");
      input.value = v;
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }, "本周");

    await browser.waitUntil(async () => (await taskCols()).length === before + 1, { timeout: 8000 });
    const cols = await taskCols();
    const made = cols[cols.length - 1];
    expect(made.title).toBe("本周");
    // 新建的列**必在最右**(`create_column` 取全表末键之后,含已 tombstone 的行)。
    expect(made.system).toBe(false);
    expect(made.deletable).toBe(true);
    expect(made.live_items).toBe(0);

    // 看板本体跟着重画(onChanged → load()),⛔ 不是等关掉面板才刷。
    // ⚠ `load()` 是**不等待**的一发(`void load()`),故这里必须先等列身出现再断文字 ——
    // wdio 的 `isDisplayed()` 对**不存在**的元素也只答 false,断言会说成「存在但不可见」。
    await closeManager();
    await $(`.col[data-col="${made.id}"]`).waitForExist({ timeout: 8000 });
    await expect(await shownText($(`.col[data-col="${made.id}"] .col-name`))).toBe("本周");
  });

  it("改名 → 列头与面板都变;⛔ 灵感那两列根本不出现在这一面", async () => {
    await goNotebook("board");
    await openManager();
    const ids = await managerRowIds();
    expect(ids).not.toContain("inbox");
    expect(ids).not.toContain("filed");
    expect(ids).toContain("todo");

    const target = (await taskCols()).find((c) => c.title === "本周");
    await rowButton(target.id, "重命名");
    await browser.execute((v) => {
      const input = document.querySelector(".bcm-col-edit .bcm-col-input");
      input.value = v;
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }, "这一周");
    await browser.waitUntil(async () => (await colById(target.id)).title === "这一周", { timeout: 8000 });

    await closeManager();
    await browser.waitUntil(
      async () => (await $(`.col[data-col="${target.id}"] .col-name`).getText()) === "这一周",
      { timeout: 8000, timeoutMsg: "看板列头没跟着改名重画" },
    );
    await expect(await shownText($(`.col[data-col="${target.id}"] .col-name`))).toBe("这一周");
  });

  it("拖动排序 → 只重写被拖那一列,顺序落库", async () => {
    await goNotebook("board");
    await openManager();
    const before = await managerRowIds();
    const dragId = before[before.length - 1]; // 自定义列在最右
    const targetId = before[0]; // 拖到第一枚之前
    expect(dragId).not.toBe(targetId);

    await browser.execute(
      (d, tgt) => {
        const row = document.querySelector(`.bcm-col[data-col="${d}"]`);
        const target = document.querySelector(`.bcm-col[data-col="${tgt}"]`);
        const handle = row.querySelector(".bcm-col-drag");
        const dt = new DataTransfer();
        handle.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
        // clientY 落在目标行上半 ⇒ 插到它**之前**。
        const y = target.getBoundingClientRect().top + 1;
        target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
        target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
      },
      dragId,
      targetId,
    );

    await browser.waitUntil(
      async () => (await taskCols()).map((c) => c.id)[0] === dragId,
      { timeout: 8000, timeoutMsg: "被拖的那一列没排到最前" },
    );
    // 其余几列的相对次序一格没动(只重写了被拖那一枚)。
    const after = (await taskCols()).map((c) => c.id);
    expect(after.filter((id) => id !== dragId)).toEqual(before.filter((id) => id !== dragId));
  });

  it("列里有卡 → 删除钮是灰的且说清还剩几条;卡移走后才能删", async () => {
    await goNotebook("board");
    const target = (await taskCols()).find((c) => c.title === "这一周");
    const id = await invoke("create_task", { title: "列管理-一张卡" });
    await invoke("update_task_status", { id, to: target.id });
    await goNotebook("board");
    await openManager();

    const del = await browser.execute((cid) => {
      const row = document.querySelector(`.bcm-col[data-col="${cid}"]`);
      const b = [...row.querySelectorAll(".bcm-btn")].find((x) => x.textContent.trim() === "删除");
      return { exists: !!b, disabled: b ? b.disabled : null, title: b ? b.title : null };
    }, target.id);
    expect(del.exists).toBe(true);
    expect(del.disabled).toBe(true);
    expect(del.title).toContain("1");

    // 后端那道才是真的:直接调命令也必须被拒(⛔ UI 灰按钮不是闸)。
    const refused = await tryInvoke("delete_board_column", { id: target.id });
    expect(refused.ok).toBe(false);
    expect(refused.err).toContain("请先移走再删除");

    // 把卡移走 → 面板重开,删除可点,删掉之后库里那一行还在(墓碑)但看板不再画它。
    await invoke("update_task_status", { id, to: "todo" });
    await goNotebook("board");
    await openManager();
    await rowButton(target.id, "删除");
    await rowButton(target.id, "删除"); // 行内两段式确认
    await browser.waitUntil(async () => (await colById(target.id)).deleted === true, { timeout: 8000 });

    await closeManager();
    await expect($(`.col[data-col="${target.id}"]`)).not.toExist();
    await invoke("archive_task", { id });
    await invoke("purge_task", { id });
  });

  it("⛔ 「待办」与「已完成」不给删除钮(挂着产品语义),但改名照旧", async () => {
    await goNotebook("board");
    await openManager();
    for (const id of ["todo", "done"]) {
      const has = await browser.execute((cid) => {
        const row = document.querySelector(`.bcm-col[data-col="${cid}"]`);
        return [...row.querySelectorAll(".bcm-btn")].map((x) => x.textContent.trim());
      }, id);
      expect(has).toContain("重命名");
      expect(has).not.toContain("删除");
      // 后端同判:命令层也拒(UI 不给钮**不是**那道闸)。
      const r = await tryInvoke("delete_board_column", { id });
      expect(r.ok).toBe(false);
      expect(r.err).toContain("不可删除");
    }

    // 改名照旧合法:id 没变,挂在这一列上的语义一格都没动。改完立刻改回去
    // (`title` 与 canonical 相等 ⇒ `title_overridden` 翻回 false,列名回到本端字典那份)。
    await rowButton("todo", "重命名");
    await browser.execute(() => {
      const input = document.querySelector(".bcm-col-edit .bcm-col-input");
      input.value = "本周待办";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await browser.waitUntil(async () => (await colById("todo")).title_overridden === true, { timeout: 8000 });
    expect((await colById("todo")).title).toBe("本周待办");

    await rowButton("todo", "重命名");
    await browser.execute(() => {
      const input = document.querySelector(".bcm-col-edit .bcm-col-input");
      input.value = "待办";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await browser.waitUntil(async () => (await colById("todo")).title_overridden === false, { timeout: 8000 });
    await closeManager();
  });

  it("空名不发命令,只报一句;闸在本地库上是开的", async () => {
    await goNotebook("board");
    await openManager();
    const before = (await taskCols()).length;
    await browser.execute(() => {
      const input = document.querySelector(".bcm-new .bcm-col-input");
      input.value = "   ";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await expect(await shownText($(".bcm-err"))).toContain("列名");
    expect((await taskCols()).length).toBe(before);

    // 只读探针:这台 e2e 库是纯本地空间(没配过账户)⇒ 闸放行、面板给写入口。
    const gate = await invoke("board_column_gate");
    expect(gate.can_manage).toBe(true);
    expect(gate.reason).toBe(null);
    expect(gate.blocked_by).toBe(null);
    await expect($(".bcm-shut")).not.toExist();
    await expect($(".bcm-new")).toExist();
    await closeManager();
  });
});

void $$;

import { $, expect, browser } from "@wdio/globals";
import { invoke, goNotebook, boardPickTopicPill } from "./support.js";

// 筛选条里父子标签折叠(共享件 filter-bar.ts,看板/灵感同源——这里覆盖看板侧接线):
// `父/子` 前缀且存在同名父 → 子标签 pill 收到父 pill 下,默认收起(不显),点父 pill 上的
// 小箭头 ▸/▾ 展开/收起;点 pill 主体照常筛选(两不打架)。
describe("任务看板 · 筛选条父子标签折叠", () => {
  const P = "E2E-折叠父";
  const CHILD = `${P}/子端`;
  let pid, cid;
  const ids = [];

  const childState = () =>
    browser.execute((c) => {
      const pill = document.querySelector(`.tf-pill.child[data-topic-id="${c}"]`);
      return {
        exists: !!pill,
        hidden: pill ? pill.classList.contains("hidden") : null,
        // 展开后显后缀(子端),不是全名(父/子端)。
        label: pill ? pill.textContent.replace(/[0-9]/g, "").trim() : null,
      };
    }, cid);
  const clickCaret = () =>
    browser.execute((p) => {
      document.querySelector(`.tf-pill[data-topic-id="${p}"] .tf-caret`).click();
    }, pid);

  before(async () => {
    pid = await invoke("create_topic", { title: P });
    cid = await invoke("create_topic", { title: CHILD });
    ids.push(await invoke("create_task", { title: "E2E-折叠-父任务", topicId: pid }));
    ids.push(await invoke("create_task", { title: "E2E-折叠-子任务", topicId: cid }));
    await goNotebook("board");
    await $(`.tf-pill[data-topic-id="${pid}"]`).waitForExist({ timeout: 10000 });
  });

  after(async () => {
    for (const id of ids) {
      await invoke("archive_task", { id });
      await invoke("purge_task", { id });
    }
    await invoke("delete_topic", { id: cid });
    await invoke("delete_topic", { id: pid });
  });

  it("默认收起:父 pill 带箭头,子标签 pill 存在但隐藏", async () => {
    // 父 pill 上有展开箭头。
    expect(
      await browser.execute(
        (p) => !!document.querySelector(`.tf-pill[data-topic-id="${p}"] .tf-caret`),
        pid,
      ),
    ).toBe(true);
    // 子 pill 在 DOM 里(供直接翻显隐)但默认 hidden、且显后缀名。
    const s = await childState();
    expect(s.exists).toBe(true);
    expect(s.hidden).toBe(true);
    expect(s.label).toBe("子端");
  });

  it("点箭头 → 展开(子标签显);再点 → 收起", async () => {
    await clickCaret();
    await browser.waitUntil(async () => (await childState()).hidden === false, {
      timeout: 8000,
      timeoutMsg: "点箭头后子标签未显",
    });
    await clickCaret();
    await browser.waitUntil(async () => (await childState()).hidden === true, {
      timeout: 8000,
      timeoutMsg: "再点箭头后子标签未收起",
    });
  });

  it("点父 pill 主体 = 筛选(不误触展开)", async () => {
    // 收起态点父 pill 主体:筛到父标签(父 pill active),子标签仍收起(点的是主体不是箭头)。
    await browser.execute((p) => {
      document.querySelector(`.tf-pill[data-topic-id="${p}"]`).click();
    }, pid);
    await browser.waitUntil(
      async () =>
        browser.execute(
          (p) => document.querySelector(`.tf-pill[data-topic-id="${p}"]`).classList.contains("active"),
          pid,
        ),
      { timeout: 8000, timeoutMsg: "点父 pill 主体未筛选" },
    );
    // 复位到「所有」,别把选态泄漏给后续 spec。⚠ 同 board-multitag 那处:475 补之前
    // 这一句被时间轴截胡,静默没复位(共享件的头注记着整条判例)。
    await boardPickTopicPill("所有");
  });
});

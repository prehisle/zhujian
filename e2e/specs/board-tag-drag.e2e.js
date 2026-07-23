import { browser, $, expect } from "@wdio/globals";
import { invoke, goNotebook } from "./support.js";

// 拖拽打标签(1a/1b):任务卡拖到标签 pill、或标签 pill 拖到任务卡,松手即打上该标签。
// 合成 HTML5 拖拽(同 board.e2e.js 的 escape hatch):看板从自己的闭包读被拖对象
// (卡片=dragging / 标签=draggingTopic,均在 dragstart 置),故合成事件走的是与真实
// 指针拖拽一模一样的代码路径。落库判据仍是后端 list_tasks(DOM 由拖拽驱动、库是真相)。
async function dragCardToPill(taskTitle, topicId) {
  await browser.execute(
    (title, tid) => {
      const card = [...document.querySelectorAll(".tcard")].find((c) => c.textContent.includes(title));
      const pill = document.querySelector(`.tf-pill[data-topic-id="${tid}"]`);
      const dt = new DataTransfer();
      card.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
      pill.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
      pill.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
      card.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
    },
    taskTitle,
    topicId,
  );
}
async function dragPillToCard(topicId, taskTitle) {
  await browser.execute(
    (tid, title) => {
      const pill = document.querySelector(`.tf-pill[data-topic-id="${tid}"]`);
      const card = [...document.querySelectorAll(".tcard")].find((c) => c.textContent.includes(title));
      const dt = new DataTransfer();
      pill.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
      card.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
      card.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
      pill.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
    },
    topicId,
    taskTitle,
  );
}

describe("任务看板 · 拖拽打标签(卡 ↔ 标签 pill 双向)", () => {
  const TASK = "E2E-拖签任务";
  const ANCHOR = "E2E-拖签锚点";
  const A = "E2E-拖签-甲";
  const B = "E2E-拖签-乙";
  let idA, idB, taskId;

  // 后端真相:TASK 当前挂的标签名(排序)。
  const tagTitles = async () => {
    const t = (await invoke("list_tasks")).find((x) => x.id === taskId);
    return (t?.topics ?? []).map((tp) => tp.title).sort();
  };

  before(async () => {
    idA = await invoke("create_topic", { title: A });
    idB = await invoke("create_topic", { title: B });
    // 锚点任务同时挂 A、B,让两个 pill 都渲出来(0 计数的标签 pill 会被隐藏)。
    const anchor = await invoke("create_task", { title: ANCHOR, topicId: idA });
    await invoke("add_task_topic", { id: anchor, topicId: idB });
    taskId = await invoke("create_task", { title: TASK, topicId: null }); // 生而无标签
    await goNotebook("board");
    await $(`.tcard*=${TASK}`).waitForExist({ timeout: 10000 });
    await $(`.tf-pill[data-topic-id="${idA}"]`).waitForExist({ timeout: 5000 });
  });

  it("任务卡拖到标签 pill → 打上该标签", async () => {
    expect(await tagTitles()).toEqual([]); // 起点无标签
    await dragCardToPill(TASK, idA);
    await browser.waitUntil(async () => (await tagTitles()).includes(A), {
      timeout: 8000,
      timeoutMsg: "卡→pill 未打上标签",
    });
    expect(await tagTitles()).toEqual([A]);
  });

  it("标签 pill 拖到任务卡 → 打上该标签(与已有共存,不是替换)", async () => {
    await $(`.tf-pill[data-topic-id="${idB}"]`).waitForExist({ timeout: 5000 });
    await dragPillToCard(idB, TASK);
    await browser.waitUntil(async () => (await tagTitles()).includes(B), {
      timeout: 8000,
      timeoutMsg: "pill→卡 未打上标签",
    });
    expect(await tagTitles()).toEqual([A, B].sort());
  });

  it("再拖一个已挂的标签 → 幂等:标签不变、不弹错误横幅", async () => {
    await dragCardToPill(TASK, idA); // A 已在 → dropTagOnTask 里 taskHasTopic 命中,不落库
    await browser.pause(300); // 给「若真误发」一点落库+报错的时间
    expect(await tagTitles()).toEqual([A, B].sort());
    await expect($("#op-err")).not.toBeDisplayed(); // 没走后端 → 没有报错横幅
  });
});

import { browser, $, expect } from "@wdio/globals";
import { invoke, inboxShow, clearInbox } from "./support.js";

// 随记 · 拖拽打标签(用户面 92 第三半):随记卡拖到标签 pill、或标签 pill 拖到随记卡,松手即
// 打上该标签。board-tag-drag.e2e.js 的镜像 —— 同一套合成 HTML5 拖拽(escape hatch):随记从自己
// 的闭包读被拖对象(卡片=dragging / 标签=draggingTopic,均在 dragstart 置),故合成事件走的
// 是与真实指针拖拽一模一样的处理器路径。落库判据仍是后端 list_ideas(DOM 由拖拽驱动、库是真相)。
// ⚠ 合成事件证的是「处理器接上了」;「按住正文是选字、按住卡边才是拖卡」那一格是引擎判定
//   (Blink 找拖源时遇到可选中的文字就改起选区),要在真 WebView2 上用 CDP 看,不在这里。
async function dragNoteToPill(noteText, topicId) {
  await browser.execute(
    (text, tid) => {
      const card = [...document.querySelectorAll(".note")].find((c) => c.textContent.includes(text));
      const pill = document.querySelector(`.tf-pill[data-topic-id="${tid}"]`);
      const dt = new DataTransfer();
      card.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
      pill.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
      pill.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
      card.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
    },
    noteText,
    topicId,
  );
}
async function dragPillToNote(topicId, noteText) {
  await browser.execute(
    (tid, text) => {
      const pill = document.querySelector(`.tf-pill[data-topic-id="${tid}"]`);
      const card = [...document.querySelectorAll(".note")].find((c) => c.textContent.includes(text));
      const dt = new DataTransfer();
      pill.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
      card.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
      card.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
      pill.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
    },
    topicId,
    noteText,
  );
}

describe("随记 · 拖拽打标签(卡 ↔ 标签 pill 双向)", () => {
  const NOTE = "E2E-随记拖签想法";
  const ANCHOR = "E2E-随记拖签锚点";
  const A = "E2E-随记拖签-甲";
  const B = "E2E-随记拖签-乙";
  let idA, idB, noteId;

  // 后端真相:NOTE 当前挂的标签名(排序;随记的标签走 list_ideas 的 topics)。
  const tagTitles = async () => {
    const n = (await invoke("list_ideas")).find((x) => x.id === noteId);
    return (n?.topics ?? []).map((tp) => tp.title).sort();
  };

  before(async () => {
    // 幂等 seed(specFileRetries 重跑时库里可能已有甲 / 乙):按名取既有,没有才建。
    const topics = await invoke("list_topics");
    const ensure = async (title) =>
      topics.find((t) => t.title === title)?.id ?? (await invoke("create_topic", { title }));
    idA = await ensure(A);
    idB = await ensure(B);
    // 清空想法列表再播:锚点随记同时挂甲、乙,让两枚 pill 都渲出来(整族零内容的标签不画);
    // NOTE 生而无标签。先建后导航:直接 IPC 建条目不会推动已挂载视图刷新。
    await clearInbox();
    const anchor = await invoke("capture_note", { content: ANCHOR });
    await invoke("file_note_to_topic", { id: anchor, topicId: idA, newTitle: null });
    await invoke("file_note_to_topic", { id: anchor, topicId: idB, newTitle: null });
    noteId = await invoke("capture_note", { content: NOTE });
    await inboxShow("ideas");
    await $(`.note*=${NOTE}`).waitForExist({ timeout: 10000 });
    await $(`.tf-pill[data-topic-id="${idA}"]`).waitForExist({ timeout: 5000 });
  });

  it("字与纸分家:按在正文上那一按不拖卡(松开即恢复),按在时间行上照拖", async () => {
    // 静态事实:卡片 draggable=true(拖源),正文算出来的 user-select 是 text(inbox.css 在卡片
    // 身上开回来的,字上才是 I 形光标)。动态事实:mousedown 落在正文上 ⇒ draggable 临时关掉
    // (这一按走选字),mouseup 恢复;落在时间行上 ⇒ 照旧是拖源。⚠ 这里证的是处理器;「关掉之后
    // 引擎真的改起选区」那格是引擎判定,本轮用 CDP 在真 WebView2 上量过(progress-log 671)。
    const facts = await browser.execute((text) => {
      const card = [...document.querySelectorAll(".note")].find((c) => c.textContent.includes(text));
      const cs = getComputedStyle(card.querySelector(".note-text"));
      const out = { atRest: card.draggable, select: cs.userSelect || cs.webkitUserSelect };
      card.querySelector(".note-text").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      out.pressedOnText = card.draggable;
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
      out.released = card.draggable;
      card.querySelector(".note-time").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      out.pressedOnTime = card.draggable;
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
      return out;
    }, NOTE);
    expect(facts).toEqual({ atRest: true, select: "text", pressedOnText: false, released: true, pressedOnTime: true });
  });

  it("随记卡拖到标签 pill → 打上该标签", async () => {
    expect(await tagTitles()).toEqual([]); // 起点无标签
    await dragNoteToPill(NOTE, idA);
    await browser.waitUntil(async () => (await tagTitles()).includes(A), {
      timeout: 8000,
      timeoutMsg: "卡→pill 未打上标签",
    });
    expect(await tagTitles()).toEqual([A]);
  });

  it("标签 pill 拖到随记卡 → 打上该标签(与已有共存,不是替换)", async () => {
    await $(`.tf-pill[data-topic-id="${idB}"]`).waitForExist({ timeout: 5000 });
    await dragPillToNote(idB, NOTE);
    await browser.waitUntil(async () => (await tagTitles()).includes(B), {
      timeout: 8000,
      timeoutMsg: "pill→卡 未打上标签",
    });
    expect(await tagTitles()).toEqual([A, B].sort());
  });

  it("再拖一个已挂的标签 → 幂等:标签不变、卡上不冒错误行", async () => {
    await dragNoteToPill(NOTE, idA); // 甲已在 → 落点判据与 dropTagOnNote 都挡住,不落库
    await browser.pause(300); // 给「若真误发」一点落库 + 报错的时间
    expect(await tagTitles()).toEqual([A, B].sort());
    // 没走后端 → 那张卡上没有就地错误行(file_note_to_topic 重复挂会撞 link 唯一键并报错)。
    const card = await $(`.note*=${NOTE}`);
    await expect(card.$(".form-err")).not.toBeDisplayed();
  });
});

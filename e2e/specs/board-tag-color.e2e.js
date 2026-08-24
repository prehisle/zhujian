import { $, expect, browser } from "@wdio/globals";
import { invoke, goNotebook } from "./support.js";

// 标签颜色(同步字段 color)在界面上的呈现:
//   · 看板卡片上有色标签的 chip 着色(.tinted + --tag-color=该色),清色回默认 pill;
//   · 筛选条里该标签的钮带一颗同色色点(.tf-dot);
//   · 标签视图:⋯「颜色」的调色板点一下就落色、行首色点亮起,选「无」清色。
// 并在最后存一张看板截图,供人工看实物(纸墨底 + 少量点色的观感)。

// 标签视图里那一行的行首色点,读成一个值:`false` = 没挂 `.on`(= 无色/还没重渲),
// 有色时 = 它身上的 `--tag-color`。两种失败因此在失败信息里分得开(455)。
function readDot(tag) {
  return browser.execute((t) => {
    const sec = [...document.querySelectorAll(".topic")].find((s) => s.querySelector(".topic-title")?.textContent === t);
    if (!sec) return "该标签的行不在标签视图里";
    const dot = sec.querySelector(".topic-dot");
    return dot.classList.contains("on") && dot.style.getPropertyValue("--tag-color").trim();
  }, tag);
}

describe("标签颜色 · 看板呈现", () => {
  const TAG = "E2E-颜色标签";
  const HEX = "#3f7a99"; // 黛蓝
  const TASK = "E2E-带色任务";
  let topicId;

  before(async () => {
    topicId = await invoke("create_topic", { title: TAG });
    await invoke("set_topic_color", { id: topicId, color: HEX });
    await invoke("create_task", { title: TASK, topicId });
    await goNotebook("board");
    await $(`.tcard*=${TASK}`).waitForExist({ timeout: 10000 });
  });

  it("卡片上有色标签的 chip 着色(.tinted + --tag-color=该色)", async () => {
    const info = await browser.execute((task) => {
      const card = [...document.querySelectorAll(".tcard")].find((c) => c.textContent.includes(task));
      const chip = card.querySelector(".chip.topic.set");
      return { tinted: chip.classList.contains("tinted"), varColor: chip.style.getPropertyValue("--tag-color").trim() };
    }, TASK);
    expect(info.tinted).toBe(true);
    expect(info.varColor).toBe(HEX);
  });

  it("筛选条里该标签的钮带一颗同色的色点(.tf-dot)", async () => {
    const dotColor = await browser.execute((tag) => {
      // ⛔ 限定标签轴:`.tf-pill` 在筛选行里不唯一(support.js pickTopicPill 头注)。
      const pill = [...document.querySelectorAll("#topic-filter .tf-pill")].find((p) => p.textContent.includes(tag));
      const dot = pill?.querySelector(".tf-dot");
      return dot ? dot.style.getPropertyValue("--tag-color").trim() : null;
    }, TAG);
    expect(dotColor).toBe(HEX);
  });

  it("清色后 chip 回到默认 pill(无 .tinted),再设回有色", async () => {
    await invoke("set_topic_color", { id: topicId, color: null });
    await goNotebook("board");
    await $(`.tcard*=${TASK}`).waitForExist({ timeout: 10000 });
    const tinted = await browser.execute((task) => {
      const card = [...document.querySelectorAll(".tcard")].find((c) => c.textContent.includes(task));
      return card.querySelector(".chip.topic.set").classList.contains("tinted");
    }, TASK);
    expect(tinted).toBe(false);
    // 复原成有色。
    await invoke("set_topic_color", { id: topicId, color: HEX });
    await goNotebook("board");
    await $(`.tcard*=${TASK}`).waitForExist({ timeout: 10000 });
  });
});

describe("标签颜色 · 灵感卡呈现", () => {
  const TAG = "E2E-灵感色标签";
  const HEX = "#a8577e"; // 绛红
  const IDEA = "E2E-带色灵感";

  before(async () => {
    const topicId = await invoke("create_topic", { title: TAG });
    await invoke("set_topic_color", { id: topicId, color: HEX });
    const ideaId = await invoke("capture_note", { content: IDEA });
    await invoke("file_note_to_topic", { id: ideaId, topicId, newTitle: null }); // 归类=打上该标签
    await goNotebook("inbox");
    await $(`.note*=${IDEA}`).waitForExist({ timeout: 10000 });
  });

  it("灵感卡上有色标签的 chip 着色(.tag.tinted + --tag-color=该色)", async () => {
    const info = await browser.execute((idea) => {
      const card = [...document.querySelectorAll(".note")].find((c) => c.textContent.includes(idea));
      const tag = card.querySelector(".tag");
      return { tinted: tag.classList.contains("tinted"), varColor: tag.style.getPropertyValue("--tag-color").trim() };
    }, IDEA);
    expect(info.tinted).toBe(true);
    expect(info.varColor).toBe(HEX);
  });
});

describe("标签颜色 · 标签视图设色/清色", () => {
  const TAG = "E2E-视图设色";
  const HEX = "#7f8b3a"; // 苔绿
  let topicId;

  before(async () => {
    topicId = await invoke("create_topic", { title: TAG });
    await goNotebook("topics");
    await $(`.topic-title=${TAG}`).waitForExist({ timeout: 8000 });
  });

  it("⋯「颜色」→ 点色块 → 后端落色 + 行首色点亮起", async () => {
    // .topic-actions 悬停才显(opacity),但 JS .click() 不受 opacity 影响 —— 直接点。
    await browser.execute((tag) => {
      const sec = [...document.querySelectorAll(".topic")].find((s) => s.querySelector(".topic-title")?.textContent === tag);
      [...sec.querySelectorAll(".tbtn")].find((b) => b.textContent === "颜色").click();
    }, TAG);
    await browser.execute((tag, hex) => {
      const sec = [...document.querySelectorAll(".topic")].find((s) => s.querySelector(".topic-title")?.textContent === tag);
      [...sec.querySelectorAll(".color-swatch")].find((b) => b.style.getPropertyValue("--tag-color").trim() === hex).click();
    }, TAG, HEX);

    await browser.waitUntil(
      async () => (await invoke("list_topics")).find((t) => t.id === topicId)?.color === HEX,
      { timeout: 8000, timeoutMsg: "点色块后后端未落色" },
    );
    // ⛔ **别只等后端就直接读 DOM**(454 那次 Linux CI 红就是这么来的,backlog「测试与工装 29」):
    // 上一句 `waitUntil` 等的是 `list_topics` 里 color 落了,而下面读的是 **DOM**,两者之间隔着
    // 一次重渲 ⇒ 断言可能早到一拍,收到的是 `false`(= `.on` 还没挂上),看着却像「颜色错了」。
    // = memory `flaky-test-three-shapes`「**等的东西和读的东西不是一件事**」。
    // ⛔ 修法不是加超时:把等待条件挪到**读的那一侧**。两条都留 ⇒ 判据不削反增
    //(后端那条先落,DOM 这条再等它跟上;哪一格没到,timeoutMsg 分得开)。
    let dotOn;
    await browser.waitUntil(
      async () => {
        dotOn = await readDot(TAG);
        return dotOn === HEX;
      },
      { timeout: 8000, timeoutMsg: "后端已落色,但行首色点没跟上(false=.on 未挂;别的值=颜色不对)" },
    );
    expect(dotOn).toBe(HEX);
  });

  it("⋯「颜色」→ 点「无」→ 清色,行首色点隐去", async () => {
    await browser.execute((tag) => {
      const sec = [...document.querySelectorAll(".topic")].find((s) => s.querySelector(".topic-title")?.textContent === tag);
      [...sec.querySelectorAll(".tbtn")].find((b) => b.textContent === "颜色").click();
    }, TAG);
    await browser.execute((tag) => {
      const sec = [...document.querySelectorAll(".topic")].find((s) => s.querySelector(".topic-title")?.textContent === tag);
      sec.querySelector(".color-swatch.none").click();
    }, TAG);
    await browser.waitUntil(
      async () => (await invoke("list_topics")).find((t) => t.id === topicId)?.color == null,
      { timeout: 8000, timeoutMsg: "点「无」后后端未清色" },
    );
    // 例①同一条纪律的另一半:这只测的**名字**里写着「行首色点隐去」,而 455 之前它
    // 只断了后端 ⇒ 名字承诺的那一半从来没被验过。同样等在 DOM 那一侧。
    let dotOff;
    await browser.waitUntil(
      async () => {
        dotOff = await readDot(TAG);
        return dotOff === false;
      },
      { timeout: 8000, timeoutMsg: "后端已清色,但行首色点还亮着(.on 没摘掉)" },
    );
    expect(dotOff).toBe(false);
  });
});

import { $, $$, browser } from "@wdio/globals";
import { invoke, goNotebook, clearInbox, inboxAction } from "../specs/support.js";

// 按需探针(默认套件扫不到,要 `--spec` 点名):把留言就地展开的几个态各截一张,给
// 「门禁全绿 ≠ 长得对」那一关用。**有真副作用**:清空灵感 + 造几条条目与留言。
const SHOT = (n) => `G:/tmp/shot-${n}.png`;

async function theme(mode) {
  await browser.execute((m) => {
    localStorage.setItem("ys-theme", m);
    document.documentElement.dataset.theme = m;
  }, mode);
}

describe("探针 · 留言就地展开的各态截图", () => {
  before(async () => {
    await goNotebook("inbox");
    await clearInbox();
  });

  it("随记:收起 / 展开(一条)/ 展开(空)三态 + 暗色", async () => {
    const a = await invoke("capture_note", { content: "https://freemodel.dev/" });
    await invoke("add_item_comment", { itemId: a, content: "这个站点能白嫖模型,回头试试接口稳不稳" });
    await invoke("capture_note", { content: "周末把阳台的花搬进来" });
    await browser.execute(() => document.querySelector('.sidebar nav button[data-view="board"]').click());
    await browser.execute(() => document.querySelector('.sidebar nav button[data-view="inbox"]').click());
    await $(".cm-badge").waitForExist({ timeout: 5000 });
    await browser.saveScreenshot(SHOT("1-collapsed"));

    await $(".cm-badge").click();
    await $(".cm-item").waitForExist({ timeout: 5000 });
    await browser.saveScreenshot(SHOT("2-expanded"));

    // 再写一条,看多条时的排布(以及重挂后的样子)。
    await $(".cm-input").setValue("接口试过了,免费额度够用");
    await $(".cm-send").click();
    await browser.waitUntil(async () => (await $$(".cm-item")).length === 2, { timeout: 5000 });
    // ⚠ 等入场动画跑完再截。写一条 → 整列重渲 ⇒ 每张卡都是新 DOM ⇒ 全体重播 .note 的
    // rise(0.3s 淡入)。不等的话截到的是半透明的中间帧,拿它评「长得对不对」会看错。
    await browser.pause(500);
    await browser.saveScreenshot(SHOT("3-two"));

    await theme("dark");
    await browser.pause(200);
    await browser.saveScreenshot(SHOT("4-dark"));
    await theme("light");
    await browser.keys("Escape");

    // 空态:N=0 的那条从 ⋯ 菜单开(徽章不存在时的唯一入口)。
    await inboxAction("周末把阳台的花搬进来", "留言");
    await $(".cm-empty").waitForExist({ timeout: 5000 });
    await browser.saveScreenshot(SHOT("5-empty"));
    await browser.keys("Escape");
  });

  it("看板:浮层那一形没被动过", async () => {
    const t = await invoke("create_task", { title: "把季度复盘写完" });
    await invoke("add_item_comment", { itemId: t, content: "先把上季度的数拉出来" });
    await browser.execute(() => document.querySelector('.sidebar nav button[data-view="board"]').click());
    await $(".tcard .cm-badge").waitForExist({ timeout: 5000 });
    await browser.saveScreenshot(SHOT("6-board-badge"));
    await $(".tcard .cm-badge").click();
    await $(".cm-item").waitForExist({ timeout: 5000 });
    await browser.saveScreenshot(SHOT("7-board-overlay"));
    await browser.keys("Escape");
  });
});

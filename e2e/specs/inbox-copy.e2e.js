import { browser, $, expect } from "@wdio/globals";
import { invoke, inboxShow, clearInbox } from "./support.js";

// 随记 · 「复制随记」(用户面 90,676):顶栏一枚钮,把**当前显示的**随记复制成 Markdown ——
// 一天一节 `## YYYY-MM-DD`,一条一个 bullet(时刻 + `#标签`),正文原样、每行缩进两格。
// 判据读剪贴板本身 —— ⚠ 走 Tauri 的剪贴板插件(`plugin:clipboard-manager|read_text`,notebook 窗的
// capability 早就放行了它,主窗贴图那条路在用);⛔ 别用 `navigator.clipboard.readText()`:webdriver 驱动下
// 文档没有焦点,它恒抛「Document is not focused」(第一趟就撞了),而 writeText 走的是点击的用户激活、不受此限。
// 显示条件 = 有东西可复制:回收站那页、筛空时都没有这枚钮。
describe("随记 · 复制随记(Markdown)", () => {
  const TAG = "E2E-复制随记-标签";
  const A = "E2E-复制随记-甲:第一行\n第二行\n- [ ] 里面的一项";
  const B = "E2E-复制随记-乙";
  let tagId;

  before(async () => {
    const topics = await invoke("list_topics");
    tagId = topics.find((t) => t.title === TAG)?.id ?? (await invoke("create_topic", { title: TAG }));
    await clearInbox();
    const a = await invoke("capture_note", { content: A });
    await invoke("file_note_to_topic", { id: a, topicId: tagId, newTitle: null });
    await invoke("capture_note", { content: B }); // 后建 ⇒ 列表里在上面(时间倒序)
    await inboxShow("ideas");
    await $(`.note*=${B}`).waitForExist({ timeout: 10000 });
  });

  it("点「复制随记」→ 剪贴板里是按天分节、一条一个 bullet 的 Markdown(正文原样、标签带 #)", async () => {
    const btn = await $("#inbox-copy-slot .hbtn");
    await btn.waitForExist({ timeout: 5000 });
    expect(await btn.getText()).toBe("复制随记");
    await browser.execute(() => document.querySelector("#inbox-copy-slot .hbtn").click());
    await browser.waitUntil(async () => (await btn.getText()) === "已复制", { timeout: 5000, timeoutMsg: "点了没见「已复制」" });
    // ⚠ Windows 剪贴板一来一回把 LF 变成 CRLF(写的是 \n;读回来每行尾巴多个 \r,肉眼看不出、toBe 却红),
    // 判据只认行内容,先归一。
    const md = (await browser.execute(() => window.__TAURI__.core.invoke("plugin:clipboard-manager|read_text"))).replace(/\r\n/g, "\n");
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const lines = md.split("\n");
    expect(lines[0]).toBe(`## ${today}`); // 一天一节,绝对日期
    // 乙在上(时间倒序):bullet 首行 = 时刻(无标签就只有时刻),正文缩进两格。
    expect(lines[1]).toMatch(/^- \d{2}:\d{2}$/);
    expect(lines[2]).toBe(`  ${B}`);
    // 甲:首行带 #标签,三行正文各缩两格 —— 清单那行成了子列表,原文一个字不动。
    expect(lines[3]).toMatch(new RegExp(`^- \\d{2}:\\d{2} #${TAG}$`));
    expect(lines.slice(4, 7)).toEqual(["  E2E-复制随记-甲:第一行", "  第二行", "  - [ ] 里面的一项"]);
    expect(lines.length).toBe(7); // 没有多余的空行、没有第二节
  });

  it("筛到空 / 回收站 → 没有这枚钮(显示条件 = 有东西可复制)", async () => {
    // 过滤词走 dispatch input(同别的 spec):setValue 清空那一下不一定发 input 事件。
    const setFilter = (q) =>
      browser.execute((v) => {
        const inp = document.querySelector("#idea-filter");
        inp.value = v;
        inp.dispatchEvent(new Event("input", { bubbles: true }));
      }, q);
    await setFilter("E2E-这个词谁都不含");
    await browser.waitUntil(async () => !(await $("#inbox-copy-slot .hbtn").isExisting()), {
      timeout: 5000,
      timeoutMsg: "筛空后「复制随记」仍在",
    });
    await setFilter("");
    await $("#inbox-copy-slot .hbtn").waitForExist({ timeout: 5000 });
    await inboxShow("archived");
    await browser.waitUntil(async () => !(await $("#inbox-copy-slot .hbtn").isExisting()), {
      timeout: 5000,
      timeoutMsg: "回收站页「复制随记」仍在",
    });
    await inboxShow("ideas");
  });
});

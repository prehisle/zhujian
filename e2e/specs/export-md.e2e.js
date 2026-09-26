import { $, expect, browser } from "@wdio/globals";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { goNotebook, invoke, shownText } from "./support.js";

// 设置 · 备份与恢复 ·「导出为 Markdown」(用户面 136):点一下 → 一个新文件夹里有 随记.md / 看板.md / 图/。
// 钉的是 core 单测够不着的那一截:**前端排的正文、壳的落点、图片字节三样接对了没有**。
// 落盘的原子性 / 路径校验 / 同名顺延在 core::export_md 的单测里(故障注入在那里比在 GUI 上准)。
//
// ⚠ e2e 下壳把它落在按库派生的 `<YS_DB_PATH>.exports/`(⛔ 绝不写用户的「下载」),
//    wdio.conf 的 onPrepare 每趟清掉;路径以界面上报的那句为准(= 用户看到的),不另算一份。
// ⚠ 库是全套 spec 累积的 ⇒ 只断言本 spec 种下的那几条在不在、长什么样,不断言整份文件恰等。
// ⚠ 元素文字走 `shownText`(396 纪律)。

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const TAG = "E2E-导出-标签";
const NOTE = "E2E-导出-甲:第一行\n第二行";
const TODO = "E2E-导出-待办";
const DONE = "E2E-导出-已完成";
const SEALED = "E2E-导出-已归档";

let outDir = null;

async function openBackupPane() {
  await goNotebook("inbox");
  await browser.execute(() => document.getElementById("settings-entry").click());
  await $(".settings-panel").waitForExist({ timeout: 5000 });
  await browser.execute(() => document.querySelector('.settings-cat[data-cat="backup"]').click());
}

describe("设置 · 导出为 Markdown", () => {
  let noteId;
  before(async () => {
    const topics = await invoke("list_topics");
    const tagId = topics.find((t) => t.title === TAG)?.id ?? (await invoke("create_topic", { title: TAG }));
    noteId = await invoke("capture_note", { content: NOTE });
    await invoke("file_note_to_topic", { id: noteId, topicId: tagId, newTitle: null });
    await invoke("add_item_image", { itemId: noteId, mime: "image/png", dataB64: PNG });
    await invoke("add_item_comment", { itemId: noteId, content: "留言一句" });
    await invoke("create_task", { title: TODO, dueOn: "2026-12-31", priority: 3 });
    const d = await invoke("create_task", { title: DONE });
    await invoke("update_task_status", { id: d, to: "done" });
    const s = await invoke("create_task", { title: SEALED });
    await invoke("update_task_status", { id: s, to: "done" });
    await invoke("seal_task", { id: s });
  });

  after(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it("点「导出」→ 界面报出路径,文件夹里 随记.md / 看板.md / 图 三样齐", async () => {
    await openBackupPane();
    await browser.execute(() => {
      const b = [...document.querySelectorAll(".settings-panel button")].find((n) => n.textContent.trim() === "导出");
      if (!b) throw new Error("设置面板里没有「导出」钮");
      b.scrollIntoView();
      b.click();
    });
    let said = "";
    await browser.waitUntil(
      async () => {
        const ok = await $("#export-msg.ok");
        const err = await $("#export-msg.err");
        if (await err.isExisting()) said = `报错:${await shownText(err)}`;
        if (!(await ok.isExisting())) return false;
        said = await shownText(ok);
        return said.startsWith("已导出到 ");
      },
      { timeout: 15000, timeoutMsg: `没等到「已导出到」(最后看到:${said || "空"})` },
    );
    outDir = said.slice("已导出到 ".length);
    expect(basename(outDir)).toMatch(/^朱简导出 \d{4}-\d{2}-\d{2} \d{4}( \(\d+\))?$/);
    expect(basename(dirname(outDir))).toMatch(/\.exports$/); // e2e 落点:按库派生,⛔ 不是「下载」
    expect(existsSync(join(outDir, "随记.md"))).toBe(true);
    expect(existsSync(join(outDir, "看板.md"))).toBe(true);
    expect(readdirSync(dirname(outDir)).filter((n) => n.startsWith("."))).toEqual([]); // 临时目录已改名走
  });

  it("随记.md:同「复制随记」的 bullet,下面挂图片链接与留言;链接指向的文件就是那张图", async () => {
    const md = readFileSync(join(outDir, "随记.md"), "utf8");
    expect(md.startsWith("# 随记\n空间「默认空间」· 导出于 ")).toBe(true);
    const lines = md.split("\n");
    const at = lines.findIndex((l) => new RegExp(`^- \\d{2}:\\d{2} #${TAG}$`).test(l));
    expect(at).toBeGreaterThan(0);
    const img = /^ {2}!\[图1\]\((图\/[^)]+-图1\.png)\)$/;
    expect(lines.slice(at + 1, at + 5)).toEqual([...NOTE.split("\n").map((l) => `  ${l}`), "", expect.stringMatching(img)]);
    expect(lines[at + 5]).toBe("");
    expect(lines[at + 6]).toMatch(/^ {2}> 留言 \d{4}-\d{2}-\d{2} \d{2}:\d{2}：留言一句$/);
    const rel = lines[at + 4].match(img)[1];
    expect(readFileSync(join(outDir, ...rel.split("/")))).toEqual(Buffer.from(PNG, "base64"));
  });

  it("看板.md:待办不勾、带截止与优先级;完成列打勾;已归档的进「归档」一节", async () => {
    const md = readFileSync(join(outDir, "看板.md"), "utf8");
    expect(md.startsWith("# 看板\n")).toBe(true);
    expect(md).toContain(`- [ ] ${TODO} · 截止 2026-12-31 · P0`);
    expect(md).toMatch(new RegExp(`^- \\[x\\] ${DONE} · 完成于 \\d{4}-\\d{2}-\\d{2}$`, "m"));
    const sealedAt = md.indexOf("\n## 归档\n");
    expect(sealedAt).toBeGreaterThan(0);
    expect(md.indexOf(`- [x] ${SEALED}`)).toBeGreaterThan(sealedAt);
    expect(md.indexOf(`${DONE} ·`)).toBeLessThan(sealedAt);
  });
});

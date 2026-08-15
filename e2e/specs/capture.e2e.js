import { browser, $, expect } from "@wdio/globals";
import { invoke, goShow, clearInbox } from "./support.js";

describe("捕获 · 打字回车入 Inbox", () => {
  before(async () => {
    await goShow("/index.html");
    await clearInbox();
  });

  it("打字 + 回车 → 想法进 Inbox(窗口随即隐藏)", async () => {
    await goShow("/index.html"); // capture page, visible+focused
    const ta = await $("#capture");
    await ta.waitForExist({ timeout: 10000 });
    await ta.click();
    await ta.setValue("E2E-捕获-甲");

    await browser.keys("Enter"); // real capture_note, then appWindow.hide()

    // The window hides, but its WebView context stays alive for IPC.
    await browser.waitUntil(
      async () => {
        const inbox = await invoke("list_inbox");
        return inbox.length === 1 && inbox[0].content === "E2E-捕获-甲";
      },
      { timeout: 6000, timeoutMsg: "回车后想法未进 Inbox" },
    );
  });

  it("空白内容回车不入库(trim 后为空即放弃)", async () => {
    await goShow("/index.html");
    await clearInbox();

    const ta = await $("#capture");
    await ta.waitForExist({ timeout: 10000 });
    await ta.click();
    await ta.setValue("   "); // whitespace only
    await browser.keys("Enter");

    await browser.pause(500);
    expect(await invoke("list_inbox")).toHaveLength(0);
  });

  it("Esc 收窗保稿:草稿留在框里,下次唤起接着写;存完才清", async () => {
    await goShow("/index.html");
    await clearInbox();
    const ta = await $("#capture");
    await ta.waitForExist({ timeout: 10000 });
    await ta.click();
    await ta.setValue("E2E-半打的念头");
    await browser.keys("Escape"); // 收窗(hide),不清稿、不入库

    await browser.pause(300);
    expect(await invoke("list_inbox")).toHaveLength(0);

    // 真机的「再次唤起」= show 同一页面(DOM 不重载,草稿在内存里)。这里只 show
    // 不 goShow——goShow 的 browser.url() 是整页重载,会人为洗掉草稿,不是真机语义。
    await browser.execute(async () => {
      const w = window.__TAURI__.window.getCurrentWindow();
      await w.show();
      await w.setFocus();
    });
    expect(await $("#capture").getValue()).toBe("E2E-半打的念头");
    await $("#capture").click();
    await browser.keys("Enter");
    await browser.waitUntil(
      async () => {
        const inbox = await invoke("list_inbox");
        return inbox.length === 1 && inbox[0].content === "E2E-半打的念头";
      },
      { timeout: 6000, timeoutMsg: "保稿后的回车未入库" },
    );
    expect(await $("#capture").getValue()).toBe(""); // 存完才清
  });

  // ㊴ 配图:capture holds a pasted image until Enter, then attaches it to the new note. A
  // real OS clipboard isn't drivable, so we dispatch a synthetic `paste` event carrying a
  // File (same synthetic-event approach as the board's DnD) — it flows through main.ts's
  // paste handler exactly like a real screenshot paste.
  const PNG =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  it("粘贴图片 + 文字 + 回车 → 想法入库且带 1 张配图", async () => {
    await goShow("/index.html");
    await clearInbox();
    const ta = await $("#capture");
    await ta.waitForExist({ timeout: 10000 });
    await ta.click();

    // Synthetic image paste: build a File, dispatch a paste event with it on #capture.
    await browser.execute((b64) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], "shot.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      document.getElementById("capture").dispatchEvent(ev);
    }, PNG);

    // A preview thumbnail appears (image held, not yet saved). The strip is the shared
    // pendingImages controller now (item-images.ts), so the thumb class is .img-thumb.
    await $("#cap-images .img-thumb").waitForExist({ timeout: 5000 });

    await ta.setValue("E2E-捕获-配图");
    await browser.keys("Enter"); // capture_note → then attach the held image

    // The idea is captured AND carries exactly one image (图1).
    let noteId;
    await browser.waitUntil(
      async () => {
        const ideas = await invoke("list_ideas");
        const hit = ideas.find((n) => n.content === "E2E-捕获-配图");
        if (hit) noteId = hit.id;
        return !!hit;
      },
      { timeout: 6000, timeoutMsg: "回车后配图想法未入库" },
    );
    const imgs = await invoke("list_item_images", { itemId: noteId });
    expect(imgs).toHaveLength(1);
    expect(imgs[0].seq).toBe(1);
  });
});

// 斜杠命令(capture-commands.ts):首行以 / 起且有命令匹配才亮面板;/task 存看板、
// /tag 挂标签、/etc 这类无匹配的绝不误触发(回车照旧存记录)。e2e 恒单空间,故 /space
// 命令不出现(enabled 关),空间切换靠代码审 + 真机 CDP,不在此测。
describe("捕获 · 斜杠命令", () => {
  const panelHidden = () => browser.execute(() => document.getElementById("cap-cmd").hidden);
  const cmdRows = () =>
    browser.execute(() =>
      [...document.querySelectorAll("#cap-cmd .cmd-row .cmd-name")].map((n) => n.textContent),
    );

  it("打 / 亮命令面板(单空间下列 /task /tag,无 /space)", async () => {
    await goShow("/index.html");
    await clearInbox();
    const ta = await $("#capture");
    await ta.waitForExist({ timeout: 10000 });
    await ta.click();
    await ta.setValue("/");
    await browser.waitUntil(async () => !(await panelHidden()), {
      timeout: 4000,
      timeoutMsg: "打 / 后命令面板未亮",
    });
    expect(await cmdRows()).toEqual(["/task", "/tag"]);
  });

  it("/etc 无命令匹配 → 面板不亮,回车原样存为想法", async () => {
    await goShow("/index.html");
    await clearInbox();
    const ta = await $("#capture");
    await ta.waitForExist({ timeout: 10000 });
    await ta.click();
    await ta.setValue("/etc/hosts要改");
    await browser.pause(300);
    expect(await panelHidden()).toBe(true); // 没有命令叫 etc,不吞正文
    await browser.keys("Enter");
    await browser.waitUntil(
      async () => {
        const inbox = await invoke("list_inbox");
        return inbox.length === 1 && inbox[0].content === "/etc/hosts要改";
      },
      { timeout: 6000, timeoutMsg: "/etc… 未原样入库" },
    );
  });

  it("/task 回车 → 任务 chip;写标题回车 → 存进看板(非灵感)", async () => {
    await goShow("/index.html");
    await clearInbox();
    const ta = await $("#capture");
    await ta.waitForExist({ timeout: 10000 });
    await ta.click();
    await ta.setValue("/task");
    await browser.waitUntil(async () => !(await panelHidden()), { timeout: 4000 });
    await browser.keys("Enter"); // 执行 /task → 任务模式 chip
    await $("#cap-mods .cap-chip.mode").waitForExist({ timeout: 4000 });

    const TITLE = "E2E-斜杠-任务";
    await ta.setValue(TITLE);
    await browser.keys("Enter"); // create_task,非 capture_note

    let taskId;
    await browser.waitUntil(
      async () => {
        const t = (await invoke("list_tasks")).find((x) => x.title === TITLE);
        if (t) taskId = t.id;
        return !!t;
      },
      { timeout: 6000, timeoutMsg: "/task 未存进看板" },
    );
    // 没有同名想法漏进灵感视图(存的是任务,天然去重)。
    expect((await invoke("list_inbox")).some((n) => n.content === TITLE)).toBe(false);
    // 存完 chip 结算清空,下一条从想法起。
    expect(await $("#cap-mods .cap-chip.mode").isExisting()).toBe(false);
    // 清理本条任务。
    await invoke("archive_task", { id: taskId });
    await invoke("purge_task", { id: taskId });
  });

  it("/tag 家庭 回车 → 标签 chip;写正文回车 → 想法带该标签", async () => {
    await goShow("/index.html");
    await clearInbox();
    const ta = await $("#capture");
    await ta.waitForExist({ timeout: 10000 });
    await ta.click();
    await ta.setValue("/tag 家庭");
    await browser.waitUntil(async () => !(await panelHidden()), { timeout: 4000 });
    await browser.keys("Enter"); // 执行 /tag → 标签 chip
    const chip = await $("#cap-mods .cap-chip");
    await chip.waitForExist({ timeout: 4000 });
    expect(await chip.getText()).toContain("#家庭");

    const BODY = "E2E-斜杠-带标签";
    await ta.setValue(BODY);
    await browser.keys("Enter"); // capture_note + 挂「家庭」标签

    await browser.waitUntil(
      async () => {
        const hit = (await invoke("list_ideas")).find((n) => n.content === BODY);
        return hit && hit.topics.some((t) => t.title === "家庭");
      },
      { timeout: 6000, timeoutMsg: "带标签想法未入库或未挂上标签" },
    );

    // 清理:软删+purge 该想法,删掉顺手建的「家庭」标签。
    await clearInbox();
    const home = (await invoke("list_topics")).find((t) => t.title === "家庭");
    if (home) await invoke("delete_topic", { id: home.id });
  });

  // 两个 chip 同时在场的那一支:落点是看板,而标签要挂到**任务**上(走
  // add_task_topic_by_title,与灵感那支的 file_note_to_topic 是两条不同的命令)。
  // 388 补:388 把这里从「先 create_topic 拿 id 再挂链」两步改成一条命令,而这一支原先
  // 一条自动化判据都没有——灵感那支有上面那只,任务这支没有(改坏了没人会红)。
  it("/task + /tag 回车 → 任务进看板且带该标签(标签挂在任务上,不是想法上)", async () => {
    await goShow("/index.html");
    await clearInbox();
    const ta = await $("#capture");
    await ta.waitForExist({ timeout: 10000 });
    await ta.click();
    await ta.setValue("/task");
    await browser.waitUntil(async () => !(await panelHidden()), { timeout: 4000 });
    await browser.keys("Enter"); // 执行 /task → 任务模式 chip
    await $("#cap-mods .cap-chip.mode").waitForExist({ timeout: 4000 });
    await ta.setValue("/tag 工作");
    await browser.waitUntil(async () => !(await panelHidden()), { timeout: 4000 });
    await browser.keys("Enter"); // 执行 /tag → 标签 chip(与任务 chip 并存)

    const TITLE = "E2E-斜杠-任务带标签";
    await ta.setValue(TITLE);
    await browser.keys("Enter"); // create_task + add_task_topic_by_title

    let taskId;
    await browser.waitUntil(
      async () => {
        const hit = (await invoke("list_tasks")).find((x) => x.title === TITLE);
        if (hit) taskId = hit.id;
        return hit && hit.topics.some((t) => t.title === "工作");
      },
      { timeout: 6000, timeoutMsg: "带标签任务未进看板或未挂上标签" },
    );
    // 标签挂的是任务这一行,没顺手造一条同名想法(单实体:转不转 stage 是一回事,别多一行)。
    expect((await invoke("list_inbox")).some((n) => n.content === TITLE)).toBe(false);

    // 清理:任务软删+purge,删掉顺手建的「工作」标签。
    await invoke("archive_task", { id: taskId });
    await invoke("purge_task", { id: taskId });
    const work = (await invoke("list_topics")).find((t) => t.title === "工作");
    if (work) await invoke("delete_topic", { id: work.id });
  });
});

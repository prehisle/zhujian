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

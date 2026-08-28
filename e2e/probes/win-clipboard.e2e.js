// ⛔ **按需探针,刻意不在默认套件里**(住 `e2e/probes/`,`specs/**/*.e2e.js` 那条 glob 扫不到)。
//
// 为什么它值得留:395 把取图收成唯一入口 `pasteImage()` 的三支,而仓里那三支贴图 spec 全是
// **合成** ClipboardEvent、恒走①支 —— **真剪贴板那条路两端都没有网**(backlog「测试与工装」3)。
// 这里用**真** Windows 剪贴板 + WebDriver 发的**真** Ctrl+V(可信事件,Chromium 会真去读系统
// 剪贴板)把三支各走一遍,并用「那次 paste 有没有被同步拦下」当**判别式**,把 395 那句
// 「Windows 恒走①支」从自述变成量出来的读数。
//
// 为什么不并进默认套件:它会**真的改写本机剪贴板**(用户复制在手上的东西会被清掉),
// 而且是 Windows 专属(PowerShell)。让每次跑 e2e 都背这个副作用 = 又一个隐藏入参。
//
// 怎么跑(先照文档退出生产朱简、先 `npm run tauri build` 出 release exe):
//   npm run test:e2e -- --specFileRetries=0 --spec e2e/probes/win-clipboard.e2e.js
import { browser, $, $$, expect } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { goShow, clearInbox, invoke, waitItemImages } from "../specs/support.js";

const here = dirname(fileURLToPath(import.meta.url));

function setClipboard(mode) {
  const out = execFileSync(
    "powershell",
    [
      "-STA",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(here, "set-clipboard.ps1"),
      "-Mode",
      mode,
    ],
    { encoding: "utf8" },
  );
  return out.trim();
}

describe("395 · 真剪贴板 Ctrl+V(Windows)", () => {
  it("①支:剪贴板上有图 → 真 Ctrl+V 当场收图,回车挂上条目", async () => {
    console.log("clipboard:", setClipboard("image"));
    await goShow("/index.html");
    await clearInbox();
    const ta = await $("#capture");
    await ta.waitForExist({ timeout: 10000 });
    await ta.click();
    await browser.keys(["Control", "v"]);

    await $("#cap-images .img-thumb").waitForExist({
      timeout: 8000,
      timeoutMsg: "真 Ctrl+V 后暂存缩略图没出现 —— ①支断了",
    });

    await ta.setValue("E2E-真剪贴板-图");
    await browser.keys("Enter");
    let noteId;
    await browser.waitUntil(
      async () => {
        const inbox = await invoke("list_inbox");
        const hit = inbox.find((n) => n.content === "E2E-真剪贴板-图");
        if (hit) noteId = hit.id;
        return !!hit;
      },
      { timeout: 8000, timeoutMsg: "回车后未入库" },
    );
    const imgs = await waitItemImages(noteId, 1, "真剪贴板·Windows");
    console.log("入库配图:", JSON.stringify(imgs));
    await clearInbox();
  });

  it("①支的判别式:有图那次 paste 被同步拦下(prevented=true)⇒ 走的确实是①不是③", async () => {
    console.log("clipboard:", setClipboard("image"));
    await goShow("/index.html");
    await clearInbox();
    const ta = await $("#capture");
    await ta.waitForExist({ timeout: 10000 });
    // 只看不干预:挂在 document 的冒泡相,app 装在 #capture 上的处理器先跑,
    // 冒到这里时 defaultPrevented 已是最终态。①支同步 preventDefault,③支刻意不拦。
    await browser.execute(() => {
      window.__probe = [];
      document.addEventListener("paste", (ev) => {
        window.__probe.push({
          prevented: ev.defaultPrevented,
          types: [...(ev.clipboardData?.types ?? [])],
          items: ev.clipboardData?.items?.length ?? -1,
        });
      });
    });
    await ta.click();
    await browser.keys(["Control", "v"]);
    await $("#cap-images .img-thumb").waitForExist({ timeout: 8000 });

    const seen = await browser.execute(() => window.__probe);
    console.log("PROBE:", JSON.stringify(seen));
    expect(seen).toHaveLength(1);
    expect(seen[0].prevented).toBe(true); // ← ①支的签名
    expect(seen[0].items).toBeGreaterThan(0); // ← 标准 DataTransfer 真带着图(Linux 上这里是 0)

    // 收干净:这张暂存图不提交就会留在草稿里、被下一支 goShow 回填(396 那族的病,我自己踩了一次)
    await ta.setValue("E2E-真剪贴板-判别式");
    await browser.keys("Enter");
    await browser.waitUntil(
      async () => (await invoke("list_inbox")).some((n) => n.content === "E2E-真剪贴板-判别式"),
      { timeout: 8000, timeoutMsg: "判别式那支回车后未入库" },
    );
    await clearInbox();
    expect(await $$("#cap-images .img-thumb")).toHaveLength(0);
  });

  it("②支:剪贴板上只有文字 → 真 Ctrl+V 就是贴字,不加图", async () => {
    console.log("clipboard:", setClipboard("text"));
    await goShow("/index.html");
    await clearInbox();
    const ta = await $("#capture");
    await ta.waitForExist({ timeout: 10000 });
    await ta.click();
    await browser.keys(["Control", "v"]);
    await browser.pause(1200);

    expect(await ta.getValue()).toBe("WINCLIP-TEXT");
    expect(await $$("#cap-images .img-thumb")).toHaveLength(0);
  });

  it("③支:剪贴板空 → 真 Ctrl+V 不加图、不插字、不报错", async () => {
    console.log("clipboard:", setClipboard("empty"));
    await goShow("/index.html");
    await clearInbox();
    const ta = await $("#capture");
    await ta.waitForExist({ timeout: 10000 });
    await ta.click();
    await ta.setValue("E2E-空剪贴板");
    await browser.keys(["Control", "v"]);
    await browser.pause(1500);

    expect(await ta.getValue()).toBe("E2E-空剪贴板");
    expect(await $$("#cap-images .img-thumb")).toHaveLength(0);
    // 395 的③支会异步问一趟壳;拿不到图应当安静 resolve null,不许弹错。
    expect(await $$(".toast")).toHaveLength(0);
  });
});

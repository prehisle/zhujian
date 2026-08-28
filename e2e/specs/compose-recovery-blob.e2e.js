import { browser, $, expect } from "@wdio/globals";
import { invoke, goNotebook, clearInbox, waitItemImages } from "./support.js";

// 回填的草稿图**不许欠 IndexedDB**(526)。
//
// 背景:`compose-recovery.e2e.js` 在 Linux CI 上红过两次,报的都是「图真没挂上」
// (app 自己弹 `.form-err`「N 张图未能附加」)。根在次序上,而那个次序是硬的:
//   takeBatch() ──同步──> persist() ──> saveImageDraft(桶, []) ──> 删掉 `桶::img:<id>`
//   ──await 一整趟创建条目的 IPC──> attachBlob() ──> toBase64() ──> blob.arrayBuffer()
// 回填进来的那张图,手上的 Blob **底下就是刚被删掉的那条 IndexedDB 记录**。
// 于是「这张图挂不挂得上」取决于引擎肯不肯让一个记录已删的 Blob 继续读 —— 那不是我们
// 该赌的东西。修法在 `src/item-images.ts::restore()`:回填时当场把字节读进内存,
// 让回填的图和粘贴进来的图是同一种东西。
//
// ⚠⚠ **这支 spec 的诚实边界(别把它读成全覆盖)**:
//   · **在 Chromium 上它对未修的代码也是绿的** —— 实测 Chromium 记录删了 Blob 照样读得动
//     (`RESULT: SURVIVES`),旧代码在那儿本来就是对的。⇒ **Windows 上跑它证明不了什么**,
//     它是 **Linux 的 WebKitGTK 与 macOS 的 WKWebView** 那两端的网。
//   · 它也**不复现**那个随机红:随机红要赌 takeBatch 那次删有没有赶在读之前。这里改成
//     **测试自己把记录删掉**,把那个赌变成确定的一步 ⇒ 红得稳、红得早。
//
// ⏳ 第一例(`引擎探针`)是**临时的**:它只把引擎的答案印进 CI 日志,不断言任何东西
//    ——立它就是为了拿到 WebKit 那半的字据。读到答案的那一轮就该删掉它,别留成空测。

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const INBOX_IMG_KEY = "zhujian.inbox-images";
const INBOX_TEXT_KEY = "zhujian.inbox-draft";

/** 本桶里「清单有 id 且那个 id 真有字节」的张数(与 compose-recovery.e2e.js 同法)。 */
function draftImageCount(bucket) {
  return browser.execute(async (k) => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open("zhujian-compose-draft", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("images");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    try {
      return await new Promise((res, rej) => {
        const tx = db.transaction("images", "readonly");
        const store = tx.objectStore("images");
        let withBytes = 0;
        const ord = store.get(`${k}::order`);
        ord.onsuccess = () => {
          for (const id of ord.result ?? []) {
            const c = store.count(`${k}::img:${id}`);
            c.onsuccess = () => {
              withBytes += c.result;
            };
          }
        };
        tx.oncomplete = () => res(withBytes);
        tx.onerror = () => rej(tx.error);
        tx.onabort = () => rej(tx.error);
      });
    } finally {
      db.close();
    }
  }, bucket);
}

/** 把本桶的字节记录全删掉(清单原样留着)—— 就是 takeBatch 那次 persist 干的事,
 *  只是这里由测试确定地做,不靠时序碰运气。返回删掉几条。 */
function dropBucketBytes(bucket) {
  return browser.execute(async (k) => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open("zhujian-compose-draft", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("images");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    try {
      return await new Promise((res, rej) => {
        const tx = db.transaction("images", "readwrite");
        const store = tx.objectStore("images");
        let dropped = 0;
        const q = store.getAllKeys();
        q.onsuccess = () => {
          for (const key of q.result) {
            if (String(key).startsWith(`${k}::img:`)) {
              store.delete(key);
              dropped += 1;
            }
          }
        };
        tx.oncomplete = () => res(dropped);
        tx.onerror = () => rej(tx.error);
        tx.onabort = () => rej(tx.error);
      });
    } finally {
      db.close();
    }
  }, bucket);
}

async function pasteImage(sel) {
  await browser.execute(
    (s, b64) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], "shot.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      document.querySelector(s).dispatchEvent(ev);
    },
    sel,
    PNG,
  );
}

describe("回填的草稿图不欠 IndexedDB", () => {
  before(async () => {
    await goNotebook("inbox");
    await clearInbox();
  });

  // ⏳ 临时:只报告,不断言。目的是把「这台跑的引擎,记录删了之后 Blob 还读不读得动」
  //    这句话印进 CI 日志 —— Windows 会印 SURVIVES,想要的是 Linux 那台印什么。
  it("引擎探针(临时,只报告不断言):记录删掉之后,手上那个 Blob 还读得动吗", async () => {
    const report = await browser.execute(async () => {
      const open = () =>
        new Promise((res, rej) => {
          const r = indexedDB.open("probe-idb-blob", 1);
          r.onupgradeneeded = () => r.result.createObjectStore("s");
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
      const run = (db, mode, fn) =>
        new Promise((res, rej) => {
          const t = db.transaction("s", mode);
          const out = fn(t.objectStore("s"));
          t.oncomplete = () => res(out);
          t.onerror = () => rej(t.error);
          t.onabort = () => rej(t.error);
        });
      try {
        const db = await open();
        await run(db, "readwrite", (s) => s.put(new Blob([new Uint8Array(4096).fill(7)], { type: "image/png" }), "k"));
        const blob = await run(db, "readonly", (s) => {
          const q = s.get("k");
          return new Promise((res) => {
            q.onsuccess = () => res(q.result);
          });
        });
        const before = (await blob.arrayBuffer()).byteLength; // 对照组:删之前是好的
        await run(db, "readwrite", (s) => s.delete("k"));
        let verdict;
        try {
          verdict = `SURVIVES(删后仍读得动 ${(await blob.arrayBuffer()).byteLength} 字节)`;
        } catch (e) {
          verdict = `DIES(${e.name}: ${e.message})`;
        }
        db.close();
        await new Promise((r) => {
          const d = indexedDB.deleteDatabase("probe-idb-blob");
          d.onsuccess = r;
          d.onerror = r;
          d.onblocked = r;
        });
        return `删前 ${before} 字节 → ${verdict}`;
      } catch (e) {
        return `探针自己炸了:${e && e.name}: ${e && e.message}`;
      }
    });
    console.log(`\n[引擎探针] IndexedDB 记录删掉之后手上那个 Blob:${report}\n`);
  });

  it("回填之后把它那条 IndexedDB 记录删掉,记下仍要把图挂上", async () => {
    const input = await $(".v-inbox .compose-input");
    await input.waitForExist({ timeout: 10000 });
    await input.click();
    await input.setValue("E2E-回填图-不欠IDB");
    await pasteImage(".v-inbox .compose-input");
    await $(".v-inbox .compose .img-pending .img-thumb").waitForExist({ timeout: 5000 });
    await browser.waitUntil(async () => (await draftImageCount(INBOX_IMG_KEY)) === 1, {
      timeout: 10000,
      timeoutMsg: "重载前:字节应已落进 IndexedDB",
    });

    await goNotebook("inbox"); // 重载 → restore() 回填
    const input2 = await $(".v-inbox .compose-input");
    await input2.waitForExist({ timeout: 10000 });
    await browser.waitUntil(async () => (await input2.getValue()) === "E2E-回填图-不欠IDB", {
      timeout: 5000,
      timeoutMsg: "重载后文字草稿未回填",
    });
    await $(".v-inbox .compose .img-pending .img-thumb").waitForExist({
      timeout: 5000,
      timeoutMsg: "重载后暂存图未回填",
    });

    // ★ 承重的一步:把字节从 IndexedDB 里抽掉。此后这张图能不能挂上,只取决于
    //   回填时有没有把字节拿进内存 —— 磁盘上已经没有它了。
    expect(await dropBucketBytes(INBOX_IMG_KEY)).toBe(1);
    expect(await draftImageCount(INBOX_IMG_KEY)).toBe(0);

    await input2.click();
    await browser.keys("Enter");
    let noteId;
    await browser.waitUntil(
      async () => {
        const ideas = await invoke("list_ideas");
        const hit = ideas.find((n) => n.content === "E2E-回填图-不欠IDB");
        if (hit) noteId = hit.id;
        return !!hit;
      },
      { timeout: 6000, timeoutMsg: "回填稿记下后未入库" },
    );
    await waitItemImages(noteId, 1, "回填图不欠 IDB");

    // 收场:草稿两把钥匙都得清干净,别给后面的 spec 留状态。
    await browser.waitUntil(async () => (await draftImageCount(INBOX_IMG_KEY)) === 0, {
      timeout: 10000,
      timeoutMsg: "记下后:IndexedDB 里应有 0 张暂存图",
    });
    await browser.waitUntil(
      async () => (await browser.execute((k) => localStorage.getItem(k), INBOX_TEXT_KEY)) === null,
      { timeout: 10000, timeoutMsg: "记下后:localStorage 里的文字草稿应已清" },
    );
    await clearInbox();
  });
});

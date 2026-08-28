import { browser, $, expect } from "@wdio/globals";
import { invoke, goNotebook, clearInbox, waitItemImages } from "./support.js";

// 回填的草稿图**不许欠 IndexedDB**(526 立,526 补当轮自我更正)。
//
// 次序是硬的,这一半是读代码就看得见的**事实**:
//   takeBatch() ──同步──> persist() ──> saveImageDraft(桶, []) ──> 删掉 `桶::img:<id>`
//   ──await 一整趟创建条目的 IPC──> attachBlob() ──> toBase64() ──> blob.arrayBuffer()
// 回填进来的那张图,手上的 Blob **底下就是刚被删掉的那条 IndexedDB 记录** ⇒ 代码在
// **读一份自己刚刚删掉的字节**。修法在 `src/item-images.ts::restore()`:回填时当场把
// 字节读进内存,让回填的图和粘贴进来的图是同一种东西。
//
// ⚠⚠ **别把「Linux CI 上那两次红是它造成的」当已证** —— 526 当轮就被自己的探针打脸了:
//   `compose-recovery.e2e.js` 在 Linux 上红过两次(app 自己弹 `.form-err`「N 张图未能
//   附加」),我据此写下「Chromium 肯让记录已删的 Blob 活、WebKit 不肯」。而探针在
//   **Chromium 与 WebKitGTK 上都答 SURVIVES** ⇒ 那个解释没有字据。**那两次红的根至今
//   未查实**(backlog 测试与工装 44)。⇒ 本 spec 守的是**次序**这条自明的契约,
//   ⛔ 别把它读成「那个随机红被修好了」。
//
// ⚠ **这支 spec 的诚实边界**:它**不复现**那个随机红(随机红要赌 takeBatch 那次删有没有
//   赶在读之前),而是把那个赌**换成测试自己确定地删** ⇒ 红得稳、红得早。而只要引擎肯让
//   记录已删的 Blob 继续活(今天量到的两个引擎都肯),**它对未修的代码就是绿的** ——
//   ⛔ 那意味着它今天在**任何**已知平台上都没有牙齿,留着是为了钉住「不许再改回去读那份
//   已删字节」这条契约,不是因为它能逮住谁。这一格是如实记的,别读大了。
//
// ⏳ 第一例(`引擎探针`)仍是**临时的**:只报告不断言。526 那版问错了形(同一个连接、
//    删完立刻读),这一版照产品的形状问(读完关连接 / 另开连接删 / 删完等一段再读)。
//    ⛔ 读到答案就该删掉它,别留成空测。

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

  // ⏳ 临时:只报告,不断言。
  //
  // ⚠ **526 那一版问错了形,这一版是更正**。旧版是「同一个连接里 put → get → delete →
  //   立刻读」,两个引擎都答 SURVIVES —— 而**两组本该分道的输入给出同一个答案,第一嫌疑
  //   人是管道不是被测对象**(memory `test-negative-control` 361 那条)。回头比对,它与
  //   产品那条路至少差三处,每一处都可能就是差异所在:
  //     ① 产品里 `loadImageDraft` 读完在 `finally` 里 **`db.close()`** —— 旧版连接一直开着;
  //     ② 产品里删是 `saveImageDraft` **另开一个连接**干的 —— 旧版同一个连接;
  //     ③ 产品里删到读之间隔着**一整趟创建条目的 IPC** —— 旧版是几微秒。
  //       ⭐ ③ 尤其可疑:blob 文件回收若是延后做的,「删完立刻读」必然成功,
  //         而那也正好解释了那个红为什么是**间歇**的。
  //   ⇒ 这一版把三处逐个铺开成四格,让日志自己说是哪一格(或者哪一格都不是)。
  it("引擎探针(临时,只报告不断言):记录删掉之后,手上那个 Blob 还读得动吗", async () => {
    const report = await browser.execute(async () => {
      const openDb = (name) =>
        new Promise((res, rej) => {
          const r = indexedDB.open(name, 1);
          r.onupgradeneeded = () => r.result.createObjectStore("s");
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
          r.onblocked = () => rej(new Error("open blocked"));
        });
      const run = (db, mode, fn) =>
        new Promise((res, rej) => {
          const t = db.transaction("s", mode);
          const out = fn(t.objectStore("s"));
          t.oncomplete = () => res(out);
          t.onerror = () => rej(t.error);
          t.onabort = () => rej(t.error);
        });
      const getK = (db) =>
        run(db, "readonly", (s) => {
          const q = s.get("k");
          return new Promise((res) => {
            q.onsuccess = () => res(q.result);
          });
        });
      const wipe = (name) =>
        new Promise((r) => {
          const d = indexedDB.deleteDatabase(name);
          d.onsuccess = r;
          d.onerror = r;
          d.onblocked = r;
        });
      const readBack = async (blob) => {
        try {
          return `SURVIVES(${(await blob.arrayBuffer()).byteLength}B)`;
        } catch (e) {
          return `DIES(${e && e.name}: ${e && e.message})`;
        }
      };
      // sameConn=true 复刻 526 那个旧形(基线);false 走产品的形(每步各开各的连接、用完就关)。
      const trial = async (label, sameConn, delayMs) => {
        const name = `probe-idb-blob-${label}`;
        try {
          await wipe(name);
          let db = await openDb(name);
          await run(db, "readwrite", (s) =>
            s.put(new Blob([new Uint8Array(4096).fill(7)], { type: "image/png" }), "k"),
          );
          if (!sameConn) {
            db.close();
            db = await openDb(name);
          }
          const blob = await getK(db);
          // 对照组:此刻必须是好的。⭐ 产品里这一读也真实发生 —— 回填出来的缩略图
          // `<img src=objectURL>` 解码时就把字节读过一遍了,故留着它是**照产品的形**。
          const pre = (await blob.arrayBuffer()).byteLength;
          if (!sameConn) db.close();
          const killer = sameConn ? db : await openDb(name);
          await run(killer, "readwrite", (s) => s.delete("k"));
          if (!sameConn) killer.close();
          if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
          const verdict = await readBack(blob);
          if (sameConn) db.close();
          await wipe(name);
          return `${label}=${pre}B→${verdict}`;
        } catch (e) {
          return `${label}=探针自己炸了(${e && e.name}: ${e && e.message})`;
        }
      };
      const out = [];
      out.push(await trial("同连接·立刻", true, 0)); // ← 526 旧版就是这一格
      out.push(await trial("产品形·立刻", false, 0)); // ← 加上 ①②
      out.push(await trial("产品形·等300ms", false, 300)); // ← 再加上 ③
      out.push(await trial("产品形·等1500ms", false, 1500)); // ← CI 那台慢,给足
      return out.join("  |  ");
    });
    console.log(`\n[引擎探针] 记录删掉之后手上那个 Blob:${report}\n`);
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

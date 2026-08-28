import { browser, $, $$, expect } from "@wdio/globals";
import { invoke, goShow, goNotebook, clearInbox, openCompose, waitItemImages } from "./support.js";

// compose 草稿断电恢复(198 桌面侧):三入口(捕获浮窗 / 灵感记下灵感 / 看板新建任务)的
// 未记下草稿——文字 + 暂存图——存到设备本地,断电 / 杀进程后重开还在。这里用「整页重载」
// (browser.url,即 goShow/goNotebook)当进程重启的前端 proxy:localStorage / IndexedDB 存
// 磁盘、同源留存,重载后 main.ts / inbox.ts / board.ts 的启动回填(restore)应把稿灌回。
// 每例自清:记下 → 断言草稿清 → 清库,不给后续 spec 留状态。
//
// 阴性对照(手工验过即可,勿留代码):把 persistKey / saveTextDraft 注掉,重载后
// 输入框空、暂存条无 thumb → 三个 waitUntil 全超时真红。
// 335 轮又验了三刀,每刀都红在**新写的那句** timeoutMsg 上、不是别的断言顺带红:
//   · persist() 整个 no-op            → 「重载前:IndexedDB 里应有 1 张暂存图」
//   · persist() 在 held 空时跳过回写   → 「记下后:IndexedDB 里应有 0 张暂存图」
//   · compose-draft 两条清稿路径都切掉 → 「记下后:localStorage 里的文字草稿应已清」
// 外加一个决定性实验(比反复跑碰运气强):给 persist 注入 200ms 延迟 —— 改之前三例
// 100% 红在「重载后暂存图未回填」,改之后同样注入全绿。窗口是真的,且真被关上了。

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// 三入口各自的两把持久化钥匙(compose-draft.ts / item-images.ts 里的常量,此处按名对齐)。
const KEYS = {
  capture: { img: "zhujian.capture-images", text: "zhujian.capture-draft" },
  inbox: { img: "zhujian.inbox-images", text: "zhujian.inbox-draft" },
  board: { img: "zhujian.board-images", text: "zhujian.board-draft" },
};

// 直接读磁盘那一侧(IndexedDB / localStorage)。**本 spec 的等待与判据都得落在这里**,原因
// 是两个方向上的坑各一个:
//
//  ① 等的东西 ≠ 读的东西(331 同族第二只,真 flaky):暂存图进 DOM 是同步的
//    (item-images.ts::add 里 root.append(thumb)),落 IndexedDB 是异步的(persist() 只把写
//    挂进 persistChain)。等 .img-thumb 出现就整页重载,会抢在事务提交之前 —— 而重载还会
//    把没提交的事务连锅端掉,于是「重载后暂存图未回填」。给 persist 注入 200ms 延迟,三例
//    100% 复现,那就是它平时随机红的那扇窗。
//  ② 「记下 = 稿了结」那几格的牙齿挂在时序运气上(判据方向与等待方向相反):启动回填是
//    `void pend.restore()`(要先 await IndexedDB 才 append thumb),而 #capture /
//    .compose-input 是静态元素、waitForExist 立刻满足 —— 「DOM 上没有 thumb」既可能是真
//    清了、也可能是还没来得及填,两者读出来一模一样。⚠ **实测它今天有牙齿**(把「清磁盘」
//    那一刀注掉,旧版三例照样红):goShow 里那次 show()/setFocus() 往返给了 restore 足够
//    时间 —— 立本条时我按「必然抢在回填之前 ⟹ 恒真假绿」写,阴性对照当场把这句话证伪了。
//    改判据的理由因此收窄成两条,但仍成立:一是这条牙齿不欠等待就长不牢,restore 里哪天多
//    一次 await(比如解码缩略图)就会翻面,而翻面方向是「产品坏了却绿」;二是磁盘才是「稿
//    了结」的权威真相源,红得更早更准(红在记下那一步,而不是绕一圈重载之后)。
//    (文字那半旧版本来就可靠——文字回填是同步的,不像图。)
//
// 形态(393 起,compose-draft.ts 一张一个键):本桶有 `<桶>::order`(id 顺序清单)与
// 每张一个 `<桶>::img:<id>`。故「磁盘上有几张」= **清单里有 id 且那个 id 真有字节**的张数
// —— 只数清单会把「清单说有、字节没落地」判成有,只数 `img:` 键会漏掉顺序这一半。
async function draftImageCount(key) {
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
  }, key);
}

/** 等暂存图真落到磁盘上(重载前必等,否则重载抢在事务提交前)。 */
async function waitImagesOnDisk(entry, n, what) {
  await browser.waitUntil(async () => (await draftImageCount(KEYS[entry].img)) === n, {
    timeout: 10000,
    timeoutMsg: `${what}:IndexedDB(${KEYS[entry].img})里应有 ${n} 张暂存图`,
  });
}

/** 记下 = 稿了结:两把钥匙都得从磁盘上消失(清稿本身也是异步的,故用等待而非即时断言)。 */
async function waitDraftCleared(entry, what) {
  await waitImagesOnDisk(entry, 0, what);
  await browser.waitUntil(
    async () =>
      (await browser.execute((k) => localStorage.getItem(k), KEYS[entry].text)) === null,
    { timeout: 10000, timeoutMsg: `${what}:localStorage(${KEYS[entry].text})里的文字草稿应已清` },
  );
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

describe("草稿断电恢复 · 捕获浮窗", () => {
  before(async () => {
    await goShow("/index.html");
    await clearInbox();
  });

  it("打字+贴图 → 整页重载 → 文字+图回填;记下后重载不复现", async () => {
    const ta = await $("#capture");
    await ta.waitForExist({ timeout: 10000 });
    await ta.click();
    await ta.setValue("E2E-断电-捕获"); // 真按键 → input 事件 → 文字入 localStorage
    await pasteImage("#capture"); // 暂存图 → IndexedDB
    await $("#cap-images .img-thumb").waitForExist({ timeout: 5000 });
    await waitImagesOnDisk("capture", 1, "重载前"); // ← thumb 进 DOM ≠ 已落盘,见顶部 ①

    await goShow("/index.html"); // ← 断电 proxy:整页重载
    const ta2 = await $("#capture");
    await ta2.waitForExist({ timeout: 10000 });
    await browser.waitUntil(async () => (await ta2.getValue()) === "E2E-断电-捕获", {
      timeout: 5000,
      timeoutMsg: "重载后文字草稿未回填",
    });
    await $("#cap-images .img-thumb").waitForExist({
      timeout: 5000,
      timeoutMsg: "重载后暂存图未回填",
    });

    // 回填的稿能正常记下(回填的 Blob 能入库),入库带 1 张配图。
    await ta2.click();
    await browser.keys("Enter");
    let noteId;
    await browser.waitUntil(
      async () => {
        const ideas = await invoke("list_ideas");
        const hit = ideas.find((n) => n.content === "E2E-断电-捕获");
        if (hit) noteId = hit.id;
        return !!hit;
      },
      { timeout: 6000, timeoutMsg: "回填稿记下后未入库" },
    );
    await waitItemImages(noteId, 1, "断电恢复·捕获");

    // 记下 = 稿了结:持久化已清(权威判据,见顶部 ②),故再重载也复现不出来。
    await waitDraftCleared("capture", "捕获浮窗记下后");
    await goShow("/index.html");
    const ta3 = await $("#capture");
    await ta3.waitForExist({ timeout: 10000 });
    expect(await ta3.getValue()).toBe("");
    expect((await $$("#cap-images .img-thumb")).length).toBe(0);
    await clearInbox();
  });
});

describe("草稿断电恢复 · 灵感「记下灵感」", () => {
  before(async () => {
    await goNotebook("inbox");
    await clearInbox();
  });

  it("打字+贴图 → 重载笔记本 → 文字+图回填;记下后重载不复现", async () => {
    const input = await $(".v-inbox .compose-input");
    await input.waitForExist({ timeout: 10000 });
    await input.click();
    await input.setValue("E2E-断电-灵感");
    await pasteImage(".v-inbox .compose-input");
    await $(".v-inbox .compose .img-pending .img-thumb").waitForExist({ timeout: 5000 });
    await waitImagesOnDisk("inbox", 1, "重载前"); // ← 见顶部 ①

    await goNotebook("inbox"); // ← 断电 proxy:整页重载 + 回到灵感
    const input2 = await $(".v-inbox .compose-input");
    await input2.waitForExist({ timeout: 10000 });
    await browser.waitUntil(async () => (await input2.getValue()) === "E2E-断电-灵感", {
      timeout: 5000,
      timeoutMsg: "重载后灵感草稿未回填",
    });
    await $(".v-inbox .compose .img-pending .img-thumb").waitForExist({
      timeout: 5000,
      timeoutMsg: "重载后灵感暂存图未回填",
    });

    await input2.click();
    await browser.keys("Enter");
    let noteId;
    await browser.waitUntil(
      async () => {
        const ideas = await invoke("list_ideas");
        const hit = ideas.find((n) => n.content === "E2E-断电-灵感");
        if (hit) noteId = hit.id;
        return !!hit;
      },
      { timeout: 6000, timeoutMsg: "回填灵感记下后未入库" },
    );
    await waitItemImages(noteId, 1, "断电恢复·灵感");

    await waitDraftCleared("inbox", "灵感记下后"); // ← 权威判据,见顶部 ②
    await goNotebook("inbox");
    const input3 = await $(".v-inbox .compose-input");
    await input3.waitForExist({ timeout: 10000 });
    expect(await input3.getValue()).toBe("");
    expect((await $$(".v-inbox .compose .img-pending .img-thumb")).length).toBe(0);
    await clearInbox();
  });
});

describe("草稿断电恢复 · 看板「新建任务」", () => {
  before(async () => {
    await goNotebook("board");
  });

  it("打字+贴图 → 重载笔记本 → 文字+图回填(compose 自动开回);记下后重载不复现", async () => {
    await openCompose(); // ⚠ 别写成裸 click:`#add-task` 是开关,见 support.js 那段注释
    const input = await $("#compose-input");
    await input.click();
    await input.setValue("E2E-断电-任务");
    await pasteImage("#compose-input");
    await $(".v-board .compose .img-pending .img-thumb").waitForExist({ timeout: 5000 });
    await waitImagesOnDisk("board", 1, "重载前"); // ← 见顶部 ①

    await goNotebook("board"); // ← 断电 proxy:整页重载 + 回到看板
    // 有文字草稿 → compose 应被回填并自动开回(setComposeOpen(true)),输入框可见带字。
    const input2 = await $("#compose-input");
    await input2.waitForDisplayed({ timeout: 5000, timeoutMsg: "重载后 compose 未自动开回" });
    await browser.waitUntil(async () => (await input2.getValue()) === "E2E-断电-任务", {
      timeout: 5000,
      timeoutMsg: "重载后任务草稿未回填",
    });
    await $(".v-board .compose .img-pending .img-thumb").waitForExist({
      timeout: 5000,
      timeoutMsg: "重载后任务暂存图未回填",
    });

    await input2.click();
    await browser.keys("Enter");
    let taskId;
    await browser.waitUntil(
      async () => {
        const tasks = await invoke("list_tasks");
        const hit = tasks.find((t) => t.title === "E2E-断电-任务");
        if (hit) taskId = hit.id;
        return !!hit;
      },
      { timeout: 6000, timeoutMsg: "回填任务记下后未入库" },
    );
    await waitItemImages(taskId, 1, "断电恢复·任务");

    await waitDraftCleared("board", "任务记下后"); // ← 权威判据,见顶部 ②
    await goNotebook("board");
    // 记下后重载:草稿不复现(compose 无字 → 收起;暂存条无 thumb)。
    expect((await $$(".v-board .compose .img-pending .img-thumb")).length).toBe(0);
    const live = await $("#compose-input");
    if (await live.isDisplayed()) expect(await live.getValue()).toBe("");

    // 清库:归档 + 彻底删,连图带计数 CASCADE。
    await invoke("archive_task", { id: taskId });
    await invoke("purge_task", { id: taskId });
  });
});

// 393 起三个入口的暂存图**共用一个 IndexedDB store、按桶分键**(`<桶>::order` +
// `<桶>::img:<id>`),而每次写入都会「把本桶收敛到 held」——顺带删掉本桶里不再持有的键。
// ⚠ 那个 delete 的扫描面一旦写宽(漏掉「只动本桶」这道判断),**在 A 入口贴一张图就会把
// B 入口那份没记下的草稿删掉**,而且一声不响。上面三例各自只碰一个桶,照不出这一格。
describe("草稿断电恢复 · 跨入口互不串", () => {
  before(async () => {
    await goShow("/index.html");
    await clearInbox();
  });

  it("在灵感里贴图,不许动到捕获浮窗那份没记下的草稿", async () => {
    // ① 捕获浮窗先存一份草稿(文字 + 1 张图),不记下。
    const ta = await $("#capture");
    await ta.waitForExist({ timeout: 10000 });
    await ta.click();
    await ta.setValue("E2E-跨桶-捕获");
    await pasteImage("#capture");
    await waitImagesOnDisk("capture", 1, "跨桶:捕获那份存好");

    // ② 换到笔记本的灵感入口,在**另一个桶**里贴一张、再删掉——一加一删两次写入,
    //    两次都会跑本桶收敛(删那次尤其:它是唯一会发 delete 的路径)。
    await goNotebook("inbox");
    const input = await $(".v-inbox .compose-input");
    await input.waitForExist({ timeout: 10000 });
    await input.click();
    await pasteImage(".v-inbox .compose-input");
    await waitImagesOnDisk("inbox", 1, "跨桶:灵感那份写进去");
    await $(".v-inbox .compose .img-pending .img-thumb .img-del").click();
    await waitImagesOnDisk("inbox", 0, "跨桶:灵感那份删掉");

    // ③ 捕获浮窗那份必须一张不少、文字也还在(它跟这一切毫无关系)。
    expect(await draftImageCount(KEYS.capture.img)).toBe(1);
    expect(
      await browser.execute((k) => localStorage.getItem(k), KEYS.capture.text),
    ).not.toBe(null);

    // ④ 清场:两个桶都清干净(捕获那份没记下过,得手动清)。
    await goShow("/index.html");
    const ta2 = await $("#capture");
    await ta2.waitForExist({ timeout: 10000 });
    await browser.waitUntil(async () => (await ta2.getValue()) === "E2E-跨桶-捕获", {
      timeout: 5000,
      timeoutMsg: "跨桶:捕获那份重载后没回填(它本该完好)",
    });
    await ta2.click();
    await browser.keys("Enter");
    let noteId;
    await browser.waitUntil(
      async () => {
        const ideas = await invoke("list_ideas");
        const hit = ideas.find((n) => n.content === "E2E-跨桶-捕获");
        if (hit) noteId = hit.id;
        return !!hit;
      },
      { timeout: 6000, timeoutMsg: "跨桶:捕获那份记下后未入库" },
    );
    await waitItemImages(noteId, 1, "跨桶·捕获");
    await waitDraftCleared("capture", "跨桶收场");
    await clearInbox();
  });
});

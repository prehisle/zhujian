import { browser, $ } from "@wdio/globals";
import { goShow } from "../specs/support.js";

// 观测探针(默认套件扫不到,⛔ 别并进去):量**上一支 spec 给下一支留下了什么浏览器存储**。
//
// 为什么需要它:两端在这件事上**不对称,而不对称的那一端是安静的**。Windows 每支 spec 换一个
// 新 WebView2 profile(`e2e/webview2-profile.js` 的 `isWin` 门)⇒ 跨 spec 的 localStorage /
// IndexedDB 残留在那一端**结构性地看不见**;Linux/WebKitGTK 全程共用一个 profile,同一笔残留
// 不但跨 spec、**还跨整趟 run**。⇒ 「Windows 上没红过」⛔ 不是「没漏」的字据。
// 已经被它逮到过一条:`capture.e2e.js` 亮了任务 chip 又故意不记下 ⇒ `zhujian.capture-mods`
// 留成 `{"mode":"task"}` ⇒ 后面的 spec 往捕获窗按回车存出来的是**任务**不是想法,
// `compose-recovery` 于是「整套红、单跑绿」(603;修法 = 把那个键补进 `wdio.conf.js` 的
// `before` 清单,那份清单 396 立)。
//
// ⚠ **读数怎么读**:`wdio.conf.js` 的 `before` 每支开跑前会清那份名单里的键 ⇒ 本探针**单独跑
// 时读到的恒是清完之后的样子**。要量「某支 spec 漏了什么」,得把它排在那支后面同趟跑,
// 且看的是**名单外**还剩什么:
//   YS_E2E_FAST=1 npx wdio run e2e/wdio.conf.js --specFileRetries=0 \
//     --spec e2e/specs/<被测那支>.e2e.js --spec e2e/probes/storage-leak.e2e.js
// ⛔ 别把它写成断言 —— 它答的是「现在是什么」,不是「该是什么」;哪些键算泄漏要人来判。
describe("probe · 上一支 spec 留下的浏览器存储", () => {
  it("印出本源下所有 zhujian.* 键与暂存图张数", async () => {
    await goShow("/index.html");
    await $("#capture").waitForExist({ timeout: 10000 });
    const ls = await browser.execute(() =>
      Object.fromEntries(
        Object.keys(localStorage)
          .filter((k) => k.startsWith("zhujian."))
          .sort()
          .map((k) => [k, localStorage.getItem(k)]),
      ),
    );
    const draftImages = await browser.executeAsync((done) => {
      const req = indexedDB.open("zhujian-compose-draft", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("images");
      req.onerror = () => done("open-failed");
      req.onsuccess = () => {
        const tx = req.result.transaction("images", "readonly");
        const c = tx.objectStore("images").count();
        c.onsuccess = () => done(c.result);
        c.onerror = () => done("count-failed");
      };
    });
    console.log("PROBE-STORAGE " + JSON.stringify({ localStorage: ls, draftImages }));
  });
});

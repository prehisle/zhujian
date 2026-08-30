// 按需探针(默认套件扫不到,要 `--spec` 点名)—— 截止提醒(用户面 39)的**真通知管道**。
//
// 主 spec `due-reminder.e2e.js` 断的是判定缝与水位,**刻意不碰 sendNotification**;
// 这支把设置面「试一条」真点一遍:msg 行落「已发送,请看系统通知」= 整条管道
// (Rust 插件注册 + capability `notification:default` + winrt 发送)一路成功。
// **真副作用 = 桌面上真的会弹一条系统通知**(所以不进默认套件);toast 的像素这里
// 断不了,只有人眼能收 —— 屏上没弹而 msg 说已发送 = 勿扰/专注模式吞了,那不是缺陷。
// ⚠ Linux/WebKitGTK 上别跑:notify-rust 走 DBus,无通知守护(headless CI)时会红,
//   红的是环境不是产品。
//
// 跑法(Windows,先另起终端 `npm run dev`):
//   YS_E2E_FAST=1 npm run test:e2e -- --specFileRetries=0 --spec e2e/probes/due-reminder-notify.e2e.js
//
// 顺带存一张设置面「截止提醒」一节的截图(out-due-reminder-settings.png,门禁全绿
// ≠ 长得对,memory `gates-green-is-not-looks-right`)。
import { browser, $, expect } from "@wdio/globals";
import { goNotebook } from "../specs/support.js";

describe("探针 · 截止提醒的真通知管道(试一条)", () => {
  it("点「试一条」→ msg 行落「已发送」= 插件/capability/发送一路通", async () => {
    await goNotebook("board");
    await browser.execute(() => document.getElementById("settings-entry").click());
    await $(".settings-panel").waitForExist({ timeout: 5000 });
    await $(".remind-ctrls").waitForExist({ timeout: 5000 });
    // 这一节在「通用」页最底,settings-content 是滚动容器 —— 滚进视口再读,否则
    // msedgedriver 的 isDisplayed 判「滚出容器 = 不可见」,shownText 恒抛。
    await browser.execute(() => document.querySelector(".remind-ctrls").scrollIntoView({ block: "center" }));
    await browser.saveScreenshot("./e2e/probes/out-due-reminder-settings.png");
    await browser.execute(() => {
      window.__probeMark = 1;
      [...document.querySelectorAll(".remind-ctrls button")].at(-1).click();
    });
    // 成功话术按字典键的中文形断;失败时 msg 是 String(e)(插件缺席/权限拒),整句打出来。
    // ⛔ **这儿不用 shownText**(纪律②的例外,证据在案):msedgedriver 的 isDisplayed 对
    // 设置浮层里这行 msg 恒答不可见,而同一刻页内 textContent 已是「已发送…」、点击后
    // 300ms 链就落定(一次性诊断实测轨迹:0ms disabled=true → 300ms disabled=false +
    // msg 已落)。拿驱动判定当可见性会把「有字但驱动说看不见」压成「没字」——
    // 改页内直读 + 几何非零当可见性,三态分开报。
    const readMsg = () =>
      browser.execute(() => {
        const n = document.querySelector("#remind-msg");
        const ctx = {
          overlay: !!document.querySelector(".settings-overlay"),
          mark: window.__probeMark === 1, // 点前埋的记号;false = 页面被整页重载过
        };
        if (!n) return { state: "absent", text: "", ...ctx };
        const r = n.getBoundingClientRect();
        return { state: r.height > 0 && r.width > 0 ? "shown" : "zero-size", text: n.textContent.trim(), ...ctx };
      });
    let last = { state: "never-read", text: "" };
    await browser.waitUntil(
      async () => (last = await readMsg()).state === "shown" && last.text.length > 0,
      {
        timeout: 8000,
        timeoutMsg: "点了「试一条」8s 内 msg 行没落话(最后一眼见探针 .catch 分岔)",
      },
    ).catch((e) => {
      if (last.state === "never-read") throw e;
      throw new Error(
        `8s 内 msg 未就绪:最后一眼 state=${last.state} text=「${last.text}」 overlay=${last.overlay} 记号还在=${last.mark}`,
      );
    });
    expect(last.text).toBe("已发送,请看系统通知");
  });
});

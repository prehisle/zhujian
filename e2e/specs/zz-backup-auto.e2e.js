import { $, expect, browser } from "@wdio/globals";
import { goNotebook, invoke, shownText } from "./support.js";

// 自动备份(笔①-b,backup-plan §15.7 那只)。**只钉 core 测不到的三格**:
// ①开关**真持久化**(命令 → 盘 → 再读回来);②失败提示条真弹得出来;③**去抖**。
//
// ⛔ 判定面(该不该跑 / 删哪些旧的 / 错误怎么分档)全在 core 单测里,那里能造出真实
// 时间窗口与故障;这里**绝不等真时间**——那根 60 秒的线程在 e2e 下根本不起(lib.rs)。
//
// ⚠ 文件名以 `zz-` 开头**是有原因的**:spec 按文件名排序跑,而 `backup.e2e.js` 的第一格
// 断言「还没设置过备份」——本 spec 会把配置写出来,排在它前面就会把它弄红。
//
// ⭐ 去抖那三格的断言形是设计审三弹 M3 给的(⛔ 别退回「注入两次、页面上只有一个 banner」:
// banner 是先 remove 再重建,**哪怕一点去抖都没有,数量也恒是 1** ⇒ 那么写会假绿):
//   ①注入原因 A → 出现;②用户关掉;③再注入 A → **不再出现**;④注入原因 B → 出现
//   (第④步证明不是监听器死了)。

const SEL = ".auto-backup-banner";

/** 从页内注入一条 `backup://auto`(仓里已有先例:item-comments 那只)。 */
async function emitAuto(reason, text) {
  await browser.execute(
    (r, t) => window.__TAURI__.event.emit("backup://auto", { reason: r, text: t }),
    reason,
    text,
  );
}

async function bannerCount() {
  return browser.execute((s) => document.querySelectorAll(s).length, SEL);
}

/** 同 backup.e2e.js:445 起要先点进「备份与恢复」那一类(按 `data-cat` 认,不按文字)。 */
async function openBackupSection() {
  await goNotebook("inbox");
  await browser.execute(() => document.getElementById("settings-entry").click());
  await $(".settings-panel").waitForExist({ timeout: 5000 });
  const cat = await $('.settings-cat[data-cat="backup"]');
  await cat.waitForExist({ timeout: 5000 });
  await browser.execute(() => document.querySelector('.settings-cat[data-cat="backup"]').click());
  const body = await $(".bkup-body");
  await body.waitForExist({ timeout: 5000 });
  await body.scrollIntoView();
  return body;
}

async function clickByText(label) {
  await browser.execute((l) => {
    const b = [...document.querySelectorAll(".settings-panel button")].find(
      (n) => n.textContent.trim() === l,
    );
    if (!b) throw new Error("设置面板里没有按钮:" + l);
    b.click();
  }, label);
}

describe("自动备份(笔①-b):开关真落盘 + 失败提示条与去抖", () => {
  it("没设置过备份时不许开(没有钥就没有可自动的东西)", async () => {
    if ((await invoke("backup_status")).configured) return; // 前一支 spec 已经设置过了
    const st = await invoke("backup_auto_status");
    expect(st.enabled).toBe(false); // ⛔ 默认关
    const denied = await browser.execute(
      async () =>
        await window.__TAURI_INTERNALS__
          .invoke("backup_set_auto", { enabled: true })
          .then(() => null)
          .catch((e) => String(e)),
    );
    expect(denied).toContain("还没设置备份");
  });

  it("开关真持久化:点开 → 后端读回来仍是开,频率与份数是从状态里读出来的", async () => {
    // 没设置过就先把仪式走完(用命令,不重复 backup.e2e.js 的 UI 那一段)。
    if (!(await invoke("backup_status")).configured) {
      const code = await invoke("backup_begin_setup", { dir: null });
      await invoke("backup_confirm_setup", { code });
    }
    await openBackupSection();
    // ⚠ 「自动备份」那一节在长面板的**最下面**:等它的按钮出现即可,⛔ 别对它用可见性断言
    //(面板要滚动,元素存在但不在视口里 —— 第一版就红在这儿,不是产品问题)。
    await browser.waitUntil(
      async () =>
        await browser.execute(() =>
          [...document.querySelectorAll(".settings-panel button")]
            .map((b) => b.textContent.trim())
            .some((t) => t === "开启" || t === "关闭"),
        ),
      { timeout: 5000, timeoutMsg: "「自动备份」那一节该渲染出来" },
    );

    await clickByText("开启");
    await browser.waitUntil(async () => (await invoke("backup_auto_status")).enabled === true, {
      timeout: 5000,
      timeoutMsg: "开关要真的落进 .backup-auto.json",
    });

    // ⭐ 说明句里的频率与份数是**读出来的**,不是写死的(设计审 H4:文件可手改,写死就会说谎)。
    const st = await invoke("backup_auto_status");
    const texts = await browser.execute(() =>
      [...document.querySelectorAll(".bkup-body .settings-sub")].map((n) => n.textContent),
    );
    expect(texts.join(" ")).toContain(`保留最近 ${st.keep} 份`);
    // ⛔ 那句承诺的措辞不许写成绝对形(残余 TOCTOU 就是它的反例,设计审三弹 M2)。
    expect(texts.join(" ")).toContain("不再管这个文件");
    expect(texts.join(" ")).not.toContain("永远不会被自动删除");

    // 再关回去:同样落盘。
    await clickByText("关闭");
    await browser.waitUntil(async () => (await invoke("backup_auto_status")).enabled === false, {
      timeout: 5000,
      timeoutMsg: "关也要落盘",
    });
  });

  it("失败提示条:出现 → 用户关掉 → 同一原因不再弹 → 换个原因照旧弹", async () => {
    await goNotebook("inbox");
    await emitAuto("refused:测试原因 A", "自动备份没跑成:测试原因 A");
    const banner = await $(SEL);
    // ⚠ **等的是「显出来了」不是「存在」**:下一句 shownText 里那道 isDisplayed 闸要的是可见,
    // 而提示条有入场过渡 —— waitForExist 满足得更早,中间那一段就是纯运气。
    await banner.waitForDisplayed({ timeout: 5000 });
    expect(await shownText($(`${SEL} .update-notes`))).toContain("测试原因 A");

    // ②用户关掉
    await clickInBanner("知道了");
    await browser.waitUntil(async () => (await bannerCount()) === 0, {
      timeout: 5000,
      timeoutMsg: "点「知道了」该收起来",
    });

    // ③同一个原因再来 —— ⛔ 不许再弹(60 秒一 tick,不去抖就是每分钟一张脸)
    await emitAuto("refused:测试原因 A", "自动备份没跑成:测试原因 A");
    await browser.pause(300);
    expect(await bannerCount()).toBe(0);

    // ④换一个原因 —— 照旧弹(证明不是监听器死了)
    await emitAuto("refused:测试原因 B", "自动备份没跑成:测试原因 B");
    // ⭐ **这一处是 505 从 CI 上逮到的那格**(Linux/WebKitGTK 红在 shownText 的「元素存在但不可见」):
    // ④ 比 ① 更险 —— 提示条刚在 ② 被收掉、这里是**重建**的一张,入场过渡还没跑完就被断言了。
    // ⚠ **诚实边界:Windows 这一端两种写法都绿,分不出差别** ⇒ 这一改能不能真销掉那格红,
    // 判官只有公开仓那趟 Linux e2e。
    await $(SEL).waitForDisplayed({ timeout: 5000 });
    expect(await shownText($(`${SEL} .update-notes`))).toContain("测试原因 B");
    await clickInBanner("知道了");
  });
});

async function clickInBanner(label) {
  await browser.execute(
    (sel, l) => {
      const b = [...document.querySelectorAll(sel + " button")].find(
        (n) => n.textContent.trim() === l,
      );
      if (!b) throw new Error("提示条里没有按钮:" + l);
      b.click();
    },
    SEL,
    label,
  );
}

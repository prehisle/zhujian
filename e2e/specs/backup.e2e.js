import { $, $$, expect, browser } from "@wdio/globals";
import { goNotebook, invoke, shownText, tryInvoke } from "./support.js";

// 加密备份的最小端到端(backup-plan §10 的那只默认 e2e,412):**仪式 → 命令 → 产物在列**。
//
// 覆盖面刻意窄:多空间 / 磁盘故障 / 部分成功 / 明文清场的阶段矩阵全在 core 单测里
// (故障注入比在真 GUI 上造更准);这里只钉那条 core 测不到的:**壳与前端把它接对了没有**。
//
// ⚠ 三件与本仓纪律有关的:
// ① 目标目录是**预置的临时目录**(`<YS_DB_PATH>.backups`,壳按库派生)—— ⛔ 名字里
//    不许出现「选目录」:原生目录选择框 WebDriver 驱动不了,v1 也根本没有那个能力(§5.2)。
// ② 配置与暂存区**双双按 `YS_DB_PATH` 独占**(`<db>.backup.json` / `<db>.backup-staging`),
//    绝不碰真实用户配置(memory `isolate-data-dir-before-real-machine-testing` 同族的坑)。
//    三者由 `wdio.conf.js` 的 onPrepare 与库一起清,故本 spec 的前提是「这一趟是干净的」。
// ③ 元素文字一律走 `shownText`(396 纪律:WebKitGTK 的 getText 对已渲染元素读回空串)。

const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){12}$/;

/** 打开设置面板并把「备份」那一节滚进视野。 */
async function openBackupSection() {
  await goNotebook("inbox");
  await browser.execute(() => document.getElementById("settings-entry").click());
  await $(".settings-panel").waitForExist({ timeout: 5000 });
  const body = await $(".bkup-body");
  await body.waitForExist({ timeout: 5000 });
  await body.scrollIntoView();
  return body;
}

/** 面板里按可见文字点一枚按钮(面板长、真点会被滚动影响,统一走页内 click)。 */
async function clickByText(label) {
  await browser.execute((l) => {
    const b = [...document.querySelectorAll(".settings-panel button")].find(
      (n) => n.textContent.trim() === l,
    );
    if (!b) throw new Error("设置面板里没有按钮:" + l);
    b.click();
  }, label);
}

describe("加密备份(笔①-a):仪式 → 备份 → 产物在列", () => {
  it("没设置过时:状态说「还没设置」,且此时备份命令响亮拒", async () => {
    const st = await invoke("backup_status");
    expect(st.configured).toBe(false);
    expect(st.blocked).toBe(null);
    expect(st.awaiting_ceremony).toBe(false);
    // ⚠ 这只 spec 要求备份配置是干净的。红在这里通常不是产品缺陷,而是**这一趟不新鲜**
    // (spec 重试:上一次尝试已经写过配置)—— 用 `--specFileRetries=0` 或重跑整套。

    // 没走仪式就不许产文件:命令层当场拒(⛔ 失败路径走 tryInvoke,不用 rejects.toThrow)。
    const denied = await tryInvoke("backup_run");
    expect(denied.ok).toBe(false);
    expect(denied.err).toContain("还没设置备份");

    const body = await openBackupSection();
    expect(await shownText(body.$(".hkset-desc"))).toBe("还没设置");
  });

  it("仪式:显示码 → 回输核对对上了才落盘;⛔ 码只能手抄(没有复制按钮)", async () => {
    const body = await openBackupSection();
    await clickByText("设置备份");

    const code = await $(".bkup-code");
    await code.waitForExist({ timeout: 5000 });
    const shown = await shownText(code);
    expect(shown).toMatch(CODE_RE);

    // ⛔ backup-plan §3.4.1 第 11 格:v1 **不提供**「复制备份码」按钮 —— 一写剪贴板,
    // 剪贴板就成了新的所有者,而系统剪贴板我们清不干净。这一条要有网,别哪天被"顺手加上"。
    const labels = await browser.execute(() =>
      [...document.querySelectorAll(".settings-panel button")].map((b) => b.textContent.trim()),
    );
    expect(labels.some((l) => l.includes("复制"))).toBe(false);

    // 显示码的这一刻钥只在进程内:后端还没写配置。
    expect((await invoke("backup_status")).configured).toBe(false);
    expect((await invoke("backup_status")).awaiting_ceremony).toBe(true);

    // 先抄错一个字符:必须拒,且**盘上仍然没有配置**。
    const wrong = shown.slice(0, -1) + (shown.endsWith("A") ? "B" : "A");
    await (await $(".bkup-input")).setValue(wrong);
    await clickByText("抄好了,核对");
    await browser.waitUntil(
      async () => (await shownText($(".bkup-body .hkset-msg.err"))).length > 0,
      { timeout: 5000, timeoutMsg: "抄错了该给一句响亮的话" },
    );
    expect((await invoke("backup_status")).configured).toBe(false);

    // 抄对:落盘。
    await (await $(".bkup-input")).setValue(shown);
    await clickByText("抄好了,核对");
    await browser.waitUntil(async () => (await invoke("backup_status")).configured === true, {
      timeout: 10000,
      timeoutMsg: "回输对上之后应当写好配置",
    });
    void body;
  });

  it("立即备份:产物在列,且后端自验过(报告里给的是文件名与大小)", async () => {
    await openBackupSection();
    await clickByText("立即备份");
    // 报告里「备好 N 个空间」那句 + 一行产物(e2e 形只有主空间一个)。
    const ok = await $(".bkup-out .hkset-msg.ok");
    await ok.waitForExist({ timeout: 60000 });
    expect(await shownText(ok)).toBe("备好 1 个空间");
    const files = await $$(".bkup-file");
    expect(files.length).toBe(1);
    const line = await shownText(files[0]);
    expect(line).toContain(".zjbak");
    expect(line).toContain("zhujian-main-");

    // 备份不改任何库状态:app 照常能用(随手读一次列表)。
    expect(Array.isArray(await invoke("list_inbox"))).toBe(true);
    // 暂存区没留下明文(留了的话状态会是封锁)。
    expect((await invoke("backup_status")).blocked).toBe(null);
  });
});

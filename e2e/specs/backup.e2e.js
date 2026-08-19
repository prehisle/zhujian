import { $, $$, expect, browser } from "@wdio/globals";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

/** 仪式那一趟显示的真码 —— 恢复那只测要用它跑一次「输入全对」的尝试(见那条注释)。 */
let ceremonyCode = null;

/** 恢复那只测种下的那条记录。⛔ **收尾必须走 `afterEach`,不许写在测尾** ——
 *  中间任何一句断言红掉 / WebDriver 超时,写在测尾的清理根本不会执行,而全套 spec
 *  共用一个**累积库**且默认还开着 spec 重试 ⇒ 一次真红会给后面的用例留下一条多余记录
 *  (codex 实现审 426 复核轮 L1;同形判例见 `e2e/probes/linux-clipboard.e2e.js` 的 afterEach)。 */
let seededNote = null;

/** 打开设置面板、点进「备份与恢复」那一类,并把「备份」那一节滚进视野。
 *
 * ⚠ **445 起那一步是必须的**:设置面板分了三类,备份那一类默认不显示。
 * ⛔ 按 `data-cat` 认那枚按钮,**别按可见文字** —— 文字随界面语言变(i18n-plan)。
 * ⚠ 三类的 DOM 一直都在(只切 `hidden`),所以 `.bkup-body` 就算没点进去也 `waitForExist`
 * 得到 —— 那正是这里**必须真点一下**的原因:不点就走不到用户走的那条路,
 * 而 `scrollIntoView` 与真点击都要它可见。 */
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

    // ⭐ **这台还没配过备份,恢复那一节照样要在**(backup-plan §16.6):换了机器 / 重装
    // 系统之后 `.backup.json` 根本不存在,**而那正是恢复的主场景**。⛔ 把恢复放进
    // 「已配置」分支里,就等于让最需要它的人找不到它。(codex 实现审 426 的 L2:
    // 后面那只恢复用例跑在仪式完成之后,盖不住这一格。)
    const labels = await browser.execute(() =>
      [...document.querySelectorAll(".settings-panel button")].map((b) => b.textContent.trim()),
    );
    expect(labels).toContain("恢复…");
  });

  it("仪式:显示码 → 回输核对对上了才落盘;⛔ 码只能手抄(没有复制按钮)", async () => {
    const body = await openBackupSection();
    await clickByText("设置备份");

    const code = await $(".bkup-code");
    await code.waitForExist({ timeout: 5000 });
    const shown = await shownText(code);
    expect(shown).toMatch(CODE_RE);
    ceremonyCode = shown;

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

  // ⭐ 这一只钉的是 backup-plan §3.3 收口那条义务本身:
  // 「UI 的备份列表要显示**验证状态**,⛔ **文件名 / 扩展名绝不能当『这是一份有效备份』的判据**」。
  // 413 真 SIGKILL 造出来的两份半截产物与成功产物**同目录、同名族、同扩展名**,其中一份还
  // 完全解得开 —— 所以「列出来了」与「能打开」必须是两件事,而且要在**产品里**分得开。
  //
  // ⚠ 冒牌货由 **spec 自己用 node:fs 写**(wdio 的 spec 跑在 Node 进程里,与 app 同机):
  // ⛔ 刻意**不为它加一条 e2e 专用的写文件命令** —— 那是给生产壳加一个只为测试存在的能力面。
  it("备份列表:冒牌货照样在列表里,但默认都是「还没验过」,且只有真的那份验得过", async () => {
    const dir = (await invoke("backup_status")).dir;
    const fake = "zhujian-main-20260101T000000Z-01ZZZZZZZZZZZZZZZZZZZZZZZZZ.zjbak";
    writeFileSync(join(dir, fake), Buffer.alloc(4096, 0x5a));

    await openBackupSection();
    await browser.waitUntil(async () => (await $$(".bkup-item")).length === 2, {
      timeout: 10000,
      timeoutMsg: "冒牌货该和真产物一起被列出来(列表只回盘上事实,不判有效性)",
    });

    // ⭐ 默认每一行都是「还没验过」—— ⛔ 不是空白、更不是「有效」。这就是那条义务的 UI 面。
    const states = await browser.execute(() =>
      [...document.querySelectorAll(".bkup-item-state")].map((n) => n.textContent.trim()),
    );
    expect(states).toEqual(["还没验过", "还没验过"]);

    // 冒牌货与真产物在**列表这一层**长得一样(名字同族、都在列)——分得开它们的只有验证。
    const names = await browser.execute(() =>
      [...document.querySelectorAll(".bkup-item-name")].map((n) => n.textContent.trim()),
    );
    expect(names).toContain(fake);

    // 命令层两种结局:真的那份「解得开」,冒牌那份**响亮拒且理由具体**(结构不对,不是"钥不对")。
    const listed = await invoke("backup_list");
    const realName = listed.map((e) => e.file_name).find((n) => n !== fake);
    // ⚠ 成功那半走 `invoke`(它回真值);`tryInvoke` 只在**失败路径**用 —— 它成功时
    // 回的是 `{ok:true}`、**没有 value**(我第一版写成 `good.value.space_id`,当场 TypeError)。
    const good = await invoke("backup_verify", { path: join(dir, realName) });
    expect(good.space_id).toBe("main");

    const bad = await tryInvoke("backup_verify", { path: join(dir, fake) });
    expect(bad.ok).toBe(false);
    expect(bad.err).toContain("结构不对");

    // ⛔ 目录之外的文件一律拒 —— 不设这道闸,这条命令就等于「拿备份钥去解任意路径的文件」。
    const outside = await tryInvoke("backup_verify", { path: join(dir, "..", fake) });
    expect(outside.ok).toBe(false);

    // UI 那半:点真产物那一行的「验证」,状态从「还没验过」变成「现在打得开」。
    await browser.execute((realN) => {
      const row = [...document.querySelectorAll(".bkup-item")].find(
        (r) => r.querySelector(".bkup-item-name").textContent.trim() === realN,
      );
      row.querySelector("button").click();
    }, realName);
    await browser.waitUntil(
      async () => {
        const ok = await $$(".bkup-item-state.ok");
        return ok.length === 1;
      },
      { timeout: 60000, timeoutMsg: "真产物验过之后该有恰一行是「现在打得开」" },
    );
    const okText = await shownText($(".bkup-item-state.ok"));
    expect(okText).toContain("现在打得开");
    // ⛔ 另一行**不许**被连带标成好的 —— 验证是逐份的。
    expect((await $$(".bkup-item-state.err")).length).toBe(0);
    expect(
      (await browser.execute(() =>
        [...document.querySelectorAll(".bkup-item-state")].map((n) => n.textContent.trim()),
      )).filter((x) => x === "还没验过").length,
    ).toBe(1);
  });

  // ⭐ 恢复(笔②,§16):**e2e 形跑不了恢复,这是设计不是缺陷**。`YS_DB_PATH` 那一形
  // `scan_dir = None` = 禁扫也禁建空间(§六③,壳里另有「不加入 / 不建 / 不重置空间」
  // 三处同形拒),恢复根本没有落点、就算硬落在库旁边也没有任何一条发现路会看见它。
  // ⛔ **不许为了让「空间数 +1」那句断言变绿去改 `YS_DB_PATH` 的单库契约**(codex 实现审
  // 当场判的:那不是"缺一个恢复目录",是整个测试形的契约)。
  // ⇒ 这只测换观测面,钉四件 core 测不到的**壳与前端接线**:
  //   ①前端把命令接上了(表单 → invoke → 后端原话回到屏幕上);
  //   ②那句拒来得**比"码对不对"还早**(证明落点闸在解码之前,顺带证明零明文产出);
  //   ③原主库与空间数分毫未动;④暂存区没留下明文(状态不是封锁)。
  // 「真恢复出一个新空间」那一半由 core 的 production 形测与 §16.17.3 的真机验收承担。
  it("恢复:测试形下响亮拒,拒得比「码对不对」还早;主库、空间数与暂存区分毫未动", async () => {
    // ⭐ 快照要**深**,不是「还读得出来」(codex 实现审 426 的 M1:`Array.isArray` 那句
    // 在库被清空时照样绿)。先种一条,保证快照非空 —— 空快照的逐字比对什么都证明不了。
    seededNote = await invoke("capture_note", { content: "恢复不许碰主库-426" });
    const spacesBefore = await invoke("list_spaces");
    const inboxBefore = await invoke("list_inbox");

    // 三处路径全**按库派生**(与壳里 `BackupPaths::for_db` 同一条规则):落点目录是
    // `<db>.backups`,所以把这个后缀摘掉就拿到了 `YS_DB_PATH` 本身。
    const dir = (await invoke("backup_status")).dir;
    const dbPath = dir.slice(0, -".backups".length);
    const dbDir = dirname(dbPath);
    const staging = `${dbPath}.backup-staging`;
    // 「旁边不出现孤儿空间」= 库所在目录里不许**新**冒出 `<26位ULID>.sqlite3`(恢复落位
    // 就是这个形)。⛔ 别去比整个目录的文件表(那是系统临时目录,别人也在写),
    // ⛔ 也别断言它**先验为空** —— 上次异常退出 / 手工实验留下的同形文件会被算到本例头上
    // (codex 实现审 426 复核轮 L2)。⇒ 前后各取一次,比的是**差集**。
    const orphans = () =>
      readdirSync(dbDir).filter((n) => /^[0-9A-Z]{26}\.sqlite3$/.test(n)).sort();
    const orphansBefore = orphans();

    // ⚠ **必须挑真的那一份**(上一只测在同目录留了一份冒牌货):判别式就是「验得过」——
    // ⛔ 别拿 `listed[0]` 凑数,那样下面「什么都对」那一趟其实死在魔数上,而不是死在落点闸上
    //(第一版就是这么写的,阴性对照当场把它照出来:红的那句是"魔数不对")。
    const listed = await invoke("backup_list");
    let candidate = null;
    for (const e of listed) {
      if ((await tryInvoke("backup_verify", { path: e.path })).ok) candidate = e;
    }
    expect(candidate).toBeTruthy();

    // ⭐ **先跑「什么都对」那一趟**:真产物 + 真备份码 —— 它才让下面那两句
    // (无孤儿 / 暂存区空)真的**有牙齿** —— 输入全对时,唯一还拦着它的就是那道落点闸;
    // 谁哪天给 e2e 形补一个落点(比如退回 `main_db.parent()`),库就会真的落在主库旁边,
    // 而 `list_spaces` 在这一形下**天生看不见**它(`scan_dir=None`)⇒ 只有文件系统看得见。
    expect(ceremonyCode).toMatch(CODE_RE);
    const real = await tryInvoke("backup_restore", { file: candidate.path, code: ceremonyCode });
    expect(real.ok).toBe(false);
    expect(real.err).toContain("测试模式");

    // ⭐ 主库**逐字未动**(深比对,不是「还读得出来」):条目全表 + 空间表的 id/名字。
    // ⚠ `list_spaces` 里的 `status` 会随同步任务自己变,**别整份比** —— 比 id 与名字。
    expect(await invoke("list_inbox")).toEqual(inboxBefore);
    const idOf = (all) => all.map((s) => `${s.id}|${s.name}`);
    expect(idOf(await invoke("list_spaces"))).toEqual(idOf(spacesBefore));
    // 旁边不出现孤儿空间文件 + 暂存区没留明文(**目录为空或根本不存在**,
    // ⛔ `blocked === null` 不是这件事的证明:封锁只在明文删不掉时才置)。
    expect(orphans()).toEqual(orphansBefore);
    expect(existsSync(staging) ? readdirSync(staging) : []).toEqual([]);
    expect((await invoke("backup_status")).blocked).toBe(null);

    await openBackupSection();
    await clickByText("恢复…");
    const form = await $(".bkup-restore");
    await form.waitForExist({ timeout: 5000 });

    // ⭐ 四条前置提示,**逐条 + 逐格**(§16.9/§16.11:绝不覆盖 / 不同步 / 会多一个空间 /
    // 不能取消·没有进度·要 ≈3 倍盘)。⛔ 这四条是判据不是版面。
    // ⚠ 第四条要**三格全断**(codex 实现审 426 的 L2:只断「不能取消」的话,删掉
    //「没有进度」或「3 倍磁盘」照样绿)。
    const leads = await browser.execute(() =>
      [...document.querySelectorAll(".bkup-restore .settings-sub, .bkup-restore .hkset-msg.err")].map(
        (n) => n.textContent.trim(),
      ),
    );
    expect(leads.some((l) => l.includes("绝不覆盖任何现有数据"))).toBe(true);
    expect(leads.some((l) => l.includes("不同步"))).toBe(true);
    expect(leads.some((l) => l.includes("多出一个空间"))).toBe(true);
    for (const grain of ["不能取消", "没有进度", "3 倍"]) {
      expect(leads.some((l) => l.includes(grain))).toBe(true);
    }
    // ⭐ **提示必须在按钮之前**,否则用户是在等待时才读到「不能取消」(同 L2):
    // 按 DOM 顺序把表单里的提示与按钮排成一队,四条提示的位置都得比按钮靠前。
    const order = await browser.execute(() =>
      [...document.querySelectorAll(".bkup-restore p, .bkup-restore button")].map((n) =>
        n.tagName === "BUTTON" ? "BTN:" + n.textContent.trim() : "P:" + n.textContent.trim(),
      ),
    );
    const goAt = order.findIndex((x) => x === "BTN:开始恢复");
    expect(goAt).toBeGreaterThan(0);
    for (const grain of ["绝不覆盖任何现有数据", "不同步", "多出一个空间", "不能取消"]) {
      const at = order.findIndex((x) => x.startsWith("P:") && x.includes(grain));
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThan(goAt);
    }

    // 走表单:真路径 + 一把**根本不合法**的码。⭐ 刻意用坏码:那句拒必须是「落点」
    // 那一条,⛔ 不许是「备份码不对」—— 后者意味着落点闸装在解码之后,而幕①之后
    // 就开始有产出明文的可能。这一格是本测唯一钉得住**次序**的断言。
    const fakeCode = "NOT-A-BACKUP-CODE";
    const inputs = await $$(".bkup-restore input");
    expect(inputs.length).toBe(2);
    await inputs[0].setValue(candidate.path);
    await inputs[1].setValue(fakeCode);
    await browser.execute(() => {
      [...document.querySelectorAll(".bkup-restore button")]
        .find((b) => b.textContent.trim() === "开始恢复")
        .click();
    });

    const msg = await $(".bkup-restore .bkup-out .hkset-msg.err");
    await msg.waitForExist({ timeout: 20000 });
    await browser.waitUntil(async () => (await shownText(msg)).includes("测试模式"), {
      timeout: 20000,
      timeoutMsg: "e2e 形该响亮拒「测试模式(YS_DB_PATH)不恢复空间」",
    });
    // ⭐ 拒的理由**必须**是落点,⛔ 不许是「备份码不对」—— 那意味着闸装在解码之后,
    // 而幕①之后就开始有明文产出的可能。
    expect(await shownText(msg)).not.toContain("备份码");
    // ⚠ 顺序有讲究:数据安全那几句(上面)排在 UI 这几句**之前** —— 谁哪天把落点闸
    // 改松了,先红的应当是「输入全对也必须被拒」,而不是一句版面断言。

    // 命令层同一条(⛔ 失败路径走 tryInvoke)。
    const denied = await tryInvoke("backup_restore", { file: candidate.path, code: fakeCode });
    expect(denied.ok).toBe(false);
    expect(denied.err).toContain("测试模式");

  });

  // 种下的那条收走,别把库留脏(163 记账:全套 spec 共用一个累积库)。
  // ⛔ 在这儿,不在测尾:红了也得清。
  afterEach(async function () {
    if (!seededNote) return;
    const id = seededNote;
    seededNote = null;
    const gone = await tryInvoke("delete_note", { id });
    // ⛔ **清理失败不许静静地绿**(codex 实现审 426 第三轮 L1):`tryInvoke` 失败也不抛,
    // 忽略它的返回值 = 那条记录留在累积库里、而且没有第二次机会。判据两段:
    // 正文**已经红**时不叠加第二条错(现场以正文那条为准);正文**绿**时清理失败必须红。
    if (!gone.ok && this.currentTest?.state !== "failed") {
      throw new Error(`收尾没删掉种下的那条记录(它会污染后面的用例):${gone.err}`);
    }
  });
});

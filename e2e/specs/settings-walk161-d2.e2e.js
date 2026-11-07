import { $, expect, browser } from "@wdio/globals";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clearInbox, goNotebook, inboxCompose, invoke, tryInvoke } from "./support.js";

// W4 走查修复(backlog 用户面 161)桌面 D2 组「备份 + 设置其余」—— e2e 证得了的那几格(处理器面):
//   A17  自动备份真跑了一次(壳发 `backup://auto-ran`)⇒ 开着的设置页当场重读:「已有备份」份数跟着变、
//        刚验过的那份不被打回「还没验过」;开着时那一行写隔多久 / 留几份 / 还没跑过
//   A18  恢复时码长得不像备份码:原话下面另起一行指到哪一组(与设置时抄错那句同一个说法)
//   A21  界面字号那一行:到顶「＋」变灰、说「已到最大」,点完那一行还在右栏视口里
//   A22  「加入空间」那块:说明照实指路、钮是全应用那一族、菜单不撑到半屏宽
//   A25  随记页记下第一条,记一笔框不往下跳(筛选那一行先占着位置);看板后冒出来的钮排在「新建任务」左边
//   A29  看板新建那一行收起钮叫「收起」
//   Q6   设置「通用」里有「空间…」,点了收掉设置、开空间菜单;同步面板里的「空间…」恒在
//   Q9   截止提醒说明第一句就是「应用没开着时不会响」
//   Q11  用户指南链官网文档中心(WD-23)/ 关于页「意见反馈」点了跳到那一节、邮箱是 mailto 链接(WD-33)/
//        「修改服务器」那一屏有警告(WD-25)/ 外观 · 语言 · 字号写「只影响这台电脑」(X-10)/
//        重开设置回到上次那一类;改完语言重载后设置开回语言那一行(WD-36)/ 白话词(WD-38)
// 证不了、走真实例的(.zjshots/W4-fix/D2/):真恢复出一个空间后的回执与「去看看」(A16;YS_DB_PATH 形禁恢复)、
// 自动备份那根 60 秒的线程(e2e 下不起)、「检查更新」(要连官网,e2e 不打网络)、字号真挪没挪位置的屏幕读数。

const openSettings = async () => {
  await browser.execute(() => document.getElementById("settings-entry").click());
  await $(".settings-panel").waitForExist({ timeout: 5000 });
};
const showCat = (cat) => browser.execute((c) => document.querySelector(`.settings-cat[data-cat="${c}"]`).click(), cat);
const closeSettings = async () => {
  await browser.execute(() => document.querySelector(".settings-close")?.click());
  await $(".settings-overlay").waitForExist({ timeout: 5000, reverse: true });
};

describe("W4 161 · D2 备份与设置其余", () => {
  it("A17:自动备份真跑了一次 ⇒「已有备份」当场跟着变、验过的那份不丢结论;开着时写隔多久 / 留几份", async () => {
    // backup.e2e.js 已把仪式走完、备了一份(spec 按名排序,b < s);没走过就先走(单跑本 spec 时)。
    if (!(await invoke("backup_status")).configured) {
      const code = await invoke("backup_begin_setup", { dir: null });
      await invoke("backup_confirm_setup", { code });
    }
    // 要的是「有一份验得过的」,⛔ 不是「列表非空」:backup.e2e.js 在同一个文件夹里留了一份冒牌货,
    // 它前面红了的话列表里就只剩那份冒牌货(867 前 Linux CI 就是这么连带红到下面 `good` 那句的)。
    const verifies = async () => {
      for (const e of await invoke("backup_list")) if ((await tryInvoke("backup_verify", { path: e.path })).ok) return true;
      return false;
    };
    if (!(await verifies())) await invoke("backup_run");
    await invoke("backup_set_auto", { enabled: true });
    // ⚠ 开关一开就进 try:中途红了也得关回去 —— 留着开 ⇒ 排在后面的 zz-backup-auto 找不到「开启」钮、跟着红。
    try {
      await goNotebook("inbox");
      await openSettings();
      await showCat("backup");
      const st = await invoke("backup_auto_status");
      await browser.waitUntil(
        async () => (await browser.execute(() => document.querySelector(".bkup-auto-state")?.textContent ?? "")).startsWith("已开启"),
        { timeout: 5000, timeoutMsg: "自动备份那一行没渲染出来" },
      );
      // 开着时那一行照实写两个数(从状态读,⛔ 不写死)。
      expect(await browser.execute(() => document.querySelector(".bkup-auto-state").textContent)).toContain(`留最近 ${st.keep} 份`);
      if (!st.last_success_at && !st.last_result) {
        expect(await browser.execute(() => document.querySelector(".bkup-auto-last").textContent)).toContain("还没自动备过");
      }

      // 先验一份(拿到「现在打得开」),再往文件夹里放一个文件、模拟壳发一枚「跑完了」。
      const listed = await invoke("backup_list");
      const n0 = listed.length;
      // ⚠ 挑真的那一份点「验证」:backup.e2e.js 在同一个文件夹里留了一份冒牌货(验不过)。
      let good = null;
      for (const e of listed) if ((await tryInvoke("backup_verify", { path: e.path })).ok) good = e.file_name;
      expect(good).toBeTruthy();
      await browser.execute((name) => {
        const row = [...document.querySelectorAll(".bkup-item")].find((r) => r.querySelector(".bkup-item-name").textContent.trim() === name);
        row.querySelector("button").click();
      }, good);
      await browser.waitUntil(async () => (await browser.execute(() => !!document.querySelector(".bkup-item-state.ok"))), {
        timeout: 60000,
        timeoutMsg: "第一份没验出「现在打得开」",
      });
      const dir = (await invoke("backup_status")).dir;
      const fake = "zhujian-main-20260102T000000Z-01ZZZZZZZZZZZZZZZZZZZZZZZY.zjbak";
      writeFileSync(join(dir, fake), Buffer.alloc(1024, 0x5a));
      try {
        await browser.execute(() => window.__TAURI__.event.emit("backup://auto-ran", null));
        await browser.waitUntil(
          async () => (await browser.execute(() => document.querySelector(".bkup-list-sum").textContent)).startsWith(`${n0 + 1} 份`),
          { timeout: 5000, timeoutMsg: "「跑完了」之后「已有备份」该当场重读(不用点「刷新」)" },
        );
        // 重读不把刚验过的那份打回「还没验过」。
        expect(await browser.execute(() => document.querySelectorAll(".bkup-item-state.ok").length)).toBe(1);
      } finally {
        rmSync(join(dir, fake), { force: true });
      }
      expect(readdirSync(dir)).not.toContain(fake);
    } finally {
      await invoke("backup_set_auto", { enabled: false });
    }
    await closeSettings();
  });

  it("A18:恢复时码长得不像备份码 —— 原话之外另起一行指到哪一组", async () => {
    await goNotebook("inbox");
    await openSettings();
    await showCat("backup");
    await browser.execute(() =>
      [...document.querySelectorAll(".settings-pane[data-cat='backup'] button")].find((b) => b.textContent.trim() === "恢复…").click(),
    );
    await $(".bkup-restore input").waitForExist({ timeout: 5000 });
    // 路径在 e2e 形里根本走不到(落点闸先拒 = 「测试模式」);码第 3 组只有 3 位。
    await browser.execute(() => {
      const [file, code] = document.querySelectorAll(".bkup-restore input");
      file.value = "C:/nowhere/x.zjbak";
      code.value = "ABCD-EFGH-123";
      [...document.querySelectorAll(".bkup-restore button")].find((b) => b.textContent.trim() === "开始恢复").click();
    });
    await $(".bkup-restore .bkup-code-hint").waitForExist({ timeout: 10000 });
    // ⚠ `.bkup-restore` 自己也是 `.bkup-out`(e2e 准头,backup.ts);结果区是它里面那一只。
    const lines = await browser.execute(() =>
      [...document.querySelectorAll(".bkup-restore .bkup-out .hkset-msg.err")].map((p) => p.textContent),
    );
    // ⛔ 原话照旧在第一行(后端在解码之前的拒,码坏不坏说明不了它这次拒的是什么)。
    expect(lines[0]).toContain("测试模式");
    expect(lines[1]).toBe("第 3 组是 3 位,每组应为 4 位,核对那一组再试。");
    // 码框与设置时抄码那只同形(等宽、宽到放得下整串码)。
    expect(await browser.execute(() => document.querySelectorAll(".bkup-restore .bkup-code-input").length)).toBe(1);
    await closeSettings();
  });

  it("A21:字号到顶「＋」变灰、说「已到最大」,点完那一行还整个在右栏视口里", async () => {
    await goNotebook("inbox");
    await openSettings();
    await showCat("general");
    const read = () =>
      browser.execute(() => {
        const row = document.querySelector(".zoom-size-row");
        const [minus, plus] = row.querySelectorAll("button");
        const r = row.getBoundingClientRect();
        const c = document.querySelector(".settings-content").getBoundingClientRect();
        return {
          val: row.querySelector(".zoom-val").textContent,
          plusOff: plus.disabled,
          minusOff: minus.disabled,
          desc: row.querySelector(".zoom-limit").textContent,
          inView: r.top >= c.top - 1 && r.bottom <= c.bottom + 1,
        };
      });
    expect((await read()).desc).toBe("可调 70% 到 200%");
    try {
      for (let i = 0; i < 14; i++) {
        const now = await read();
        if (now.plusOff) break;
        await browser.execute(() => document.querySelectorAll(".zoom-size-row button")[1].click());
        await browser.waitUntil(async () => (await read()).val !== now.val, {
          timeout: 5000,
          timeoutMsg: `点「＋」之后字号没变(停在 ${now.val})`,
        });
        await browser.pause(150); // 点完那一下的滚动校正在下一帧(settings.ts afterZoomLayout)
      }
      const top = await read();
      expect(top).toEqual({ val: "200%", plusOff: true, minusOff: false, desc: "已到最大(200%)", inView: true });
    } finally {
      // 复位(别把 200% 泄漏给后面的 spec)。
      await browser.execute(() => [...document.querySelectorAll(".zoom-size-row button")].find((b) => b.textContent === "复位").click());
      await browser.waitUntil(async () => (await read()).val === "100%", { timeout: 5000, timeoutMsg: "复位没回到 100%" });
    }
    await closeSettings();
  });

  it("Q6:设置「通用」最上面有「空间…」,点了收掉设置、开空间菜单;同步面板里的「空间…」也在", async () => {
    await goNotebook("inbox");
    await openSettings();
    await showCat("general");
    expect(await browser.execute(() => document.querySelector(".settings-pane[data-cat='general'] h2").textContent)).toBe("空间");
    await browser.execute(() => document.querySelector(".settings-spaces").click());
    await $(".settings-overlay").waitForExist({ timeout: 5000, reverse: true });
    await $(".space-menu").waitForExist({ timeout: 5000 });
    // A22:「加入空间」展开 —— 说明照实指路(主空间、没开同步时才有「用配对码加入」)、钮走 .hbtn、菜单不撑宽。
    await browser.execute(() =>
      [...document.querySelectorAll(".space-menu .space-row.action")].find((r) => r.textContent.startsWith("加入空间")).click(),
    );
    await $(".space-menu .space-form").waitForExist({ timeout: 5000 });
    const f = await browser.execute(() => {
      const menu = document.querySelector(".space-menu");
      return {
        w: menu.getBoundingClientRect().width,
        hint: menu.querySelector(".space-hint").textContent,
        btns: [...menu.querySelectorAll(".space-form-acts button")].map((b) => `${b.className}:${b.textContent}`),
      };
    });
    expect(f.w).toBeLessThanOrEqual(320);
    expect(f.hint).toContain("用配对码加入"); // e2e 形:主空间、没开同步 ⇒ 那枚钮真在
    expect(f.btns).toEqual(["hbtn:加入", "hbtn:取消"]);
    await browser.execute(() => [...document.querySelectorAll(".space-form-acts button")].find((b) => b.textContent === "取消").click());
    await $(".space-menu").waitForExist({ timeout: 5000, reverse: true });
    // 同步面板(没开同步的首页)也有「空间…」。
    await browser.execute(() => document.getElementById("sync-entry").click());
    await $(".sync-panel").waitForExist({ timeout: 5000 });
    const syncBtns = await browser.execute(() => [...document.querySelectorAll(".sync-panel button")].map((b) => b.textContent.trim()));
    expect(syncBtns).toContain("空间…");
    await browser.execute(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await $(".sync-overlay").waitForExist({ timeout: 5000, reverse: true });
  });

  it("WD-25:「修改服务器」那一屏写明它只换地址、不是从官方换到自建用的", async () => {
    await goNotebook("inbox");
    await browser.execute(() => document.getElementById("sync-entry").click());
    await $(".sync-panel").waitForExist({ timeout: 5000 });
    // 喂一份「已配置」状态(同 sync-ui.e2e.js):高级 → 修改服务器只在已配置态有。
    await browser.execute(() =>
      window.__TAURI__.event.emit("sync-status", {
        space: "main",
        status: {
          configured: true, state: "online", account_id: "01JQACCOUNT0000000000000000", device_id: "01JQ8F0000AAAAAAAAAAAAAAAA",
          server_url: "wss://sync.example.invalid", peers_online: 0, error: null, frozen: [], suspended: 0, skew: false, clock_skew: false, roster: null,
        },
      }),
    );
    const click = (l) => browser.execute((x) => [...document.querySelectorAll(".sync-panel button")].find((b) => b.textContent.trim() === x)?.click(), l);
    await browser.waitUntil(async () => (await browser.execute(() => [...document.querySelectorAll(".sync-panel button")].some((b) => b.textContent.trim() === "高级…"))), {
      timeout: 5000,
      timeoutMsg: "喂进去的已配置状态没把面板翻到状态页",
    });
    // Q6:已配置态首页也有「空间…」(不随空间个数藏)。
    expect(await browser.execute(() => [...document.querySelectorAll(".sync-panel button")].map((b) => b.textContent.trim()))).toContain("空间…");
    await click("高级…");
    await browser.waitUntil(async () => (await browser.execute(() => [...document.querySelectorAll(".sync-panel button")].some((b) => b.textContent.trim() === "修改服务器"))), { timeout: 5000 });
    await click("修改服务器");
    await $(".sync-panel .sync-warn").waitForExist({ timeout: 5000 });
    const warn = await browser.execute(() => document.querySelector(".sync-panel .sync-warn").textContent);
    expect(warn).toContain("只换地址、账户原样不动");
    expect(warn).toContain("不是在这里改");
    await browser.execute(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await $(".sync-overlay").waitForExist({ timeout: 5000, reverse: true });
    // 把喂进去的假状态退回真值(别把「已配置」留给后面的 spec)。
    const real = await invoke("sync_status");
    await browser.execute((s) => window.__TAURI__.event.emit("sync-status", { space: "main", status: s }), real);
  });

  it("A25:随记页记下第一条,记一笔框不往下跳(筛选那一行先占着位置、只是看不见)", async () => {
    await clearInbox();
    await goNotebook("inbox");
    await $(".v-inbox .compose-input").waitForExist({ timeout: 5000 });
    const read = () =>
      browser.execute(() => {
        const row = document.getElementById("filter-row");
        return {
          y: Math.round(document.querySelector(".v-inbox .compose-input").getBoundingClientRect().top),
          hidden: row.hidden,
          vis: getComputedStyle(row).visibility,
        };
      });
    const before = await read();
    expect(before.hidden).toBe(false);
    expect(before.vis).toBe("hidden"); // 占位态:看不见、点不到
    await inboxCompose("D2-A25-第一条");
    await browser.waitUntil(async () => (await read()).vis === "visible", { timeout: 5000, timeoutMsg: "第一条进来后筛选那一行该显出来" });
    expect((await read()).y).toBe(before.y);
    // WD-38:页头统计换白话。
    expect(await browser.execute(() => document.getElementById("idea-stats").textContent)).toMatch(/^本周记了 \d+ 条/);
    await clearInbox();
  });

  it("A25 / A29:看板后冒出来的几枚排在「新建任务」左边;新建那一行的收起钮叫「收起」", async () => {
    await goNotebook("board");
    const order = await browser.execute(() =>
      [...document.querySelector(".v-board .head-tools").children].map((n) => n.id || n.className),
    );
    const at = (id) => order.indexOf(id);
    expect(at("add-task")).toBeGreaterThan(at("due-soon"));
    expect(at("add-task")).toBeGreaterThan(at("copy-slot"));
    expect(at("add-task")).toBeGreaterThan(at("board-sort"));
    expect(at("add-task")).toBeLessThan(at("manage-cols"));
    expect(await browser.execute(() => document.getElementById("compose-close").textContent)).toBe("收起");
  });

  it("Q9 / X-10 / WD-38 / WD-23:说明与链接", async () => {
    await goNotebook("inbox");
    await openSettings();
    await showCat("general");
    const subs = await browser.execute(() =>
      Object.fromEntries(
        [...document.querySelectorAll(".settings-pane[data-cat='general'] h2")].map((h) => [h.textContent, h.nextElementSibling.textContent]),
      ),
    );
    expect(subs["截止提醒"].startsWith("应用没开着时不会响。")).toBe(true);
    expect(subs["截止提醒"]).toContain("看板页头显示到期数的那枚按钮");
    for (const k of ["外观", "语言", "界面字号"]) expect(subs[k]).toContain("只影响这台电脑,不会同步");
    expect(await browser.execute(() => document.querySelector(".settings-pane[data-cat='hotkeys'] .hkset-name").textContent)).toBe("随手记小窗");
    await showCat("about");
    const guide = await browser.execute(() =>
      [...document.querySelectorAll(".about-links a")].find((a) => a.textContent === "用户指南").getAttribute("href"),
    );
    expect(guide).toBe("https://zhujian.app/docs/");
    await closeSettings();
  });

  it("WD-33:关于页「意见反馈」点了跳到通用页那一节、焦点落在邮箱上;邮箱是 mailto 链接", async () => {
    await goNotebook("inbox");
    await openSettings();
    await showCat("about");
    await browser.execute(() => document.querySelector(".about-feedback").click());
    const r = await browser.execute(() => {
      const mail = document.querySelector(".feedback-mail");
      const m = mail.getBoundingClientRect();
      const c = document.querySelector(".settings-content").getBoundingClientRect();
      return {
        on: document.querySelector(".settings-cat.on").dataset.cat,
        focused: document.activeElement === mail,
        inView: m.top >= c.top && m.bottom <= c.bottom,
        href: mail.getAttribute("href"),
      };
    });
    // ⛔ 不真点邮箱:会在跑 e2e 的那台上拉起写信程序(或系统「用什么打开」那一问)。
    expect(r).toEqual({ on: "general", focused: true, inView: true, href: "mailto:3069848@qq.com" });
    await closeSettings();
  });

  it("WD-36:重开设置回到上次那一类;改完语言重载后设置开回「语言」那一行", async () => {
    await goNotebook("inbox");
    await openSettings();
    await showCat("about");
    await closeSettings();
    await openSettings();
    expect(await browser.execute(() => document.querySelector(".settings-cat.on").dataset.cat)).toBe("about");
    await showCat("general");
    try {
      // 改成 English:整窗重载,回来设置还开着、停在「语言」那一行、焦点在选中的那档。
      await browser.execute(() =>
        [...document.querySelectorAll(".lang-row .seg-btn")].find((b) => b.textContent === "English").click(),
      );
      await browser.waitUntil(async () => (await browser.execute(() => document.documentElement.lang)) === "en", {
        timeout: 10000,
        timeoutMsg: "改成 English 之后页面没重载成英文",
      });
      await $(".settings-overlay").waitForExist({ timeout: 10000 });
      const back = await browser.execute(() => ({
        cat: document.querySelector(".settings-cat.on").dataset.cat,
        inLangRow: !!document.activeElement?.closest(".lang-row"),
        focus: document.activeElement?.textContent,
      }));
      expect(back).toEqual({ cat: "general", inLangRow: true, focus: "English" });
    } finally {
      // 退回「自动」:同用户那样点 Auto(e2e 的进程 locale 是中文 ⇒ 又重载一次)。⚠ 走产品那条路(存 + 广播
      // `lang-changed`),捕获窗也跟着回中文;⛔ 别只删本窗的 localStorage 再 reload —— 捕获窗会留在英文。
      await browser.execute(() => {
        localStorage.removeItem("zhujian.lang");
        return window.__TAURI__.event.emit("lang-changed", "auto");
      });
      await browser.waitUntil(async () => (await browser.execute(() => document.documentElement.lang)) === "zh", {
        timeout: 10000,
        timeoutMsg: "退回自动之后没回到中文",
      });
      // 那一下重载不是从设置里改的 ⇒ 不该自己弹出设置(sessionStorage 那一笔只在设置里改档时记)。
      await browser.pause(500);
      expect(await browser.execute(() => !!document.querySelector(".settings-overlay"))).toBe(false);
    }
  });
});

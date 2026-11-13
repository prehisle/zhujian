import { $, expect, browser } from "@wdio/globals";
import { clearInbox, goNotebook, invoke, openSyncServerField } from "./support.js";

// W4 走查修复(backlog 用户面 161)桌面 D1 组「桌面壳与键盘」—— e2e 证得了的那几格(处理器面):
//   A3   设置 / 同步浮层接管键盘:打开焦点进浮层、Tab 圈在里面、背后的单键按不到、关掉焦点回到打开它的钮
//   A24  同步浮层有 ✕
//   A9   错误条「网络自检」:同步浮层收掉、设置开在「关于」、自检那节在视口里、焦点在「开始」上
//   Q5   自检最上面一句人话结论(连不上那句);复制钮旁写明带设备编号和路径
//   A23  导出说明写全「随记、看板与长文」并事先说会打开文件夹
//   A6 / Q8 ①  快捷键被占时:设置页那枚标「没生效」、随记页顶那条提示、空态不提那枚键 —— 三处与壳回的
//        `*_taken` 一致(本机日常那只开着就是撞键形,CI 上是不撞形;两形都判得了)
//   WD-34 快捷键页列了搜索页的键;搜索结果上按 Esc 回搜索框
//   A5   第一次点 ✕ 先问一句(取消 = 窗留着);之后的 ✕ 直接藏
// 窗口 / 托盘 / 全局热键本身(A1 主窗露不露、A2 只重注册一枚、启动光标进记一笔框)e2e 证不了,走真实例
// (skill zhujian-desktop-verify,读数在 .zjshots/W4-fix/D1/)与 src-tauri 的 rebind_one 单测。

const activeIn = (sel) => browser.execute((s) => !!document.querySelector(s)?.contains(document.activeElement), sel);
const activeId = () => browser.execute(() => document.activeElement?.id ?? "");

describe("W4 161 · D1 桌面壳与键盘", () => {
  it("A3:设置浮层 —— 焦点进面板、Tab 圈在里面、背后的单键按不到、Esc 关掉焦点回「设置」", async () => {
    await goNotebook("inbox");
    await $("#settings-entry").click(); // 真点:焦点先落在侧栏那枚钮上(= 打开它的那枚)
    await $(".settings-panel").waitForExist({ timeout: 5000 });
    const s = await browser.execute(() => {
      const p = document.querySelector(".settings-panel");
      return { role: p.getAttribute("role"), modal: p.getAttribute("aria-modal"), on: document.activeElement?.classList.contains("on") };
    });
    expect(s).toEqual({ role: "dialog", modal: "true", on: true }); // 焦点落在当前那一类的左栏钮上
    expect(await activeIn(".settings-panel")).toBe(true);
    for (let i = 0; i < 30; i++) {
      await browser.keys(["Tab"]);
      expect(await activeIn(".settings-panel")).toBe(true);
    }
    for (let i = 0; i < 5; i++) {
      await browser.keys(["Shift", "Tab"]);
      expect(await activeIn(".settings-panel")).toBe(true);
    }
    // 背后随记页的 N(跳到记一笔框)按不到:焦点仍在面板里、面板还开着。
    await browser.execute(() => document.querySelector(".settings-cat").focus());
    await browser.keys(["n"]);
    expect(await activeIn(".settings-panel")).toBe(true);
    await browser.keys(["Escape"]);
    await $(".settings-overlay").waitForExist({ timeout: 5000, reverse: true });
    expect(await activeId()).toBe("settings-entry");
  });

  it("A3:设置浮层点 ✕ / 点外面关掉,焦点都回「设置」", async () => {
    await goNotebook("inbox");
    for (const how of ["close", "overlay"]) {
      await $("#settings-entry").click();
      await $(".settings-panel").waitForExist({ timeout: 5000 });
      if (how === "close") await $(".settings-close").click();
      else
        await browser.execute(() =>
          document.querySelector(".settings-overlay").dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
        );
      await $(".settings-overlay").waitForExist({ timeout: 5000, reverse: true });
      expect(await activeId()).toBe("settings-entry");
    }
  });

  it("A3 / A24:同步浮层 —— 有 ✕、焦点进面板、Tab 圈在里面,✕ 关掉焦点回「同步」", async () => {
    await goNotebook("inbox");
    await $("#sync-entry").click();
    await $(".sync-panel").waitForExist({ timeout: 5000 });
    expect(await browser.execute(() => document.querySelector(".sync-panel").getAttribute("aria-modal"))).toBe("true");
    expect(await $(".sync-panel .sync-close").isDisplayed()).toBe(true);
    expect(await activeIn(".sync-panel")).toBe(true);
    for (let i = 0; i < 12; i++) {
      await browser.keys(["Tab"]);
      expect(await activeIn(".sync-panel")).toBe(true);
    }
    // 换页(创建账户):焦点落在这一页第一个控件(此前掉到 body)。902 F6 起地址框默认收着,第一个控件是那枚「更改…」。
    await browser.execute(() => {
      for (const b of document.querySelectorAll(".sync-panel button")) if (b.textContent.includes("创建账户")) return b.click();
      throw new Error("面板里没有「创建账户」");
    });
    await browser.waitUntil(() => browser.execute(() => document.activeElement?.classList.contains("sync-server-change")), {
      timeout: 3000,
      timeoutMsg: "进「创建账户」页后焦点该在这一页第一个控件(「更改…」)上",
    });
    // 点开:焦点进地址框
    await browser.keys("Enter");
    await browser.waitUntil(() => browser.execute(() => document.activeElement?.classList.contains("sync-input")), {
      timeout: 3000,
      timeoutMsg: "「更改…」上回车后焦点该在服务器地址框里",
    });
    await $(".sync-panel .sync-close").click();
    await $(".sync-overlay").waitForExist({ timeout: 5000, reverse: true });
    expect(await activeId()).toBe("sync-entry");
  });

  it("A9 / Q5:连不上 → 「网络自检」:同步浮层收掉、自检那节在视口里、焦点在「开始」;跑完最上面一句人话", async () => {
    await goNotebook("inbox");
    await $("#sync-entry").click();
    await $(".sync-panel").waitForExist({ timeout: 5000 });
    await browser.execute(() => {
      for (const b of document.querySelectorAll(".sync-panel button")) if (b.textContent.includes("创建账户")) return b.click();
      throw new Error("面板里没有「创建账户」");
    });
    await openSyncServerField();
    await browser.execute(() => {
      const input = document.querySelector(".sync-panel .sync-input");
      input.value = "ws://127.0.0.1:1"; // 本机 1 号口没人听 ⇒ 当场被拒,落「连不上」那一类
      for (const b of document.querySelectorAll(".sync-panel .sync-actions button")) if (b.textContent.includes("创建")) return b.click();
      throw new Error("创建账户页没有提交钮");
    });
    await $(".sync-panel .err-next").waitForExist({ timeout: 15000, timeoutMsg: "创号失败那行该挂「网络自检」钮" });
    await $(".sync-panel .err-next").click();
    await $(".settings-pane[data-cat='about'] .about-probe-run").waitForExist({ timeout: 5000 });
    expect(await $(".sync-overlay").isExisting()).toBe(false); // 一次只开一层
    const view = await browser.execute(() => {
      const c = document.querySelector(".settings-content").getBoundingClientRect();
      const b = document.querySelector(".about-probe-block").getBoundingClientRect();
      return {
        active: document.activeElement?.classList.contains("about-probe-run"),
        inView: b.top >= c.top - 1 && b.top < c.bottom,
        url: document.querySelector(".about-url").value,
      };
    });
    expect(view).toEqual({ active: true, inView: true, url: "ws://127.0.0.1:1" });
    await browser.keys(["Enter"]); // 焦点就在「开始」上:回车即跑
    await $(".about-verdict").waitForExist({ timeout: 20000, timeoutMsg: "自检跑完该有一句人话结论" });
    const v = await browser.execute(() => {
      const n = document.querySelector(".about-verdict");
      const r = n.getBoundingClientRect();
      const c = document.querySelector(".settings-content").getBoundingClientRect();
      return {
        fail: n.classList.contains("fail"),
        text: n.textContent,
        first: n === n.parentElement.firstElementChild,
        inView: r.top >= c.top - 1 && r.bottom <= c.bottom + 1, // 跑完那一节挪进视口,结论不在下沿之外
      };
    });
    expect(v).toEqual({ fail: true, text: "连不上 ws://127.0.0.1:1:看看地址对不对、服务器开没开、网络通不通。", first: true, inView: true });
    expect(await browser.execute(() => document.querySelectorAll(".about-step").length)).toBe(6); // 术语那几行照旧在下面
    const copyDesc = await browser.execute(
      () => [...document.querySelectorAll(".settings-pane[data-cat='about'] .hkset-desc")].map((n) => n.textContent).pop(),
    );
    expect(copyDesc).toContain("含设备编号和本机文件路径(带电脑用户名),不含内容和密钥");
    await browser.keys(["Escape"]);
    await $(".settings-overlay").waitForExist({ timeout: 5000, reverse: true });
    expect(await activeId()).toBe("sync-entry"); // 打开它的那一层已收,焦点回那一层的入口
  });

  it("A23:导出说明写全「随记、看板与长文」,事先说会打开文件夹", async () => {
    await goNotebook("inbox");
    await $("#settings-entry").click();
    await $(".settings-panel").waitForExist({ timeout: 5000 });
    await browser.execute(() => document.querySelector('.settings-cat[data-cat="backup"]').click());
    const desc = await browser.execute(() => document.getElementById("export-msg").previousElementSibling.querySelector(".hkset-desc").textContent);
    expect(desc).toContain("随记、看板与长文");
    expect(desc).toContain("导完会打开那个文件夹");
    await browser.keys(["Escape"]);
    await $(".settings-overlay").waitForExist({ timeout: 5000, reverse: true });
  });

  it("A6 / Q8 ①:被占的那枚 —— 设置里标「没生效」、随记页顶挂「点此改键」、空态不提它;都与壳回的状态一致", async () => {
    const hk = await browser.execute(() => window.__TAURI__.core.invoke("get_hotkeys"));
    await goNotebook("inbox");
    // 随记页顶那条:有被占的就在(写着那几枚),没有就不在。
    const banner = await browser.execute(() => {
      const b = document.getElementById("hkb-banner");
      return { shown: !b.hidden, text: b.textContent };
    });
    const taken = [hk.capture_taken && hk.capture, hk.notebook_taken && hk.notebook].filter(Boolean);
    expect(banner.shown).toBe(taken.length > 0);
    for (const k of taken) expect(banner.text).toContain(k);
    // 设置「快捷键」页:那枚旁的「没生效:被占用」恰跟着 *_taken。
    await $("#settings-entry").click();
    await $(".settings-panel").waitForExist({ timeout: 5000 });
    await browser.execute(() => document.querySelector('.settings-cat[data-cat="hotkeys"]').click());
    const dead = await browser.execute(() =>
      Object.fromEntries([...document.querySelectorAll(".hkset-dead")].map((n) => [n.dataset.which, !n.hidden])),
    );
    expect(dead).toEqual({ capture: hk.capture_taken, notebook: hk.notebook_taken });
    // WD-34:快捷键页列着搜索页那几枚。
    const sheet = await browser.execute(() => document.querySelector(".keysheet").textContent);
    expect(sheet).toContain("搜索页");
    expect(sheet).toContain("在搜索框和结果之间上下走");
    expect(sheet).toContain("在结果上:回到搜索框");
    if (taken.length > 0) {
      // 「点此改键」直达设置「快捷键」页(先关掉上面开的那个)。
      await browser.keys(["Escape"]);
      await $(".settings-overlay").waitForExist({ timeout: 5000, reverse: true });
      await $("#hkb-banner .hkb-fix").click();
      await $(".settings-cat.on[data-cat='hotkeys']").waitForExist({ timeout: 5000 });
      await browser.keys(["Escape"]);
      await $(".settings-overlay").waitForExist({ timeout: 5000, reverse: true });
      // 焦点回到打开它的那枚(A3):这条提示自己的「点此改键」。
      expect(await browser.execute(() => document.activeElement?.classList.contains("hkb-fix"))).toBe(true);
      // × 收起后这一趟不再出(侧栏换个视图再回来也不出;⚠ 别用 goNotebook —— 它整页重载 = 重启)。
      await $("#hkb-banner .hkb-x").click();
      expect(await browser.execute(() => document.getElementById("hkb-banner").hidden)).toBe(true);
      for (const v of ["board", "inbox"]) {
        await browser.execute((x) => document.querySelector(`.sidebar nav button[data-view="${x}"]`).click(), v);
        await $(`.v-${v}`).waitForExist({ timeout: 5000 });
      }
      expect(await browser.execute(() => document.getElementById("hkb-banner").hidden)).toBe(true);
    } else {
      await browser.keys(["Escape"]);
      await $(".settings-overlay").waitForExist({ timeout: 5000, reverse: true });
    }
  });

  it("A6 / Q8 ①:空态那句只在捕获键生效时提它(写的是此刻那枚,不是写死的 Ctrl+Alt+N)", async () => {
    const hk = await browser.execute(() => window.__TAURI__.core.invoke("get_hotkeys"));
    // 清空随记 = 让空态露出来(库是全套 spec 累积的;共享件 clearInbox,别的 spec 也这么清)。
    await clearInbox();
    await goNotebook("inbox");
    const hint = await $(".empty-ideas-hint");
    await hint.waitForExist({ timeout: 8000 });
    const text = await browser.execute(() => document.querySelector(".empty-ideas-hint").textContent);
    // 第一句恒有;第二句(在别的程序里按那枚键)只在键生效时出。
    const first = "要做的事,之后转成待办放进看板。";
    expect(text).toBe(hk.capture_taken ? first : `${first}在别的程序里按 ${hk.capture} 也能随手记,不用切回来。`);
  });

  it("WD-34:搜索结果上按 Esc 回到搜索框", async () => {
    await invoke("capture_note", { content: "W161D1 搜索 Esc 回框" });
    await goNotebook("search");
    await browser.execute(() => {
      const input = document.getElementById("q");
      input.value = "W161D1";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await $(".v-search .hit").waitForExist({ timeout: 8000 });
    await browser.execute(() => document.getElementById("q").focus());
    await browser.keys(["ArrowDown"]);
    expect(await browser.execute(() => document.activeElement?.classList.contains("hit"))).toBe(true);
    await browser.keys(["Escape"]);
    expect(await activeId()).toBe("q");
    expect(await browser.execute(() => document.getElementById("q").value)).toBe("W161D1"); // 回框不清词
  });

  // 放最后:第二下 ✕ 真把窗藏起来,之后照 goShow 的手法亮回来。
  it("A5:第一次点 ✕ 先问一句 —— 取消 = 窗留着;之后的 ✕ 直接藏进托盘", async () => {
    await goNotebook("inbox");
    await browser.execute(() => localStorage.removeItem("zhujian.tray-hint-seen"));
    const visible = () => browser.execute(() => window.__TAURI__.window.getCurrentWindow().isVisible());
    await $("#win-close").click();
    await $(".th-panel").waitForExist({ timeout: 5000 });
    expect(await visible()).toBe(true);
    const p = await browser.execute(() => ({
      text: document.querySelector(".th-panel").textContent,
      focusOk: document.activeElement?.classList.contains("th-go"),
    }));
    expect(p.text).toContain("托盘");
    expect(p.text).toContain("双击");
    expect(p.focusOk).toBe(true);
    // Tab 圈在这一问里;Esc = 取消(窗留着)。
    for (let i = 0; i < 4; i++) {
      await browser.keys(["Tab"]);
      expect(await activeIn(".th-panel")).toBe(true);
    }
    await browser.keys(["Escape"]);
    await $(".th-overlay").waitForExist({ timeout: 5000, reverse: true });
    expect(await visible()).toBe(true);
    expect(await browser.execute(() => localStorage.getItem("zhujian.tray-hint-seen"))).toBe("1");
    // 看过一次之后:✕ 直接藏,不再问。
    await $("#win-close").click();
    await browser.waitUntil(async () => !(await visible()), { timeout: 5000, timeoutMsg: "看过提示之后 ✕ 该直接藏窗" });
    expect(await $(".th-overlay").isExisting()).toBe(false);
    await browser.execute(async () => {
      const w = window.__TAURI__.window.getCurrentWindow();
      await w.show();
      await w.setFocus();
    });
  });
});

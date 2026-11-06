import { $, $$, expect, browser } from "@wdio/globals";
import { clearInbox, goNotebook, invoke } from "./support.js";

// W4 走查修复(backlog 用户面 161)桌面 D3 组「同步 / 设备 / 配对 / 被移除 / 断网」—— e2e 证得了的那几格(处理器面):
//   A8   连不上:按原话分(服务器没开 = 拒绝那一句)、带「!」、原文降一档、不带「出错:」;创建钮报错不挪位(A19)
//   Q2 / Q3  创建账户表单:地址框有标签、框下一行跟着框里的值说是不是官方服务器;预填这台最近一次连上的那台
//   A27  配对码框有标签、灰字写长什么样;样子不对时不提「槽号」、不挂原文
//   Q14  断开:侧栏「同步 · 离线」、点是空心圈;浮层给「现在重连」(连接中那几拍置灰、不收);连回来说「已重新连上」
//   Q12  已不在账户里(被拒 / 自己退出):浮层明说是哪一种、不写重连中、收起「添加设备 / 设备名单」;随记页顶挂同一句;
//        侧栏写「已不再同步」;本机账 `zhujian.sync-gone` 同手机;服务器又收了这台(被拒那形)就自己收
//   A7   唯一一台管理设备:没有「退出账户」、换成一行灰字;取消后红字不留
//   A48  常驻「移除 / 退出账户」不是红的,只有「确认移除」是
//   A38  移除确认补上「账户密钥和完整副本拿不回来」与「想彻底隔离」→「意见反馈」直达设置那一节
//   A30 / Q16  没起名的设备编号只写一遍,下面一句去哪儿起名
//   A19  展开退出确认浮层上沿不动;浮层不比窗口高
//   A43 / Q16  出码页写「到 HH:MM 失效」;对方注册完写出是哪台、不叫人等「初始同步中…」;它一连上这页就收
//   A41 / A42  出码那台:对方输错 / 对方离开 / 码过期 各说各的人话,不说成「码不对」
//   A46  往下翻着时远端来一条:光标在记一笔框里也不跳回顶、人正看着的那张卡不挪
//   A47  卡上来源标注同时间那一档颜色、「·」两边留空、「改过」排在来源后面
//   A44  主空间没起过名 → 空间菜单标「(未起名)」
//   Q11  本机别名说明写「每个空间分别起」;存好后框下那行跟着换成新名
//   WD-20 恢复表单有「选文件…」(点下去会弹系统框,e2e 不点)
// e2e 库从不配置同步账户:同步那几格照 devices / sync-ui 两支的形**经真事件总线喂状态**;出码那条路要壳回一枚码,
// 拦全局 fetch 假造 `sync_pair_start` 的回包(space-walk159-s2 的手法,头注里写着为什么只能拦这一层、为什么包装里别抛)。
// 真服务器、真两台互配那几条(移除 / 被移除 / 断网再起 / 现在重连真的立刻重拨 / 远端真插入)走真实例,读数在 .zjshots/W4-fix/D3/。

const ME = "01JQ8F0000AAAAAAAAAAAAAAAA";
const B = "01JQZZ0000BBBBBBBBBBBBBBBB";
const BASE_STATUS = {
  configured: true,
  state: "online",
  account_id: "01JQACCOUNT0000000000000000",
  device_id: ME,
  server_url: "ws://127.0.0.1:1",
  peers_online: 0,
  error: null,
  frozen: [],
  suspended: 0,
  skew: false,
  clock_skew: false,
  boot_hint: null,
  roster: null,
};
const REVOKED_RAW = "服务器拒绝(账户被封禁,或本设备未注册/已吊销)";

const feed = (patch) =>
  browser.execute((s) => window.__TAURI__.event.emit("sync-status", { space: "main", status: s }), { ...BASE_STATUS, ...patch });
/** 收摊:把壳里那份真状态喂回去,清掉本支写进 localStorage 的两本账(别漏给后面的 spec)。 */
async function restore() {
  await browser.execute(() => {
    localStorage.removeItem("zhujian.sync-gone");
    localStorage.removeItem("zhujian.last-server");
    document.querySelector(".sync-overlay") &&
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  const real = await invoke("sync_status");
  await browser.execute((s) => window.__TAURI__.event.emit("sync-status", { space: "main", status: s }), real);
}
const panelText = () => browser.execute(() => document.querySelector(".sync-panel")?.textContent ?? "");
const panelButtons = () =>
  browser.execute(() => [...document.querySelectorAll(".sync-panel button")].map((b) => b.textContent.trim()));
async function openSync() {
  await browser.execute(() => document.getElementById("sync-entry").click());
  await $(".sync-panel").waitForExist({ timeout: 5000 });
}
const clickIn = (sel, text) =>
  browser.execute(
    (s, txt) => {
      const b = [...document.querySelectorAll(s)].find((n) => n.textContent.trim() === txt);
      if (!b) throw new Error(`没有「${txt}」(${s}):${[...document.querySelectorAll(s)].map((n) => n.textContent.trim()).join(" / ")}`);
      b.click();
    },
    sel,
    text,
  );

/** 拦全局 fetch,让 `sync_pair_start` 回一枚假码(其余命令照走真 IPC)。包装随页面重载消失;装完先证它活着。 */
async function fakePairStart(code) {
  await browser.execute((c) => {
    const realFetch = window.__d3RealFetch ?? window.fetch;
    window.__d3RealFetch = realFetch;
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : input.url;
      const base = ["http://ipc.localhost/", "https://ipc.localhost/", "ipc://localhost/"].find((p) => url.startsWith(p));
      if (base !== undefined && decodeURIComponent(url.slice(base.length).split("?")[0]) === "sync_pair_start") {
        return Promise.resolve(
          new Response(JSON.stringify(c), { headers: { "Tauri-Response": "ok", "Content-Type": "application/json" } }),
        );
      }
      return realFetch.call(window, input, init);
    };
  }, code);
  const got = await browser.execute(() => window.__TAURI__.core.invoke("sync_pair_start", { spaceId: "main" }));
  if (got !== code) throw new Error(`fetch 包装没生效:sync_pair_start 回的是 ${JSON.stringify(got)}`);
}
const pair = (phase, detail) =>
  browser.execute((p, d) => window.__TAURI__.event.emit("sync-pair", { space: "main", phase: p, detail: d }), phase, detail);

describe("W4 161 · D3 同步 / 设备 / 配对 / 被移除 / 断网", () => {
  afterEach(async () => {
    await restore();
  });

  it("A8 / A19 / Q2 / Q3:创建账户表单 —— 标签与框下那一行、预填最近连上的、连不上分原因带「!」、钮不挪位", async () => {
    await goNotebook("inbox");
    // Q3:这台最近一次连上的那台(本该由 online 状态写;这里直接给,测的是读那一半)。
    await browser.execute(() => localStorage.setItem("zhujian.last-server", "ws://127.0.0.1:1"));
    await openSync();
    // Q2:第一屏先说同步是可选的。
    expect(await panelText()).toContain("同步是可选的");
    await clickIn(".sync-panel button", "创建账户(第一台设备)");
    await $(".sync-panel .sync-field").waitForExist({ timeout: 5000 });
    const f = await browser.execute(() => ({
      label: document.querySelector(".sync-panel .sync-label").textContent,
      value: document.querySelector(".sync-panel .sync-input").value,
      hint: document.querySelector(".sync-panel .sync-hint").textContent,
      text: document.querySelector(".sync-panel").textContent,
    }));
    expect(f.label).toBe("服务器地址");
    expect(f.value).toBe("ws://127.0.0.1:1"); // 预填的是最近连上的那台,不是官方
    expect(f.hint).toContain("不是官方服务器");
    expect(f.text).toContain("账户就回不来");
    // 框里换成官方地址 ⇒ 那一行跟着换。
    await browser.execute(() => {
      const i = document.querySelector(".sync-panel .sync-input");
      i.value = "wss://sync.zhujian.app";
      i.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(await browser.execute(() => document.querySelector(".sync-panel .sync-hint").textContent)).toContain("官方服务器,一般不用改");
    // 换回本机 1 号口(没人听 ⇒ 当场被拒),点「创建」两次:钮的位置不随报错挪动。
    const goTop = () =>
      browser.execute(() => [...document.querySelectorAll(".sync-panel .sync-actions button")].find((b) => b.textContent === "创建").getBoundingClientRect().top);
    await browser.execute(() => {
      const i = document.querySelector(".sync-panel .sync-input");
      i.value = "ws://127.0.0.1:1";
      i.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const before = await goTop();
    await clickIn(".sync-panel .sync-actions button", "创建");
    await $(".sync-panel .sync-form-err .err-msg").waitForExist({ timeout: 15000, timeoutMsg: "创号连不上该在表单里报一句" });
    const e = await browser.execute(() => {
      const m = document.querySelector(".sync-panel .sync-form-err .err-msg");
      return {
        text: m.textContent,
        raw: m.querySelector(".err-raw")?.textContent ?? null,
        icon: getComputedStyle(m, "::before").content,
        probe: !!m.querySelector(".err-next"),
      };
    });
    expect(e.text.startsWith("连不上服务器:服务器可能没开,或者地址、端口不对。")).toBe(true); // A8:拒绝那一句,不是「或者中途断了」
    expect(e.text).not.toContain("出错:");
    expect(e.raw).toContain("原文"); // 原文降一档,单独一格
    expect(e.icon).toBe('"!"'); // 错误条带图标,不只靠红色
    expect(e.probe).toBe(true);
    expect(Math.abs((await goTop()) - before)).toBeLessThan(1); // A19:报一次错钮不挪
    await clickIn(".sync-panel .sync-actions button", "创建");
    await browser.pause(300);
    expect(Math.abs((await goTop()) - before)).toBeLessThan(1);
    expect((await invoke("sync_status")).configured).toBe(false); // 前置自证:真没建成
  });

  it("A27:用配对码加入 —— 配对码框有标签、灰字写长什么样;样子不对时不提「槽号」、不挂原文", async () => {
    await goNotebook("inbox");
    await openSync();
    await clickIn(".sync-panel button", "用配对码加入");
    await $(".sync-panel .sync-field").waitForExist({ timeout: 5000 });
    const labels = await browser.execute(() => [...document.querySelectorAll(".sync-panel .sync-label")].map((n) => n.textContent));
    expect(labels).toEqual(["服务器地址", "配对码"]);
    const inputs = await $$(".sync-panel .sync-input");
    expect(await inputs[1].getAttribute("placeholder")).toBe("形如 123456789-XXXX-XXXX");
    // ⛔ 别连官方:地址先换成本机没人听的口(码的样子在拨号之前就验,这里也不会真拨)。
    await browser.execute(() => {
      const [s, c] = document.querySelectorAll(".sync-panel .sync-input");
      s.value = "ws://127.0.0.1:1";
      c.value = "1234-5678";
    });
    await clickIn(".sync-panel .sync-actions button", "加入");
    await $(".sync-panel .sync-form-err .err-msg").waitForExist({ timeout: 10000 });
    const t = await browser.execute(() => document.querySelector(".sync-panel .sync-form-err").textContent);
    expect(t).toContain("配对码的样子不对:应是 9 位数字、4 位、4 位");
    expect(t).not.toContain("槽号");
    expect(t).not.toContain("原文");
    expect(t).not.toContain("出错:");
  });

  it("Q14:断开 —— 侧栏写「离线」、点是空心圈;「现在重连」整段断开都在(连接中置灰);连回来说「已重新连上」", async () => {
    await goNotebook("inbox");
    await openSync();
    await feed({ state: "offline", error: "连不上服务器:IO error: 由于目标计算机积极拒绝,无法连接。 (os error 10061)" });
    await browser.waitUntil(async () => (await panelButtons()).includes("现在重连"), { timeout: 5000, timeoutMsg: "离线时浮层该有「现在重连」" });
    const side = await browser.execute(() => {
      const w = document.getElementById("sync-word");
      const dot = getComputedStyle(document.getElementById("sync-dot"));
      return { hidden: w.hidden, text: w.textContent, img: dot.backgroundImage, bg: dot.backgroundColor };
    });
    expect(side.hidden).toBe(false);
    expect(side.text).toBe("离线");
    expect(side.img).toContain("radial-gradient"); // 空心圈(不是实心朱点)
    expect(side.bg).toBe("rgba(0, 0, 0, 0)");
    const btnState = () =>
      browser.execute(() => [...document.querySelectorAll(".sync-panel button")].find((b) => b.textContent === "现在重连")?.disabled ?? null);
    expect(await btnState()).toBe(false);
    // 连接中那几拍:钮还在、置灰(不跳版);侧栏仍写「离线」。
    await feed({ state: "connecting", error: null });
    await browser.waitUntil(async () => (await btnState()) === true, { timeout: 5000, timeoutMsg: "连接中那几拍「现在重连」该在、置灰" });
    expect(await browser.execute(() => document.getElementById("sync-word").textContent)).toBe("离线");
    // 点一下(离线时):壳里真命令(e2e 库没配同步 ⇒ 壳那边不是离线、回 false,不报错)。
    await feed({ state: "offline", error: null });
    await browser.waitUntil(async () => (await btnState()) === false, { timeout: 5000 });
    await clickIn(".sync-panel button", "现在重连");
    await browser.pause(300);
    expect(await browser.execute(() => document.querySelectorAll(".sync-panel .sync-reconnect .sync-err").length)).toBe(0);
    // 连回来:说一声;侧栏那个字收起;「现在重连」没了。
    await feed({ state: "online", error: null, peers_online: 1 });
    await browser.waitUntil(
      async () => (await browser.execute(() => document.getElementById("sync-toast")?.textContent ?? "")) === "已重新连上",
      { timeout: 5000, timeoutMsg: "连回来该说「已重新连上」" },
    );
    expect(await browser.execute(() => document.getElementById("sync-word").hidden)).toBe(true);
    expect(await panelButtons()).not.toContain("现在重连");
    expect(await browser.execute(() => getComputedStyle(document.getElementById("sync-dot")).backgroundImage)).toBe("none"); // 连着 = 实心
  });

  it("Q12:被拒 —— 浮层明说、不写重连中、收起添加设备与名单;随记页顶同一句;侧栏「已不再同步」;服务器又收了就收", async () => {
    await goNotebook("inbox");
    await openSync();
    await feed({ state: "offline", error: REVOKED_RAW });
    await browser.waitUntil(async () => (await panelText()).includes("这台已不在这个账户里(被移出,或账户被停用)"), {
      timeout: 5000,
      timeoutMsg: "被拒后浮层该明说",
    });
    const txt = await panelText();
    expect(txt).not.toContain("重连中");
    expect(txt).toContain("这台上的内容都还在,之后在这台记的只留在这台。");
    expect(txt).toContain("想重新加入:先把只在这台上的那几条复制出来");
    const btns = await panelButtons();
    expect(btns).not.toContain("添加设备");
    expect(btns).not.toContain("设备名单");
    expect(btns).not.toContain("现在重连");
    expect(btns).toContain("空间…");
    expect(await browser.execute(() => JSON.parse(localStorage.getItem("zhujian.sync-gone")))).toEqual({ main: { device: ME, why: "revoked" } });
    expect(await browser.execute(() => document.getElementById("sync-word").textContent)).toBe("已不再同步");
    // 随记页顶那一条:同一句;点了开同步浮层。
    await browser.execute(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    await $(".sync-overlay").waitForExist({ timeout: 5000, reverse: true });
    const banner = await browser.execute(() => {
      const b = document.querySelector(".v-inbox #gone-banner");
      return { hidden: b.hidden, text: b.textContent };
    });
    expect(banner.hidden).toBe(false);
    expect(banner.text).toContain("这台已不在这个账户里(被移出,或账户被停用)");
    expect(banner.text).toContain("之后在这台记的只留在这台");
    await browser.execute(() => document.querySelector(".v-inbox #gone-banner").click());
    await $(".sync-panel").waitForExist({ timeout: 5000 });
    // 服务器又收了这台(封禁解了):这一档自己收,页顶那条跟着收。
    await feed({ state: "online", error: null });
    await browser.waitUntil(async () => (await panelButtons()).includes("添加设备"), { timeout: 5000, timeoutMsg: "又被收了该回到平常的首页" });
    expect(await browser.execute(() => localStorage.getItem("zhujian.sync-gone"))).toBe(null);
    expect(await browser.execute(() => document.querySelector(".v-inbox #gone-banner").hidden)).toBe(true);
  });

  it("Q12:自己退出 —— 写「你已退出这个账户」;回执后会话还在线那一拍也不收(只有重置 / 换身份才收)", async () => {
    await goNotebook("inbox");
    // 「退出成功」那一下在 e2e 里走不到(没有服务器),账照 devices.ts commit 那一下的形直接记。
    await browser.execute((me) => localStorage.setItem("zhujian.sync-gone", JSON.stringify({ main: { device: me, why: "left" } })), ME);
    await openSync();
    await feed({ state: "online", error: null });
    await browser.waitUntil(async () => (await panelText()).includes("你已退出这个账户"), { timeout: 5000 });
    expect(await panelButtons()).not.toContain("添加设备");
    await feed({ state: "offline", error: REVOKED_RAW });
    await browser.pause(200);
    expect(await panelText()).toContain("你已退出这个账户"); // 不被改记成「被移出」
    // 这一本换了身份(重置后重新加入)⇒ 账作废。
    await feed({ state: "online", error: null, device_id: B });
    await browser.waitUntil(async () => (await panelButtons()).includes("添加设备"), { timeout: 5000 });
    expect(await browser.execute(() => localStorage.getItem("zhujian.sync-gone"))).toBe(null);
  });

  it("A7 / A48 / A30 / Q16:唯一管理设备没有「退出账户」;常驻钮不红;没起名的编号只写一遍、下面说去哪儿起名", async () => {
    await goNotebook("inbox");
    await openSync();
    await feed({ roster: null });
    await browser.waitUntil(async () => (await panelButtons()).includes("设备名单"), { timeout: 5000 });
    await clickIn(".sync-panel button", "设备名单");
    await feed({ roster: [{ device: ME, admin: true }, { device: B, admin: false }], peers_online: 1 });
    await browser.waitUntil(async () => (await browser.execute(() => document.querySelectorAll(".sync-panel .dev-row").length)) === 2, {
      timeout: 5000,
    });
    const rows = await browser.execute(() =>
      [...document.querySelectorAll(".sync-panel .dev-row")].map((r) => ({
        text: r.textContent,
        buttons: [...r.querySelectorAll("button")].map((b) => ({ t: b.textContent.trim(), cls: b.className })),
      })),
    );
    // A7:本机是唯一一台管理设备 ⇒ 没有「退出账户」,一行灰字说为什么、怎么办。
    expect(rows[0].buttons.map((b) => b.t)).toEqual(["01JQ8F…"]);
    expect(rows[0].text).toContain("这是账户里唯一的管理设备,不能退出;要退,先把另一台设成管理设备。");
    // A30:编号只写一遍(此前名字一遍、编号钮一遍)。
    expect(rows[0].text.split("01JQ8F").length - 1).toBe(1);
    expect(rows[1].text.split("01JQZZ").length - 1).toBe(1);
    // Q16:没起名的那行下面一句去哪儿起名(本机 / 那台说法不同)。
    expect(rows[0].text).toContain("在 设置 → 本机别名 给这台起个名就好认了");
    expect(rows[1].text).toContain("在那台的 设置 → 本机别名 起个名就好认了");
    // A48:常驻的「移除」不是红的(没有 dev-danger)。
    expect(rows[1].buttons.find((b) => b.t === "移除").cls).toBe("hbtn");
    // 两台管理设备:本机又有「退出账户」(也不红)。
    await feed({ roster: [{ device: ME, admin: true }, { device: B, admin: true }], peers_online: 1 });
    await browser.waitUntil(
      async () => (await browser.execute(() => document.querySelectorAll(".sync-panel .dev-badge--admin").length)) === 2,
      { timeout: 5000 },
    );
    const leave = await browser.execute(() =>
      [...document.querySelectorAll(".sync-panel .dev-row")[0].querySelectorAll("button")].find((b) => b.textContent === "退出账户")?.className ?? null,
    );
    expect(leave).toBe("hbtn");
  });

  it("A38 / A48 / A19 / A7:移除确认话说全、只有执行钮是红的、浮层上沿不动不出窗;失败的红字在确认块里、取消即收", async () => {
    await goNotebook("inbox");
    await openSync();
    await feed({ roster: null });
    await browser.waitUntil(async () => (await panelButtons()).includes("设备名单"), { timeout: 5000 });
    await clickIn(".sync-panel button", "设备名单");
    await feed({ roster: [{ device: ME, admin: true }, { device: B, admin: false }], peers_online: 1 });
    await browser.waitUntil(async () => (await browser.execute(() => document.querySelectorAll(".sync-panel .dev-row").length)) === 2, {
      timeout: 5000,
    });
    const top = () => browser.execute(() => document.querySelector(".sync-panel").getBoundingClientRect().top);
    const before = await top();
    await browser.execute(() => [...document.querySelectorAll(".sync-panel .dev-row")[1].querySelectorAll("button")].find((b) => b.textContent === "移除").click());
    await $(".dev-confirm").waitForExist({ timeout: 5000 });
    const box = await browser.execute(() => document.querySelector(".dev-confirm").textContent);
    expect(box).toContain("配对时交给它的账户密钥和那份完整副本也拿不回来。");
    expect(box).toContain("想彻底隔离");
    expect(box).toContain("移除不够");
    // A19:展开确认后浮层上沿不动(此前居中,长高一截上沿往上跳);浮层不比窗口高(长了自己滚)。
    expect(Math.abs((await top()) - before)).toBeLessThan(1);
    const g = await browser.execute(() => {
      const p = document.querySelector(".sync-panel").getBoundingClientRect();
      return { bottom: p.bottom, vh: window.innerHeight };
    });
    expect(g.bottom).toBeLessThanOrEqual(g.vh + 0.5);
    // A48:执行那一下是实心朱砂(有底色),「取消」不是。
    const yes = await browser.execute(() => {
      const b = [...document.querySelectorAll(".dev-confirm button")].find((n) => n.textContent === "确认移除");
      return { cls: b.className, bg: getComputedStyle(b).backgroundColor };
    });
    expect(yes.cls).toContain("dev-danger");
    expect(yes.bg).not.toBe("rgba(0, 0, 0, 0)");
    // 真发命令(e2e 没服务器 ⇒ 壳回一句拒):红字落在确认块里;点「取消」一并收。
    await clickIn(".dev-confirm button", "确认移除");
    await browser.waitUntil(
      async () => (await browser.execute(() => (document.querySelector(".dev-confirm .dev-act-err")?.textContent ?? "").length)) > 0,
      { timeout: 8000, timeoutMsg: "失败的那句该在确认块里" },
    );
    await clickIn(".dev-confirm button", "取消");
    await $(".dev-confirm").waitForExist({ timeout: 5000, reverse: true });
    expect(await browser.execute(() => document.querySelectorAll(".sync-panel .dev-act-err").length)).toBe(0);
    // A38:「意见反馈」直达设置里那一节,焦点落在邮箱上。
    await browser.execute(() => [...document.querySelectorAll(".sync-panel .dev-row")[1].querySelectorAll("button")].find((b) => b.textContent === "移除").click());
    await $(".dev-confirm").waitForExist({ timeout: 5000 });
    await clickIn(".dev-confirm button", "意见反馈");
    await $(".settings-panel").waitForExist({ timeout: 5000 });
    await browser.waitUntil(async () => await browser.execute(() => document.activeElement?.classList.contains("feedback-mail") ?? false), {
      timeout: 5000,
      timeoutMsg: "焦点该落在意见反馈的邮箱上",
    });
    expect(await browser.execute(() => !!document.querySelector(".sync-overlay"))).toBe(false); // 一次只开一层
    await browser.execute(() => document.querySelector(".settings-close").click());
    await $(".settings-overlay").waitForExist({ timeout: 5000, reverse: true });
  });

  it("A43 / Q16 / A41 / A42:出码页写几点失效;对方注册完写出是哪台、一连上就收;对方输错 / 离开 / 过期各说各的", async () => {
    await goNotebook("inbox");
    await fakePairStart("123456789-ABCD-EFGH");
    await openSync();
    await feed({ peers_online: 0 });
    await browser.waitUntil(async () => (await panelButtons()).includes("添加设备"), { timeout: 5000 });
    await clickIn(".sync-panel button", "添加设备");
    await $(".sync-panel .sync-code").waitForExist({ timeout: 5000 });
    const note = await panelText();
    expect(note).toMatch(/配对码到 \d{2}:\d{2} 失效,只能用一次/);
    expect(note).not.toContain("10 分钟内有效");
    expect(note).toContain("「用配对码加入」"); // Q15:手机上真有这枚钮
    expect(note).toContain("「加入空间(输入配对码)」");
    // 对方来到配对槽 → 注册 → done。
    await pair("joined", "对方已连上,正在校验配对码");
    await pair("registering", `设备 ${B} 已注册`);
    await pair("done", "新设备已加入账户");
    await browser.waitUntil(async () => (await panelText()).includes("已加入账户"), { timeout: 5000 });
    const done = await panelText();
    expect(done).toContain("「01JQZZ」已加入账户"); // 写出是哪台(没起名 = 名单那一档的编号)
    expect(done).toContain("「初始同步完成」或「已加入空间…」");
    expect(done).not.toContain("不再是「初始同步中…」");
    // 它用自己的身份连上来(另有在线设备 +1)⇒ 这一页收起回首页,说一声。
    await feed({ peers_online: 1 });
    await browser.waitUntil(async () => !(await browser.execute(() => !!document.querySelector(".sync-panel .sync-code, .sync-panel .sync-note"))) || (await panelButtons()).includes("添加设备"), {
      timeout: 5000,
    });
    await browser.waitUntil(async () => (await panelButtons()).includes("添加设备"), { timeout: 5000, timeoutMsg: "对面连上来该回首页" });
    expect(await browser.execute(() => document.getElementById("sync-toast").textContent)).toContain("「01JQZZ」已连上");
    // 出码那台的三种失败:各一句人话,下一步都是「重新出码」,不挂内部原话。
    for (const [raw, want] of [
      ["配对码校验不过(对端输入的配对码不对?)", "对方输的配对码不对,这串码已作废。"],
      ["对方离开(配对码不对,或对方取消)", "对方没加入就离开了"],
      ["配对超时(配对码 10 分钟内有效)", "这串配对码已过期"],
    ]) {
      await clickIn(".sync-panel button", "添加设备");
      await $(".sync-panel .sync-code").waitForExist({ timeout: 5000 });
      await pair("failed", raw);
      await browser.waitUntil(async () => (await panelButtons()).includes("重新出码"), { timeout: 5000 });
      const t = await browser.execute(() => document.querySelector(".sync-panel .sync-err").textContent);
      expect(t).toContain(want);
      expect(t).toContain("点「重新出码」,让对方输新码");
      expect(t).not.toContain("原文");
      expect(t).not.toContain("出错:");
      if (raw.startsWith("对方离开")) expect(t).not.toMatch(/^配对码不对/);
      await clickIn(".sync-panel button", "关闭");
      await $(".sync-overlay").waitForExist({ timeout: 5000, reverse: true });
      await openSync();
    }
  });

  it("A46:往下翻着时远端来一条 —— 光标在记一笔框里也不跳回顶,人正看着的那张卡不挪", async () => {
    await clearInbox();
    for (let i = 0; i < 18; i++) await invoke("capture_note", { content: `D3A46-旧-${String(i).padStart(2, "0")}\n第二行\n第三行` });
    await goNotebook("inbox");
    await browser.waitUntil(async () => (await browser.execute(() => document.querySelectorAll(".v-inbox .note").length)) === 18, {
      timeout: 10000,
    });
    for (const withFocus of [true, false]) {
      await browser.execute((focus) => {
        const list = document.getElementById("list");
        if (focus) document.querySelector(".compose-input").focus();
        else document.activeElement?.blur?.();
        list.scrollTop = 420;
      }, withFocus);
      // ⚠ 记一笔框拿到 / 丢掉焦点时自己有一段过渡(框的高度跟着变),等它落定再量 —— 否则量到的是过渡中途那一帧,
      // 与产品在远端那一发里看到的版面差几像素(全量里红过一次:-20.3 → -23.3,就是这一段)。
      await browser.pause(600);
      // 看着的那张 = 产品里 `scrollAnchor` 认的同一张(列表里第一张下沿还在上沿之下的卡)。
      const probe = await browser.execute(() => {
        const list = document.getElementById("list");
        const lt = list.getBoundingClientRect().top;
        const n = [...list.querySelectorAll(".note[data-id]")].find((x) => x.getBoundingClientRect().bottom > lt);
        return { id: n.dataset.id, top: n.getBoundingClientRect().top - lt, scroll: list.scrollTop };
      });
      expect(probe.scroll).toBeGreaterThan(300); // 前置:真翻下去了
      await invoke("capture_note", { content: `D3A46-远端-${withFocus}` });
      await browser.execute(() => window.__TAURI__.event.emit("sync-changed", { space: "main" }));
      await browser.waitUntil(
        async () => await browser.execute((c) => [...document.querySelectorAll(".v-inbox .note")].some((n) => n.textContent.includes(c)), `D3A46-远端-${withFocus}`),
        { timeout: 10000, timeoutMsg: "远端那条该被画出来" },
      );
      const after = await browser.execute((id) => {
        const list = document.getElementById("list");
        const n = list.querySelector(`.note[data-id="${id}"]`);
        return {
          top: n.getBoundingClientRect().top - list.getBoundingClientRect().top,
          scroll: list.scrollTop,
          focusInCompose: document.activeElement?.classList.contains("compose-input") ?? false,
        };
      }, probe.id);
      expect(after.scroll).toBeGreaterThan(300); // 没跳回顶
      // 人正看着的那张不挪。⚠ 150% 缩放下 scrollTop 落在设备像素上(1/1.5 px 一格),留一点余量;没补偿时这一格挪的是一整张卡(≈88px)。
      if (Math.abs(after.top - probe.top) >= 2) throw new Error(`看着的那张挪了:${JSON.stringify({ withFocus, probe, after })}`);
      expect(after.focusInCompose).toBe(withFocus); // 光标还在框里(那一形)
    }
    await clearInbox();
  });

  it("A47:卡上来源标注同时间那一档颜色、「·」两边留空、「改过」跟在来源后面隔一枚「·」", async () => {
    await clearInbox();
    await invoke("capture_note", { content: "D3A47-一条" });
    await goNotebook("inbox");
    await $(".v-inbox .note .note-time").waitForExist({ timeout: 10000 });
    // 署名要另一台起过名的设备记的才显 —— 单机 e2e 造不出;往真卡的时间那行里挂上同一套类名,量的是样式那一半。
    const s = await browser.execute(() => {
      const time = document.querySelector(".v-inbox .note .note-time");
      const sig = document.createElement("span");
      sig.className = "sig-chip";
      sig.textContent = "zjm";
      const ed = document.createElement("span");
      ed.className = "edited-mark";
      ed.textContent = "改过";
      time.append(sig, ed);
      const cs = getComputedStyle(sig);
      const r = {
        sigColor: cs.color,
        timeColor: getComputedStyle(time).color,
        sigMarginLeft: cs.marginLeft,
        dotRight: getComputedStyle(sig, "::before").marginRight,
        edBefore: getComputedStyle(ed, "::before").content,
      };
      sig.remove();
      ed.remove();
      return r;
    });
    expect(s.sigColor).toBe(s.timeColor); // 同时间那一档(此前 --ink-faint,压卡底 2.31:1)
    expect(s.sigMarginLeft).toBe("6px"); // 「·」不贴着时间
    expect(s.dotRight).toBe("4px");
    expect(s.edBefore).toBe('"·"');
    await clearInbox();
  });

  it("A44 / Q11 / A14 / WD-20:空间菜单标「(未起名)」;别名说明写每个空间分别起、存好后那行跟着换;恢复表单有「选文件…」", async () => {
    await goNotebook("inbox");
    await browser.execute(() => document.querySelector(".settings-entry, #settings-entry").click());
    await $(".settings-panel").waitForExist({ timeout: 5000 });
    await browser.execute(() => document.querySelector(".settings-cat[data-cat='general']").click());
    const gen = await browser.execute(() => document.querySelector(".settings-pane[data-cat='general']").textContent);
    expect(gen).toContain("每个空间分别起");
    // 起个名 ⇒ 框下那行换成「本机 · 名字 · 编号」;清掉 ⇒ 回到只写编号。
    await $(".alias-input:not([disabled])").waitForExist({ timeout: 5000 });
    const sub = () => browser.execute(() => document.querySelector(".alias-input").closest(".hkset-row").querySelector(".hkset-desc").textContent);
    const setAlias = (v) =>
      browser.execute((val) => {
        const i = document.querySelector(".alias-input");
        i.value = val;
        i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      }, v);
    expect(await sub()).toMatch(/^本机 · [0-9A-Z]{6,}$/);
    await setAlias("D3台");
    await browser.waitUntil(async () => (await sub()).startsWith("本机 · D3台 · "), { timeout: 5000, timeoutMsg: "存好别名后那行该跟着换" });
    await setAlias("");
    await browser.waitUntil(async () => /^本机 · [0-9A-Z]{6,}$/.test(await sub()), { timeout: 5000 });
    // WD-20:恢复表单有「选文件…」(点了会弹系统的文件框,e2e 不点)。
    await browser.execute(() => document.querySelector(".settings-cat[data-cat='backup']").click());
    await browser.waitUntil(
      async () => await browser.execute(() => [...document.querySelectorAll(".settings-pane[data-cat='backup'] button")].some((b) => b.textContent === "恢复…")),
      { timeout: 10000 },
    );
    await browser.execute(() => [...document.querySelectorAll(".settings-pane[data-cat='backup'] button")].find((b) => b.textContent === "恢复…").click());
    await browser.waitUntil(
      async () => await browser.execute(() => [...document.querySelectorAll(".bkup-restore button")].some((b) => b.textContent === "选文件…")),
      { timeout: 5000, timeoutMsg: "恢复表单该有「选文件…」" },
    );
    await browser.execute(() => document.querySelector(".settings-close").click());
    await $(".settings-overlay").waitForExist({ timeout: 5000, reverse: true });
    // A44:主空间从没起过名 ⇒ 空间菜单那一行标「(未起名)」。
    await openSync();
    await clickIn(".sync-panel button", "空间…");
    await $(".space-menu").waitForExist({ timeout: 5000 });
    const mark = await browser.execute(() => {
      const row = [...document.querySelectorAll(".space-menu .space-row")].find((r) => r.querySelector(".space-row-name"));
      return { name: row.querySelector(".space-row-name").textContent, mark: row.querySelector(".space-row-mark")?.textContent ?? null };
    });
    expect(mark).toEqual({ name: "默认空间", mark: "(未起名)" });
    await browser.execute(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  });
});

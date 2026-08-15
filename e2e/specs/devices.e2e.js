import { $, $$, expect, browser } from "@wdio/globals";
import { goNotebook } from "./support.js";

// 设备管理面(identity-plan §5.8/§5.9;367「移除设备」第①笔·片⑤)。
//
// e2e 库从不配置同步账户,故这一页的名册**经真事件总线喂进去** —— `sync-status` 正是
// 它在生产里唯一的输入通道(「名单只许有状态面一个数据出口」,§5.7-6 那条 ⛔),不是
// 给测试开的后门:生产代码里没有一行 test-only 接缝。
//
// 覆盖 §5.16.3 点名的七格:名单渲染 / 最短唯一前缀 / 完整 ID 展开 / 管理徽章 /
// 操作显隐 / 两拍确认 / `roster = null`。

// ⚠ 三个 id 是**照判据挑的**,不是随手编的(memory `test-parameters-are-part-of-the-predicate`):
//  · ME 与 B 共前 10 位 ⇒ 最短唯一前缀必须涨到 11,「下限 6 位」那条路走不通;
//  · C 第 5 位就分岔 ⇒ 它恰好停在下限 6 位上。
// 两条一起才证得了「唯一前缀是算出来的」——只有 C 的话,一个恒返回 slice(0,6) 的坏实现照样绿。
const ME = "01JQ8F0000AAAAAAAAAAAAAAAA";
const B = "01JQ8F0000BBBBBBBBBBBBBBBB";
const C = "01JQZZ0000CCCCCCCCCCCCCCCC";
const SID_ME = "01JQ8F0000A"; // 11 位
const SID_B = "01JQ8F0000B";
const SID_C = "01JQZZ"; // 6 位

function status(roster) {
  return {
    configured: true,
    state: "online",
    account_id: "01JQACCOUNT0000000000000000",
    device_id: ME,
    server_url: "wss://sync.example.invalid",
    peers_online: roster ? Math.max(0, roster.length - 1) : 0,
    error: null,
    frozen: [],
    suspended: 0,
    skew: false,
    clock_skew: false,
    roster,
  };
}

/** 经事件总线推一份状态,并等面板真的把它画出来(等 DOM,不等固定毫秒)。
 *  ⚠ 判据要同时钉**行数与管理徽章数** —— 只钉行数的话,「行数不变、只改 admin 标记」
 *  那一喂会当场满足条件、什么也没等到,后面的断言就是在读**上一份**的画面(假绿)。 */
async function feed(roster) {
  const rows = roster.length;
  const admins = roster.filter((e) => e.admin).length;
  await browser.execute(
    (s) => window.__TAURI__.event.emit("sync-status", { space: "main", status: s }),
    status(roster),
  );
  await browser.waitUntil(
    async () =>
      await browser.execute(
        (r, a) =>
          document.querySelectorAll(".sync-panel .dev-row").length === r &&
          document.querySelectorAll(".sync-panel .dev-badge--admin").length === a,
        rows,
        admins,
      ),
    { timeout: 5000, timeoutMsg: `设备行应有 ${rows} 行、其中 ${admins} 台带「管理」徽章` },
  );
}

/** 打开同步面板并进设备页。 */
async function openDevices() {
  await goNotebook("inbox");
  await browser.execute(() => document.getElementById("sync-entry").click());
  await $(".sync-panel").waitForExist({ timeout: 3000 });
  // 未配置态没有这枚入口(它在 configured 分支里),先喂一份状态把面板推到已配置态。
  await browser.execute(
    (s) => window.__TAURI__.event.emit("sync-status", { space: "main", status: s }),
    status(null),
  );
  await browser.waitUntil(
    async () =>
      await browser.execute(() =>
        [...document.querySelectorAll(".sync-panel button")].some((b) =>
          b.textContent.includes("设备名单"),
        ),
      ),
    { timeout: 5000, timeoutMsg: "已配置态的同步首页应有「设备名单」入口" },
  );
  await browser.execute(() => {
    for (const b of document.querySelectorAll(".sync-panel button")) {
      if (b.textContent.includes("设备名单")) return b.click();
    }
    throw new Error("没有「设备名单」入口");
  });
}

/** 第 i 行(0 起)上标签为 label 的按钮;找不到即抛。行序恒定:本机置顶,其余按 id 升序。 */
function clickRowBtn(i, label) {
  return browser.execute(
    (idx, txt) => {
      const row = document.querySelectorAll(".sync-panel .dev-row")[idx];
      if (!row) throw new Error(`没有第 ${idx} 行`);
      for (const b of row.querySelectorAll("button")) {
        if (b.textContent.trim() === txt) return b.click();
      }
      throw new Error(`第 ${idx} 行没有「${txt}」按钮,只有:${[...row.querySelectorAll("button")].map((b) => b.textContent.trim()).join(" / ")}`);
    },
    i,
    label,
  );
}

const rowTexts = () =>
  browser.execute(() =>
    [...document.querySelectorAll(".sync-panel .dev-row")].map((r) => r.textContent),
  );

const rowButtons = (i) =>
  browser.execute(
    (idx) =>
      [...document.querySelectorAll(".sync-panel .dev-row")[idx].querySelectorAll("button")].map(
        (b) => b.textContent.trim(),
      ),
    i,
  );

describe("367 片⑤ 设备管理面", () => {
  it("roster = null:不列名单、不给操作面,话术是「尚未确认服务器支持」", async () => {
    await openDevices();
    // ⛔ 拿不到名册就什么都不显 —— 绝不折成空数组拿一份可能过期的名单充数(§5.16.2-7)。
    expect((await $$(".sync-panel .dev-row")).length).toBe(0);
    const text = await (await $(".sync-panel")).getText();
    expect(text).toContain("尚未确认服务器支持");
    // M4:不许断言「服务器版本较旧」——新服务器的 attach 推送同样可能丢。
    expect(text).not.toContain("版本较旧");
  });

  it("名单渲染 + 最短唯一前缀 + 本机/管理徽章", async () => {
    await openDevices();
    await feed([{ device: ME, admin: true }, { device: B, admin: false }, { device: C, admin: true }]);
    const rows = await rowTexts();
    // 徽章要按**徽章**查,不能拿整行文本查 —— 行里还有「设为管理」这枚按钮,
    // 用 `not.toContain("管理")` 判「没有管理徽章」会被按钮文案顶掉(第一版就栽在这)。
    const badges = await browser.execute(() =>
      [...document.querySelectorAll(".sync-panel .dev-row")].map((r) =>
        [...r.querySelectorAll(".dev-badge")].map((b) => b.textContent.trim()),
      ),
    );
    // 本机置顶,其余按 device_id 升序。
    expect(badges[0]).toEqual(["本机", "管理"]);
    expect(badges[1]).toEqual([]);
    expect(badges[2]).toEqual(["管理"]);
    // 最短唯一前缀:撞前缀的两台涨到 11 位,不撞的那台停在下限 6 位。
    expect(rows[0]).toContain(SID_ME);
    expect(rows[1]).toContain(SID_B);
    expect(rows[2]).toContain(`${SID_C}…`);
    // 收起态**不该**显完整 26 位(那是点开才给的)。
    expect(rows[2]).not.toContain(C);
  });

  it("完整 ID 可展开、可收起(别名是能被别的设备改写的,唯一定位只能靠它)", async () => {
    await openDevices();
    await feed([{ device: ME, admin: true }, { device: C, admin: false }]);
    await clickRowBtn(1, `${SID_C}…`);
    await browser.waitUntil(async () => (await rowTexts())[1].includes(C), {
      timeout: 3000,
      timeoutMsg: "点短 id 应展开完整 26 位",
    });
    expect(await rowButtons(1)).toContain("复制 ID");
    await clickRowBtn(1, C);
    await browser.waitUntil(async () => !(await rowTexts())[1].includes(C), {
      timeout: 3000,
      timeoutMsg: "再点一次应收起",
    });
  });

  it("操作显隐:管理设备看得到别人行上的移除与设为/取消管理", async () => {
    await openDevices();
    await feed([{ device: ME, admin: true }, { device: B, admin: false }, { device: C, admin: true }]);
    expect(await rowButtons(0)).toEqual([`${SID_ME}…`, "退出账户"]);
    expect(await rowButtons(1)).toEqual([`${SID_B}…`, "设为管理", "移除"]);
    // 已经是管理设备的那台给的是「取消管理」,不是「设为管理」。
    expect(await rowButtons(2)).toEqual([`${SID_C}…`, "取消管理", "移除"]);
  });

  it("操作显隐:非管理设备在别人行上一个按钮都没有(不显示灰的)", async () => {
    await openDevices();
    await feed([{ device: ME, admin: false }, { device: B, admin: true }]);
    // 自己行仍有「退出账户」——任何设备都能移除自己(§5.3 第三句)。
    expect(await rowButtons(0)).toEqual([`${SID_ME}…`, "退出账户"]);
    expect(await rowButtons(1)).toEqual([`${SID_B}…`]);
  });

  it("admins 为空(存量未回填):整条用户面 fail-closed,连自助退出也没有", async () => {
    await openDevices();
    await feed([{ device: ME, admin: false }, { device: B, admin: false }]);
    const text = await (await $(".sync-panel")).getText();
    expect(text).toContain("本空间还没有设置管理设备");
    // ⛔ 不变量只说「不得**变**空」,对已经是空的账户约束为零 —— 放行自助退出就能把账户
    // 逐台退到封存。这一格是首版自检第 6 条挡下来的,别让它悄悄长回来。
    expect(await rowButtons(0)).toEqual([`${SID_ME}…`]);
    expect(await rowButtons(1)).toEqual([`${SID_B}…`]);
  });

  it("只有一台管理设备且设备 ≥2 台:给那句温和提醒", async () => {
    await openDevices();
    await feed([{ device: ME, admin: true }, { device: B, admin: false }]);
    expect(await (await $(".sync-panel")).getText()).toContain("建议再设一台管理设备");
    // 两台都是管理设备时不提醒。
    await feed([{ device: ME, admin: true }, { device: B, admin: true }]);
    expect(await (await $(".sync-panel")).getText()).not.toContain("建议再设一台管理设备");
  });

  it("两拍确认:第一拍出话术(§5.9 四句全在)+ 完整 ID;取消收回", async () => {
    await openDevices();
    await feed([{ device: ME, admin: true }, { device: B, admin: false }]);
    await clickRowBtn(1, "移除");
    await $(".dev-confirm").waitForExist({ timeout: 3000 });
    const box = await (await $(".dev-confirm")).getText();
    // §5.9:不可撤销 + 三层边界,**一句都不能省**。
    expect(box).toContain("无法再经服务器同步");
    expect(box).toContain("不会被删除");
    // ⚠ 367 第②笔(名册闸)起这一句**翻面**了:从「可能仍在同步」改成「会断开」,
    // 且判据是「还在册的每台设备各自取没取到名单」(§5.9;文案与代码同轮出)。
    expect(box).toContain("断开与它的局域网直连");
    expect(box).toContain("重新加入需要清空它那边的数据");
    // 破坏性确认面必须给出能唯一定位那台设备的东西(§5.8 ⛔)。
    expect(box).toContain(B);
    await browser.execute(() => {
      for (const b of document.querySelectorAll(".dev-confirm button")) {
        if (b.textContent.trim() === "取消") return b.click();
      }
      throw new Error("确认块里没有「取消」");
    });
    await browser.waitUntil(async () => !(await $(".dev-confirm").isExisting()), {
      timeout: 3000,
      timeoutMsg: "「取消」应收回确认块",
    });
  });

  it("设为管理的确认面把授出去的权力说明白", async () => {
    await openDevices();
    await feed([{ device: ME, admin: true }, { device: B, admin: false }]);
    await clickRowBtn(1, "设为管理");
    await $(".dev-confirm").waitForExist({ timeout: 3000 });
    expect(await (await $(".dev-confirm")).getText()).toContain(
      "该设备将可以移除其他设备,并修改管理设备名单",
    );
  });

  it("第二拍真发命令:失败如实报出来,名单一行不动(绝不乐观移除)", async () => {
    await openDevices();
    await feed([{ device: ME, admin: true }, { device: B, admin: false }]);
    await clickRowBtn(1, "移除");
    await $(".dev-confirm").waitForExist({ timeout: 3000 });
    await browser.execute(() => {
      for (const b of document.querySelectorAll(".dev-confirm button")) {
        if (b.textContent.trim() === "确认移除") return b.click();
      }
      throw new Error("确认块里没有「确认移除」");
    });
    // ⚠ 这里**拒它的是哪道闸**要说准(首版自检第 13 条):e2e 库没有服务器,transport
    // 停在离线臂上,回的是那句「在忙什么」——**不是** core 的能力闸(那道闸在会话里,
    // 有它自己的 core 单测)。这一格钉的是 UI 那一半:后端的原话原样落进面板,而名单
    // **一行都不许先动**(乐观移除会让一次失败的命令看起来成功了)。
    // 判据用 .dev-act-err 而不是 .sync-err:后者被「拉名册失败」那条恒亮的错误占着,
    // 拿它当判据等于让另一条错误替这一条记账(假绿)。
    await browser.waitUntil(
      async () =>
        await browser.execute(
          () => (document.querySelector(".sync-panel .dev-act-err")?.textContent ?? "").length > 0,
        ),
      { timeout: 8000, timeoutMsg: "命令失败应在面板里如实报错" },
    );
    expect((await $$(".sync-panel .dev-row")).length).toBe(2);
  });
});

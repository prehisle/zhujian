import { browser, $, expect } from "@wdio/globals";
import { invoke, goNotebook } from "./support.js";

// 截止提醒(用户面 39 第一版,src/reminder.ts)的判定与水位。
//
// ⭐ **真通知在系统面,这套断言够不着它** —— 本 spec 断的是产品自己的观察缝:
// 判定完成时广播的 `zhujian:due-remind-done`(detail.body:string|null)与
// localStorage 的「今天已处理」水位;`sendNotification` 那一跳(真弹不弹得出来)
// 只有设置面「试一条」+ 人眼能答,⛔ 别把这里的绿读成「通知显示出来了」。
//
// ⭐ **全部用注入的 `detail.now` 判「到没到点」,不依赖墙钟** —— wdio.conf.js 的
// before 钩子给每支 spec 预置了「今天已处理」,本 spec 自己改写那个键;
// 「正好在午夜跨日」仍是已知窄缝(localToday 在判定内取真实日),与全套 e2e 同界。
//
// ⚠ **正例都用「循环补发」形**(waitUntil 里重复 dispatch):判定有不重入闸
// (`checking`),上一次的通知发送还没收尾时新事件会被吞 —— 重复补发直到日志长出来,
// 幂等由水位保证(记过账的后续 dispatch 全是同步跳过,不会多记)。

const LAST = "zhujian.due-remind.last";
const CFG = "zhujian.due-remind";

function ymd(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const armLog = () =>
  browser.execute(() => {
    window.__remindLog = [];
    document.addEventListener("zhujian:due-remind-done", (e) => window.__remindLog.push(e.detail));
  });
const remindLog = () => browser.execute(() => window.__remindLog);
const fireOnce = (now) =>
  browser.execute((n) => {
    document.dispatchEvent(new CustomEvent("zhujian:due-remind-check", { detail: { now: n } }));
  }, now);
/** 正例:补发直到日志到 n 条(见文件头「循环补发」)。 */
async function fireUntil(now, n, why) {
  await browser.waitUntil(
    async () => {
      await fireOnce(now);
      return (await remindLog()).length >= n;
    },
    { timeout: 8000, timeoutMsg: `补发 8s 日志仍不到 ${n} 条:${why}` },
  );
}
const lastMark = () => browser.execute((k) => localStorage.getItem(k), LAST);
const clearMark = () => browser.execute((k) => localStorage.removeItem(k), LAST);
const cfgRaw = () => browser.execute((k) => localStorage.getItem(k), CFG);

async function openGeneralSettings() {
  await browser.execute(() => document.getElementById("settings-entry").click());
  await $(".settings-panel").waitForExist({ timeout: 5000 });
  await $(".remind-ctrls").waitForExist({ timeout: 5000 });
}
async function closeSettings() {
  await browser.execute(() => {
    document.querySelector(".settings-overlay").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
  await browser.waitUntil(async () => !(await $(".settings-overlay").isExisting()), {
    timeout: 5000,
    timeoutMsg: "设置面板没关上",
  });
}
/** 面板里点开/关/试一条(按可见文字认按钮会随语言变,按结构认:seg 里第 1/2 枚)。 */
const clickSeg = (idx) =>
  browser.execute((i) => document.querySelectorAll(".remind-ctrls .seg-btn")[i].click(), idx);

/** 按库现算「逾期 M · 今天 N」的期望句(与 zh 字典同形;基线 + 增量:别的 spec 可能
 *  留了带截止的卡,绝对数是错判据)。完成的任务不算(与前端 dueAttentionState 同口径,
 *  见 G)——做完的不该继续占每天提醒的「逾期/今天」计数。 */
async function expectedBody() {
  const tasks = (await invoke("list_tasks")).filter((t) => t.status !== "done");
  const today = ymd(0);
  const late = tasks.filter((t) => t.due_on && t.due_on < today).length;
  const now = tasks.filter((t) => t.due_on === today).length;
  return late > 0 ? `逾期 ${late} · 今天 ${now}` : `今天到期 ${now}`;
}

describe("截止提醒 · 判定与水位(39)", () => {
  const T_TODAY = "提醒甲-今天到期";
  const T_LATE = "提醒乙-昨天就该交";
  const T_X1 = "提醒丙-分辨器一";
  const T_X2 = "提醒丁-分辨器二";

  before(async () => {
    await goNotebook("board");
    await armLog();
  });

  it("设置面「通用」有这一节:开关落 localStorage,报点改成 07:30", async () => {
    await openGeneralSettings();
    // 关 → 开:两个方向都真落库;关的时候报点输入禁用。
    await clickSeg(1);
    expect(JSON.parse(await cfgRaw()).on).toBe(false);
    expect(await browser.execute(() => document.querySelector(".remind-time").disabled)).toBe(true);
    await clickSeg(0);
    expect(JSON.parse(await cfgRaw()).on).toBe(true);
    await browser.execute(() => {
      const inp = document.querySelector(".remind-time");
      inp.value = "07:30";
      inp.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const cfg = JSON.parse(await cfgRaw());
    expect(cfg).toEqual({ on: true, time: "07:30" });
    await closeSettings();
  });

  it("到点即报:正文是「逾期 M · 今天 N」那把尺,水位记为今天", async () => {
    const t1 = await invoke("create_task", { title: T_TODAY });
    const t2 = await invoke("create_task", { title: T_LATE });
    await invoke("set_task_due", { id: t1, dueOn: ymd(0) });
    await invoke("set_task_due", { id: t2, dueOn: ymd(-1) });
    const want = await expectedBody();

    await clearMark();
    await fireUntil("07:30", 1, "到点(=报点)该报没报");
    const log = await remindLog();
    expect(log).toHaveLength(1);
    // 单空间(YS_DB_PATH 禁建空间)⇒ 不带空间名前缀;有逾期 ⇒ 「逾期 M · 今天 N」分支
    // (T_LATE 保证 late ≥ 1)。
    expect(want).toMatch(/^逾期 /);
    expect(log[0].body).toBe(want);
    expect(await lastMark()).toBe(ymd(0));
  });

  it("同一天不再报;清掉水位才会再报(至多一天一条)", async () => {
    await fireOnce("23:59"); // 水位还在:同步跳过,日志不该动
    await clearMark();
    await fireUntil("07:30", 2, "清水位后该报没报");
    // 中间那次要是没被跳过,这里就是 3 不是 2。
    expect(await remindLog()).toHaveLength(2);
  });

  it("关着不响;再开就响", async () => {
    await openGeneralSettings();
    await clickSeg(1); // 关
    await closeSettings();
    await clearMark();
    await fireOnce("23:59"); // 关着:该同步跳过
    // ⭐ 分辨器:负例与正例之间再加一张逾期卡 ⇒ 正例的正文必是**新**数。只数条数是不够的
    // ——「关着那次误报了」会把水位写上,让正例被去重顶掉,总数还是 3(刀B在这儿栽过盲区);
    // 正文一比就露馅:误报的是旧数。
    const t3 = await invoke("create_task", { title: T_X1 });
    await invoke("set_task_due", { id: t3, dueOn: ymd(-2) });
    const want = await expectedBody();
    await openGeneralSettings();
    await clickSeg(0); // 开
    await closeSettings();
    await fireUntil("23:59", 3, "重新打开后该报没报");
    const log = await remindLog();
    expect(log).toHaveLength(3); // 关着那次要是报了并被数出来,这里是 4
    expect(log[2].body).toBe(want);
  });

  it("没到报点不响(07:29 < 07:30);到点才响", async () => {
    await clearMark();
    await fireOnce("07:29"); // 没到点:该同步跳过
    const t4 = await invoke("create_task", { title: T_X2 }); // 同上一格的分辨器
    await invoke("set_task_due", { id: t4, dueOn: ymd(-3) });
    const want = await expectedBody();
    await fireUntil("07:30", 4, "到点那次该报没报");
    const log = await remindLog();
    expect(log).toHaveLength(4); // 07:29 那次要是报了并被数出来,这里是 5
    expect(log[3].body).toBe(want);
  });

  it("到点无事:不说话但记账(body=null,水位照记)", async () => {
    // 把库里**所有**带截止的卡临时清掉(含别的 spec 留下的),finally 逐条还回去。
    const dued = (await invoke("list_tasks")).filter((t) => t.due_on !== null);
    try {
      for (const t of dued) await invoke("set_task_due", { id: t.id, dueOn: null });
      await clearMark();
      await fireUntil("07:30", 5, "无事那次该出 done 事件(body=null)没出");
      const log = await remindLog();
      expect(log[4].body).toBe(null);
      expect(await lastMark()).toBe(ymd(0));
    } finally {
      for (const t of dued) await invoke("set_task_due", { id: t.id, dueOn: t.due_on });
    }
  });

  after(async () => {
    // 收尾:两张种子卡回收(硬删走 delete_note 会被 live 守护拒,软删即可让别的 spec 不受扰),
    // 并把配置还回默认形(别把 07:30 留给后面的 spec —— profile 每支新开,这里只是求稳)。
    const tasks = await invoke("list_tasks");
    for (const title of [T_TODAY, T_LATE, T_X1, T_X2]) {
      const t = tasks.find((x) => x.title === title);
      if (t) await invoke("archive_task", { id: t.id });
    }
    await browser.execute((k) => localStorage.removeItem(k), CFG);
  });
});

// 截止提醒(用户面 39 第一版,2026-08-31 用户拍板「桌面先行」):应用开着时,每天到点
// 用一条系统通知报「逾期 M · 今天 N」。范围钉死,别顺手扩:
// - `due_on` 仍是纯日历日(0014 CHECK)—— 报点是**本机**统一的一个时刻(默认 09:00,可改),
//   不是每条任务各自的时刻;要按任务定时刻得动数据模型 + 同步词汇 = 数据层红线,不在本版。
// - 开关与报点纯设备本地(localStorage,同明暗/字号那条规矩,不进同步)——E2EE 下服务器
//   读不到内容、做不了推送去重,每台设备自己决定响不响。
// - 应用没开(进程不在)就不响。notebook 窗 ✕ 掉只是 hide(lib.rs CloseRequested),
//   本模块住 notebook 的 webview,托盘挂着照样到点报;capture 窗刻意不挂(单一发声源)。
// - 计数口径与看板顶栏那枚汇总钮(502)同一把尺:整块看板(全部列)、dueState ∈
//   {overdue, today};多空间逐空间数(桌面所有 alive 空间都装配着),多空间时正文按空间分行。
// - **至多一天一条**:取到数先记账(zhujian.due-remind.last = 本地日)再发,发失败宁可缺
//   一条也不隔 30 秒再叨一遍;到点无事(计数全零)也记账、今天不说话。
//
// e2e 缝(与 wdio.conf.js before 钩子配套):自动首查延后 10 秒 + 每支 spec 预置
// 「今天已处理」水位 ⇒ 别的 spec 里它安静;本功能的 spec 用 DOM 事件 zhujian:due-remind-check
// 强制立即判定(detail.now 可注入「现在几点」,免依赖墙钟),判定完成广播
// zhujian:due-remind-done(detail.body:string|null,null = 到点无事)。真通知在系统面,
// e2e 断言的是这条缝 + 水位;通知管道本身由「试一条」按钮人工验。
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { invokeInSpace, listSpaces, spaceLabel } from "./space";
import { dueAttentionState, dueSummaryLabel, localToday, type TaskItem } from "./tasktime";
import { t } from "./i18n";

const CFG_KEY = "zhujian.due-remind"; // {on:boolean, time:"HH:MM"}
const LAST_KEY = "zhujian.due-remind.last"; // 最后处理过的本地日 "YYYY-MM-DD"
const CHECK_MS = 30_000; // 轮询判定间隔(睡眠唤醒后下一拍自然补上,不必算精确闹钟)
const FIRST_CHECK_MS = 10_000; // 首查延后:避开启动装载,也给 e2e before 钩子留出预置水位的窗

export type ReminderCfg = { on: boolean; time: string };

/** 读本机配置;没配过 / 坏值 = 默认「开 · 09:00」。默认开是拍板项:提醒功能默认不响,
 *  就永远不会提醒任何人 —— 而它只在真有到期/逾期时才说话,空日子零打扰。 */
export function reminderCfg(): ReminderCfg {
  try {
    const raw = JSON.parse(localStorage.getItem(CFG_KEY) ?? "") as { on?: unknown; time?: unknown };
    if (typeof raw.on === "boolean" && typeof raw.time === "string" && /^\d{2}:\d{2}$/.test(raw.time)) {
      return { on: raw.on, time: raw.time };
    }
  } catch {
    // 首跑(键不存在)或历史坏值:落默认,下次保存即归正。
  }
  return { on: true, time: "09:00" };
}

export function saveReminderCfg(cfg: ReminderCfg): void {
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
}

/** 通知权限(桌面通常默认已授):没授就当场问一次;拒了返回 false,由调用方给人话。 */
export async function reminderPermissionOk(): Promise<boolean> {
  if (await isPermissionGranted()) return true;
  return (await requestPermission()) === "granted";
}

function nowHHMM(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 通知正文;null = 没有任何到期/逾期。逐空间数(与 502 同尺:list_tasks = 看板活卡全集,
 *  不筛列),多空间时按空间分行 —— 只报「默认空间 逾期 2」而不说是哪个空间,点开看不到
 *  东西的那个人会以为提醒在说谎。完成的任务不算(dueAttentionState)——做完的东西不该
 *  在每天的通知里继续被当成「要处理」,哪怕当初设过如今已经过去的截止日。 */
async function digestBody(): Promise<string | null> {
  const today = localToday();
  const spaces = (await listSpaces()).filter((s) => s.alive);
  const lines: string[] = [];
  for (const s of spaces) {
    const tasks = await invokeInSpace<TaskItem[]>(s.id, "list_tasks");
    let late = 0;
    let now = 0;
    for (const it of tasks) {
      const st = dueAttentionState(it, today);
      if (st === "overdue") late++;
      else if (st === "today") now++;
    }
    if (late + now === 0) continue;
    const sum = dueSummaryLabel(late, now);
    lines.push(spaces.length > 1 ? t("reminder.spaceLine", { name: spaceLabel(s), sum }) : sum);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

async function notify(body: string): Promise<void> {
  if (!(await reminderPermissionOk())) throw new Error(t("reminder.permDenied"));
  sendNotification({ title: t("reminder.notifTitle"), body });
}

/** 设置面「试一条」:当场把今天的数发出去(没有就发「目前没有…」)——用户唯一能确认
 *  「通知在这台机器上真的显得出来」的路(勿扰/专注模式吞通知是安静的)。不碰水位。 */
export async function sendTestNotification(): Promise<void> {
  const body = (await digestBody()) ?? t("reminder.testEmpty");
  await notify(body);
}

let checking = false; // 判定不重入:注入的 check 事件可能与定时拍重叠,水位读写要串行

async function check(nowOverride?: string): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    const cfg = reminderCfg();
    if (!cfg.on) return;
    const today = localToday();
    if (localStorage.getItem(LAST_KEY) === today) return;
    if ((nowOverride ?? nowHHMM()) < cfg.time) return;
    let body: string | null;
    try {
      body = await digestBody();
    } catch (e) {
      // 取数失败(启动竞态等):不记账,30 秒后下一拍重试;响亮留痕,不静默。
      console.error("截止提醒取数失败(下一拍重试):", e);
      return;
    }
    // 取到数先记账再发:至多一天一条。发失败宁可缺一条,不许隔 30 秒再叨一遍。
    localStorage.setItem(LAST_KEY, today);
    document.dispatchEvent(new CustomEvent("zhujian:due-remind-done", { detail: { body } }));
    if (body === null) return; // 到点无事:今天不说话(之后补设截止的,明天到点才报)
    try {
      await notify(body);
    } catch (e) {
      console.error("截止提醒发送失败:", e);
    }
  } finally {
    checking = false;
  }
}

/** notebook 启动装配点(app 级单例,不随视图 mount/unmount)。 */
export function initDueReminder(): void {
  document.addEventListener("zhujian:due-remind-check", (e) => {
    void check((e as CustomEvent<{ now?: string } | undefined>).detail?.now);
  });
  setTimeout(() => {
    void check();
    setInterval(() => void check(), CHECK_MS);
  }, FIRST_CHECK_MS);
}

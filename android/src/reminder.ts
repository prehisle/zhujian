// 截止提醒的**手机那半**(用户面 39①;桌面那半 553 已发,源在 `src/reminder.ts`)。
//
// 范围是用户 2026-09-01 当面拍死的:**「开着才响」** —— app 开着(前台 WebView 活着)时,
// 每天到点用一条系统通知报「逾期 M · 今天 N」。⛔ 不做后台闹钟(`AlarmManager` /
// `WorkManager` / 前台服务)、⛔ 不碰各家 ROM 的省电白名单。那一档贵一个量级,而这一档
// 对「每天开着朱简记事」的真实用法已经够用。
//
// 与桌面那半刻意不同的两处(⛔ 都不是偷工,是这一端的事实):
//  ① **只数当前空间**。手机一次只装配一个空间(`mobile/src/coord.rs` 的 `with_read`:
//     `space_id` 与 foreground 不符 = 响亮拒)⇒ 别的空间的库在这一端**读不到**,
//     而为了数一眼就去后台激活别的空间,是拿一条通知换一次真实的空间切换。
//     ⇒ 多空间时通知正文带上空间名(同桌面那句「只报数不报哪个空间会让人以为提醒在说谎」),
//     设置面那句说明也明写「只数当前空间」。
//  ② **权限**:安卓 13+ 的 `POST_NOTIFICATIONS` 是运行期权限,桌面没有这一格。
//     判据与那道对话框什么时候弹,写在 `platform.ts` 的 `notifyPermissionOk` 头上。
//
// 与桌面**逐条相同**的那几件(⛔ 改一端就要想清另一端,两份没有门禁核):
//  · 开关与报点纯设备本地(localStorage,同明暗/字号那条规矩,不进同步);默认「开 · 09:00」
//    —— 默认不响的提醒永远不会提醒任何人,而它只在真有到期/逾期时才说话,空日子零打扰;
//  · **至多一天一条**:取到数先记账(水位 = 本地日)再发,发失败宁可缺一条也不隔 30 秒再叨;
//  · 计数口径与任务面那枚汇总钮(558)同一把尺 —— 完成的任务恒不算(`dueAttentionState`);
//  · ⛔ **一个字都不多说**:通知只报「逾期 / 今天」,559 那段「3 天内 K」**刻意不进通知**
//    (用户 2026-09-01 拍板:通知的克制感来自「只在真出事时才说话」)。喂它的是
//    `dueSummaryLabel`,不是 `dueSummaryFullLabel`。
//
// 验收缝(与桌面同名同形,CDP 资产 `scripts/cdp-acceptance-due-reminder.js` 驱动它):
// DOM 事件 `zhujian:due-remind-check`(detail.now 可注入「现在几点」,免依赖墙钟)强制
// 立即判定,判定完成广播 `zhujian:due-remind-done`(detail.body:string|null,
// null = 到点无事)。真通知在系统面,资产断的是这条缝 + 水位;通知管道本身靠「试一条」人工验。
import { getCurrentSpace, listSpaces, listTasks, spaceLabel, type TaskItem } from "./api";
import { t } from "./i18n";
import { notifyPermissionOk, showNotification } from "./platform";

const CFG_KEY = "zhujian.due-remind"; // {on:boolean, time:"HH:MM"}(与桌面同键名,库不共享故不冲突)
const LAST_KEY = "zhujian.due-remind.last"; // 最后处理过的本地日 "YYYY-MM-DD"
const CHECK_MS = 30_000; // 轮询判定间隔(息屏/切后台回来后下一拍自然补上,不必算精确闹钟)
const FIRST_CHECK_MS = 10_000; // 首查延后:避开启动闸与首屏装载

export type ReminderCfg = { on: boolean; time: string };

/** 读本机配置;没配过 / 坏值 = 默认「开 · 09:00」(理由见文件头)。 */
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

function nowHHMM(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function localToday(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 「今天该报什么」这句话由调用方注入 —— **计数的尺与说的那句话都在 `main.ts`**
 * (`dueAttentionState` + `dueSummaryLabel`,任务面那枚汇总钮 558 用的就是它们)。
 * 返回 null = 没有任何到期/逾期。
 *
 * ⛔ **刻意不在这里再抄一份**:抄了就是第二把尺,而「两把尺不相等」这件事没有任何门禁
 * 看得见(558 那条诚实边界的同族)。
 * ⛔ 也刻意不从 `main.ts` import —— 那是循环依赖(main → reminder → main),
 * 而模块求值期的循环是**安静地拿到 undefined**,不是报错。
 */
export type DueDigest = (tasks: TaskItem[], today: string) => string | null;

let digest: DueDigest | null = null;

/** 通知正文;null = 没有任何到期/逾期。多空间时带上空间名(理由见文件头 ①)。 */
async function digestBody(): Promise<string | null> {
  if (digest === null) throw new Error("截止提醒未装配(initDueReminder 没跑?)");
  const space = getCurrentSpace();
  const tasks = await listTasks(space);
  const sum = digest(tasks, localToday());
  if (sum === null) return null;
  // 单空间(绝大多数)照旧只说那一句;多空间才点名 —— 否则那句话在另一个空间里看不到东西。
  const spaces = await listSpaces();
  if (spaces.length <= 1) return sum;
  const me = spaces.find((s) => s.id === space);
  return me ? t("reminder.spaceLine", { name: spaceLabel(me), sum }) : sum;
}

async function notify(body: string): Promise<void> {
  if (!(await notifyPermissionOk())) throw new Error(t("reminder.permDenied"));
  showNotification(t("reminder.notifTitle"), body);
}

/** 设置面「试一条」:当场把今天的数发出去(没有就发「目前没有…」)——用户唯一能确认
 *  「通知在这台手机上真的显得出来」的路(勿扰 / 通知被系统关掉都是安静的)。不碰水位。 */
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
      // 取数失败(启动竞态 / 正在切换空间那道响亮拒):不记账,30 秒后下一拍重试。
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

/** 启动装配点(app 级单例,不随视图切换重来)。`d` = 与汇总钮同源的那把尺,见 `DueDigest`。 */
export function initDueReminder(d: DueDigest): void {
  digest = d;
  document.addEventListener("zhujian:due-remind-check", (e) => {
    void check((e as CustomEvent<{ now?: string } | undefined>).detail?.now);
  });
  setTimeout(() => {
    void check();
    setInterval(() => void check(), CHECK_MS);
  }, FIRST_CHECK_MS);
}

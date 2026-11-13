// 选日期的层(904,用户 2026-11-13 拍):选截止日期那一下此前是 `<input type="date">` 弹的系统日历对话框 ——
// 强调色是系统蓝、与应用的朱砂不搭,而那张对话框是 WebView(Chromium)自己画的,**不吃应用主题**
// (原生主题色改过一遍、真机上照旧是蓝的)⇒ 换成应用自己的月历,住屏底那座层里(与捕获 / 编辑层同一身几何)。
//
// 语义与系统那张逐条一致(⛔ 别顺手改):
// - 点某一天只是**选中**,点「确定」才交给宿主写;「清除」= 清掉截止;「取消」/ 点遮罩 / 返回键 = 什么都不写。
// - 周日起排;过去的日子照样能选(原来的日期框没设下限);交出去的值是 `YYYY-MM-DD`(与 `<input type=date>` 同形)。
// - 月历恒画六行:行数跟着月份变的话,层贴着屏底、顶上那排「上月 / 下月」会上下挪,连点换月就点空。
// - 星期与年月标题由 `Intl.DateTimeFormat` 按界面语言出,不进字典。
//
// 分工同编辑层(⛔ 别揉到一起):本层只管 DOM、开合与返回键守门条目;写库、session 判弃、busy 闸全在宿主(cardpanel)。
// 关层两条路:UI(确定 / 清除 / 取消 / 点遮罩 / 宿主收场)→ `closeDatePick()`(收 DOM + settleHistory);
// 返回键 → main.ts 的 popstate 已弹掉条目 ⇒ `closeDatePickNow()`(只收 DOM)。两者都幂等。
import { currentLang, t } from "./i18n";
import { createKbSheet, type KbSheet } from "./kbsheet";
import { $, esc } from "./ui";

export type DatePickHost = {
  /** 点了「确定」:`day` = 选中的那天(`YYYY-MM-DD`)。层已收。 */
  onPick(day: string): void;
  /** 点了「清除」。层已收。 */
  onClear(): void;
};

type Deps = {
  /** 开层压一枚返回键守门条目(main.ts 的层账本)。 */
  pushLayer: () => void;
  /** UI 主动收层后平掉那枚条目;popstate 关的层⛔不许调。 */
  settleHistory: () => void;
};

let deps: Deps;
let kb: KbSheet | null = null;
let host: DatePickHost | null = null;
/** 正看着的那个月(month 0 起)。 */
let view = { y: 0, m: 0 };
/** 选中的那天;null = 还没选(这条没设截止、刚开层)。 */
let sel: string | null = null;

/** 顶上至少留这么一条背景(手机横放时可见区比月历矮 ⇒ 层按它夹高、层里滚;40 = 让过状态栏那一条,真机上 24 会和系统图标叠上)。 */
const RESERVE_TOP = 40;

const pad = (n: number): string => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number): string => `${y}-${pad(m + 1)}-${pad(d)}`;

function todayIso(): string {
  const n = new Date();
  return iso(n.getFullYear(), n.getMonth(), n.getDate());
}

export function isDatePickOpen(): boolean {
  return host !== null;
}

/** 收层的 DOM 部分:popstate(返回键)与 UI 关层共用;history 账目由调用方处置。幂等。 */
export function closeDatePickNow(): void {
  if (!host) return;
  host = null;
  kb?.close();
  $("dp-days").innerHTML = "";
}

/** UI 主动收层:顺带平掉守门条目。层没开就是 no-op(返回键那条路已先收掉)。 */
export function closeDatePick(): void {
  if (!host) return;
  closeDatePickNow();
  deps.settleHistory();
}

function paint(): void {
  const lang = currentLang();
  $("dp-title").textContent = new Intl.DateTimeFormat(lang, { year: "numeric", month: "long" }).format(new Date(view.y, view.m, 1));
  const lead = new Date(view.y, view.m, 1).getDay(); // 周日起
  const days = new Date(view.y, view.m + 1, 0).getDate();
  const today = todayIso();
  const full = new Intl.DateTimeFormat(lang, { dateStyle: "full" });
  let html = "";
  for (let i = 0; i < 42; i++) {
    const d = i - lead + 1;
    if (d < 1 || d > days) {
      html += "<span></span>";
      continue;
    }
    const day = iso(view.y, view.m, d);
    const cls = `dp-day${day === today ? " today" : ""}${day === sel ? " on" : ""}`;
    html += `<button type="button" class="${cls}" data-day="${day}" aria-pressed="${day === sel}" aria-label="${esc(
      full.format(new Date(view.y, view.m, d)),
    )}"><span>${d}</span></button>`;
  }
  $("dp-days").innerHTML = html;
  ($("dp-ok") as HTMLButtonElement).disabled = sel === null;
}

function shift(by: number): void {
  const d = new Date(view.y, view.m + by, 1);
  view = { y: d.getFullYear(), m: d.getMonth() };
  paint();
}

/** 开层。`current` = 这条现在的截止(`YYYY-MM-DD`)或 null:有就落在那个月、那天选中;没有就落在本月、什么都不选。 */
export function openDatePick(current: string | null, h: DatePickHost): void {
  const first = host === null;
  host = h;
  sel = current;
  const [y, m] = (current ?? todayIso()).split("-").map(Number);
  view = { y, m: m - 1 };
  $("dp-clear").hidden = current === null; // 没设过就没什么可清
  paint();
  if (!first) return;
  // 键盘开着(过滤框握着焦点)时先收键盘:这一层里没有要打字的东西,键盘起着月历只剩半截。
  const a = document.activeElement;
  if (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement) a.blur();
  kb?.open();
  deps.pushLayer(); // 返回键第一本能 = 关掉这层
}

export function initDatePick(d: Deps): void {
  deps = d;
  const sheet = $("date-sheet");
  kb = createKbSheet({
    sheet,
    scrim: $("date-scrim"),
    input: sheet, // 层里没有输入框;kbsheet 收层时 blur 它是空操作
    reserveTop: RESERVE_TOP,
    onDismiss: closeDatePick, // 点遮罩 = 取消
  });
  // 星期那一行不随月份变:画一次。2023-01-01 是周日。
  const wd = new Intl.DateTimeFormat(currentLang(), { weekday: "narrow" });
  $("dp-week").innerHTML = Array.from({ length: 7 }, (_, i) => `<span>${esc(wd.format(new Date(2023, 0, 1 + i)))}</span>`).join("");
  $("dp-prev").setAttribute("aria-label", t("cardpanel.duePrevMonth"));
  $("dp-next").setAttribute("aria-label", t("cardpanel.dueNextMonth"));
  $("dp-prev").addEventListener("click", () => shift(-1));
  $("dp-next").addEventListener("click", () => shift(1));
  $("dp-days").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-day]");
    if (!b || !host) return;
    sel = b.dataset.day!;
    paint();
  });
  $("dp-cancel").addEventListener("click", closeDatePick);
  $("dp-clear").addEventListener("click", () => {
    const h = host;
    if (!h) return;
    closeDatePick();
    h.onClear();
  });
  $("dp-ok").addEventListener("click", () => {
    const h = host;
    if (!h || sel === null) return;
    const day = sel;
    closeDatePick();
    h.onPick(day);
  });
}

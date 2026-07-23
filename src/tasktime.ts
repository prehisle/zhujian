import { invoke } from "./space";
import { armDismiss } from "./hotkey-menu";
import "./tasktime.css";

// Shared task time-dimension helpers + a reusable due/priority editor, used by
// both the board and the Today view (one source of truth). `due_on` is a
// user-local calendar day `YYYY-MM-DD` (or null); `priority` is null = 未设, or
// 1/2/3 = 低/中/高. "今天/逾期" is decided here, on the frontend, against the
// local calendar day — the backend never computes a local "today".
/** A tag on a task: a topic id + its title for display + an optional chip color
 *  (`#RRGGBB` or null = 无色,用于看板卡片 chip 着色便于定位)。 */
export type TaskTag = { id: string; title: string; color: string | null };

export type TaskItem = {
  id: string;
  title: string;
  status: string;
  due_on: string | null;
  priority: number | null;
  /** 成就归档时间(RFC3339),null = 不在归档册。只有 list_sealed_tasks 返回的行非
   *  null;归档视图按它的本地日分组成时间轴。 */
  sealed_at: string | null;
  /** 完成时刻(RFC3339,0030 done_at),null = 未知(本功能前完成的老卡)。看板「已完成」
   *  卡显示「完成于」;归档册按 done_at ?? sealed_at 分组(完成日优先)。只增不清。 */
  done_at: string | null;
  /** Every tag on this task (M:N, item_topic). Empty = 无标签. The board shows them
   *  all as chips; the filter bar treats a task as belonging to each of its tags. */
  topics: TaskTag[];
};

export const PRIORITY_LABEL: Record<number, string> = { 1: "低", 2: "中", 3: "高" };

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) node.append(c);
  return node;
}

/** Today as a local-calendar `YYYY-MM-DD` — built from local date parts, NOT via
 *  toISOString() (which would shift to UTC and reintroduce the off-by-one bug). */
export function localToday(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---- 按天分组(时间轴)共享件 ------------------------------------------------
// 原是 inbox.ts(㊳ 灵感时间轴)的私有件;看板归档视图也按天分组,提到这里共享。
/** Midnight of a local day, as a number, for same-day grouping and 今天/昨天 math. */
function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
/** 同一天分到同一组的键(本地日)。 */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
/** 本地周一 00:00 —— 「本周」统计的界线(周一开头)。统计全是派生数、只算不存:
 *  看板归档视图数本周入册,灵感视图把它换成 UTC RFC3339 传给 idea_stats。 */
export function startOfWeek(): Date {
  const now = new Date();
  const dow = (now.getDay() + 6) % 7; // 周一=0
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
}

/** 今天 / 昨天 / 前天, else M月D日 (年.M月D日 across a year boundary). */
export function dayLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diff === 0) return "今天";
  if (diff === 1) return "昨天";
  if (diff === 2) return "前天";
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}年${md}`;
}

/** RFC3339 → full local stamp, e.g. 「6月13日 14:23」— adds the year across a year
 *  boundary (same rule as dayLabel), so a last-year entry in 回收站 / 编辑历史 / 搜索
 *  can't read as this year's. Shared by inbox + search (one source of truth). */
const stampThisYear = new Intl.DateTimeFormat("zh-CN", {
  month: "long",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const stampWithYear = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
export function when(iso: string): string {
  const d = new Date(iso);
  return (d.getFullYear() === new Date().getFullYear() ? stampThisYear : stampWithYear).format(d);
}

export type DueState = "none" | "overdue" | "today" | "future";

/** Where a due date sits relative to local today. Both are `YYYY-MM-DD`, so a
 *  plain string compare is a calendar-day compare. */
export function dueState(due: string | null, today: string): DueState {
  if (!due) return "none";
  if (due < today) return "overdue";
  if (due === today) return "today";
  return "future";
}

/** Calendar days between two `YYYY-MM-DD` days (due - today), via UTC midnights
 *  so DST never adds/drops a day. */
function dayDiff(due: string, today: string): number {
  const [ay, am, ad] = due.split("-").map(Number);
  const [by, bm, bd] = today.split("-").map(Number);
  return Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86_400_000);
}

/** A short human label for a due date relative to today. */
export function dueLabel(due: string, today: string): string {
  const diff = dayDiff(due, today);
  if (diff === 0) return "今天";
  if (diff === 1) return "明天";
  if (diff === -1) return "昨天";
  if (diff < 0) return `逾期 ${-diff} 天`;
  if (diff <= 7) return `${diff} 天后`;
  const [, m, d] = due.split("-").map(Number);
  return `${m}/${d}`;
}

/** The reusable due/priority meta controller for a board card. ㊺: the chips are now
 *  PURE DISPLAY — a set due/priority shows as a non-interactive chip (overdue/today keep
 *  their 朱砂 accent so the board still reads at a glance); an UNSET one shows nothing on
 *  the card face. All add/edit/clear is driven from the ⋯ menu (截止 S / 优先级 P), which
 *  calls `openDue()` / `openPri()` to expand the editor in place. Each editor writes
 *  through the backend, then calls `refresh` so the host re-renders from the new truth;
 *  failures go to `onError` (fail-fast, never swallowed). */
export type MetaRow = { root: HTMLElement; openDue: () => void; openPri: () => void };

export function metaRow(
  item: TaskItem,
  today: string,
  refresh: () => void,
  onError: (msg: string) => void = () => {},
): MetaRow {
  const row = el("div", { className: "task-meta" });
  const dueWrap = el("span", { className: "slot due-slot" });
  const priWrap = el("span", { className: "slot pri-slot" });

  // 成功 → refresh 重渲整卡(连带拆掉展开中的选择器)。失败 → 报错并调 recover 收起选择器,
  // 别停在没有监听的半开态(选择器的 Esc/点外 监听在 mutate 前已 off())。
  async function call(cmd: string, args: Record<string, unknown>, recover?: () => void): Promise<void> {
    try {
      await invoke(cmd, args);
    } catch (e) {
      onError(String(e));
      recover?.();
      return;
    }
    refresh();
  }

  // ---- due ----
  function renderDue(): void {
    if (!item.due_on) {
      dueWrap.replaceChildren();
      return;
    }
    const st = dueState(item.due_on, today);
    dueWrap.replaceChildren(
      el("span", { className: `chip due set ${st}`, textContent: dueLabel(item.due_on, today), title: item.due_on }),
    );
  }
  function openDue(): void {
    // Esc / 点别处 收起(和 ⋯ 菜单同一套手势),不再有「取消」按钮。选值前先 off() 摘监听,
    // 成功 refresh 会重渲整卡、失败 renderDue 收起——两条路都不会留下没监听的半开态。
    let off = () => {};
    off = armDismiss(dueWrap, renderDue);
    const apply = (dueOn: string | null): void => {
      off();
      void call("set_task_due", { id: item.id, dueOn }, renderDue);
    };
    const input = el("input", {
      className: "due-input",
      type: "date",
      value: item.due_on ?? "",
      draggable: false,
    });
    input.addEventListener("change", () => apply(input.value || null));
    const kids: Node[] = [input];
    if (item.due_on) {
      kids.push(el("button", {
        className: "link",
        textContent: "清除",
        draggable: false,
        onclick: () => apply(null),
      }));
    }
    dueWrap.replaceChildren(...kids);
    input.focus();
  }

  // ---- priority ----
  function renderPri(): void {
    if (!item.priority) {
      priWrap.replaceChildren();
      return;
    }
    priWrap.replaceChildren(
      el("span", { className: `chip pri set p${item.priority}`, textContent: `优先级·${PRIORITY_LABEL[item.priority]}` }),
    );
  }
  function openPri(): void {
    // Esc / 点别处 收起(同截止),无「取消」按钮。Esc 走 armDismiss 的文档级监听,不依赖焦点。
    let off = () => {};
    off = armDismiss(priWrap, renderPri);
    const apply = (p: number | null): void => {
      off();
      void call("set_task_priority", { id: item.id, priority: p }, renderPri);
    };
    const choices: (number | null)[] = [3, 2, 1, null];
    const buttons = choices.map((p) =>
      el("button", {
        className: `choice ${p ? `p${p}` : "none"}${item.priority === p ? " cur" : ""}`,
        textContent: p ? PRIORITY_LABEL[p] : "清除",
        draggable: false,
        onclick: () => apply(p),
      }),
    );
    priWrap.replaceChildren(...buttons);
  }

  renderDue();
  renderPri();
  row.append(dueWrap, priWrap);
  return { root: row, openDue, openPri };
}

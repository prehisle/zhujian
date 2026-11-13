import { invoke } from "./space";
import { armDismiss } from "./hotkey-menu";
import { t } from "./i18n";
import "./tasktime.css";
import { arrowWalk, el } from "./dom";
import { errText } from "./err";
import { toastAction } from "./toast";

// Shared task time-dimension helpers + a reusable due/priority editor, used by
// both the board and the Today view (one source of truth). `due_on` is a
// user-local calendar day `YYYY-MM-DD` (or null); `priority` is null = 未设, or
// 1/2/3 = 低/中/高 —— 屏上的词也是「低 / 中 / 高」(903;506 起那段时间显示的是 P 记号 3→P0 / 2→P1 / 1→P2),
// 库里存的一直是 1/2/3(表级 CHECK 钉死的三档),改的只是字典里那三个词。
// "今天/逾期" is decided here, on the frontend, against the
// local calendar day — the backend never computes a local "today".
/** A tag on a task: a topic id + its title for display + an optional chip color
 *  (`#RRGGBB` or null = 无色,用于看板卡片 chip 着色便于定位)。 */
export type TaskTag = { id: string; title: string; color: string | null };

export type TaskItem = {
  id: string;
  title: string;
  status: string;
  /** 创建时刻(RFC3339,461)。看板「时间」筛选轴据它分桶,见 filter-bar.ts::timeBucketOf。 */
  created_at: string;
  due_on: string | null;
  priority: number | null;
  /** 成就归档时间(RFC3339),null = 不在归档册。只有 list_sealed_tasks 返回的行非
   *  null;归档视图按它的本地日分组成时间轴。 */
  sealed_at: string | null;
  /** 完成时刻(RFC3339,0030 done_at),null = 未知(本功能前完成的老卡)。看板「已完成」
   *  卡显示「完成于」;归档册按 done_at ?? sealed_at 分组(完成日优先)。只增不清。 */
  done_at: string | null;
  /** 出生设备(0033 born_device),null = 未知(0033 前的存量行)。经 identity.ts 翻成
   *  署名 chip;只在「不是本机」且「那台起过别名」时显,回收站/归档册不显。 */
  born_device: string | null;
  /** 卡片颜色标记(0040),`#RRGGBB` 或 null = 无色。整卡染一层极淡底色,见 card-color.ts。
   *  **临时视觉标记,不是分类**(分类走 topics)—— 不参与筛选/排序/统计,纯展示。 */
  color: string | null;
  /** 改过没有(158 G4-A8,core `repo::revised_sql`):卡上标「改过」、⋯ 菜单出「历史」。 */
  revised: boolean;
  /** 进回收站的时刻(W3 159 / WD-37,core `TaskRow::archived_at`):list_archived_tasks 的行恒非 null,活跃看板恒 null
   *  (归档册上并发合并的双轴行也可能非 null,只回收站那一面读它)。看板回收站卡据它写「删于 …」。 */
  archived_at: string | null;
  /** Every tag on this task (M:N, item_topic). Empty = 无标签. The board shows them
   *  all as chips; the filter bar treats a task as belonging to each of its tags. */
  topics: TaskTag[];
};

/** 库里的 1/2/3 → 屏上的词(低 / 中 / 高,903)。数字越大越紧急:3 = priHigh = 「高」⇒ CSS 类 `.p3` 是最高档。 */
export const PRIORITY_LABEL: Record<number, string> = {
  1: t("tasktime.priLow"),
  2: t("tasktime.priMid"),
  3: t("tasktime.priHigh"),
};

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
  if (diff === 0) return t("tasktime.today");
  if (diff === 1) return t("tasktime.yesterday");
  if (diff === 2) return t("tasktime.dayBeforeYesterday");
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return d.getFullYear() === now.getFullYear()
    ? t("tasktime.monthDay", { m, d: day })
    : t("tasktime.yearMonthDay", { y: d.getFullYear(), m, d: day });
}

/** RFC3339 → 本地时刻,回收站 / 编辑历史 / 搜索 / 长文 / 已完成卡 / 归档 / 留言同一把尺(165 / W5 Q14,两端一个规矩):
 *  今天的写「今天 15:18」,今年别的天「11月5日 15:18」,跨年带年(「2025年11月5日 15:18」)。此前桌面这里是
 *  「11月6日 21:00」一律带日期、已完成卡 / 归档又只写「今天」、随记卡只写时刻 —— 同一天的事随页面三种写法。
 *  ⛔ 例外只有两处、都不走这里:随记时间轴的卡只写时刻(组头已写了哪天,inbox.ts 的 hm),截止胶囊窄、短写法照旧(dueLabel)。
 *  与手机 `android/src/ui.ts::fmtWhen` 逐字孪生(键 ui.when* 两端同句)。 */
export function when(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return t("ui.whenToday", { hm });
  const md = { m: d.getMonth() + 1, d: d.getDate(), hm };
  return d.getFullYear() === now.getFullYear() ? t("ui.whenThisYear", md) : t("ui.whenOtherYear", { ...md, y: d.getFullYear() });
}

/** 回执里点名「是哪一条」用的那一截(165 / W5 Q15:「已彻底删除「…」」—— 找不回的那一下得说清删的是谁)。
 *  取第一行有字的、剥掉行首的 Markdown 标题号与清单方框,空白并成一个,长了截到 `max` 个字加「…」。整条没有字(只有图)= ""。
 *  与手机 `android/src/ui.ts::itemSnippet` 逐字孪生(两端点名同一截)。 */
export function itemSnippet(content: string, max = 20): string {
  const line = content
    .split("\n")
    .map((s) => s.trim())
    .find((s) => s !== "");
  if (line === undefined) return "";
  const bare = line.replace(/^#{1,6}\s+/, "").replace(/^[-*+]\s+\[[ xX]\]\s*/, "").replace(/\s+/g, " ").trim();
  const chars = Array.from(bare);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : bare;
}

/** 截止日 `YYYY-MM-DD` → 「11月8日」(跨年带年)。回执里用(165 / W5 Q5:「已设截止 11月8日」,同手机 cardpanel.ts::dueDayText);
 *  ⛔ 不用胶囊那种「7 天后」—— 回执说的是设成了哪一天。 */
export function dueDayText(due: string): string {
  const [y, m, d] = due.split("-").map(Number);
  return y === new Date().getFullYear() ? t("tasktime.monthDay", { m, d }) : t("tasktime.yearMonthDay", { y, m, d });
}

export type DueState = "none" | "overdue" | "today" | "future";

/** 「逾期 M · 今天 N」/「今天到期 N」—— 屏上汇总钮那句的**前缀**(整句见 `dueSummaryFullLabel`)。
 *  158 G3 / Q10 起每日提醒通知也念整句(带「3 天内」),与钮逐字一致;响不响仍只看 late+now。
 *  调用方保证 late+now > 0。 */
export function dueSummaryLabel(late: number, now: number): string {
  return late > 0 ? t("board.dueSoonLate", { late, now }) : t("board.dueSoonToday", { now });
}

/** Where a due date sits relative to local today. Both are `YYYY-MM-DD`, so a
 *  plain string compare is a calendar-day compare. */
export function dueState(due: string | null, today: string): DueState {
  if (!due) return "none";
  if (due < today) return "overdue";
  if (due === today) return "today";
  return "future";
}

/** 完成的任务不再算「到期需要处理」——即使当初设过如今已经过去的截止日,做完的东西
 *  不该继续占看板顶栏汇总 / 卡片朱砂强调 / 每日提醒的「逾期/今天」计数。不改卡片自身
 *  due chip 的颜色(`metaRow` 的 `renderDue` 不经这里)——那颗 chip 答的是「这条哪天到
 *  期」这件事实,完成与否是另一回事,历史信息留着;三处「要不要吓人 / 算不算数」的口径
 *  才用这个。
 *  0043(多看板):「完成」= 卡在它那块看板**解析后的完成列**里 ⇒ 调用方传 `boards.ts` 的
 *  `doneColumnSet`(core 解析的结果),⛔ 别再比 `"done"` 字面量。 */
export function dueAttentionState(item: Pick<TaskItem, "due_on" | "status">, today: string, doneCols: ReadonlySet<string>): DueState {
  if (doneCols.has(item.status)) return "none";
  return dueState(item.due_on, today);
}

/** 「快到期」的窗口:今天之后这么多天内到期 = 值得提前预警。⭐ 单一真相源 —— 屏上那句
 *  话里的天数由它注入(`{days}`),⛔ 别在字典里写死一个 3。 */
export const DUE_SOON_DAYS = 3;

/** 这条算不算「快到期」:未完成 · 有截止日 · 落在今天之后的 `DUE_SOON_DAYS` 天内。
 *  ⛔ **刻意不做成 `DueState` 的第五档** —— 那个枚举同时喂着卡片那颗 due chip 的上色
 *  (`dueState` → `renderDue`),给它加一档会让 chip 跟着变脸,而「汇总的口径与卡片 chip
 *  刻意不同」是已拍过板的形。这里只答汇总钮 / 只看到期那一根轴。 */
export function isDueSoon(item: Pick<TaskItem, "due_on" | "status">, today: string, doneCols: ReadonlySet<string>): boolean {
  // "future" 已保证:未完成、due_on 非 null、且严格晚于今天 ⇒ 这里只剩「远不远」要判。
  if (dueAttentionState(item, today, doneCols) !== "future") return false;
  return dayDiff(item.due_on as string, today) <= DUE_SOON_DAYS;
}

/** 汇总钮的整句 —— 在 `dueSummaryLabel` 之上再挂一段「{days} 天内 {n}」。
 *  每日提醒通知 158 G3 / Q10 起也念这一整句(此前少「3 天内」那段,点进看板数对不上)。
 *  ⛔ 但**响不响**仍只看逾期 + 今天(用户 2026-09-01 拍板「只在真出事时才说话」):只有快到期的
 *  那天通知不响,见 `reminder.ts`。调用方保证 late+now+soon > 0。 */
export function dueSummaryFullLabel(late: number, now: number, soon: number): string {
  if (late + now === 0) return t("board.dueSoonNextOnly", { n: soon, days: DUE_SOON_DAYS });
  const head = dueSummaryLabel(late, now);
  return soon === 0 ? head : `${head} · ${t("board.dueSoonNext", { n: soon, days: DUE_SOON_DAYS })}`;
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
  if (diff === 0) return t("tasktime.today");
  if (diff === 1) return t("tasktime.tomorrow");
  // 158 G3 / Q13(WD-34):逾期一天此前说「昨天」,别处都是「逾期 N 天」—— 统一成「逾期 1 天」。
  if (diff < 0) return t("tasktime.overdueDays", { n: -diff });
  if (diff <= 7) return t("tasktime.inDays", { n: diff });
  const [, m, d] = due.split("-").map(Number);
  return `${m}/${d}`;
}

/** 已完成卡上那枚灰章:只写截止那天(「截止 10/12」),不说离今天多远 —— 「逾期 / 今天」是给没做完的看的。
 *  跨年才带年份(同 dayLabel 的规矩)。 */
export function dueDateLabel(due: string, today: string): string {
  const [y, m, d] = due.split("-").map(Number);
  const day = y === Number(today.slice(0, 4)) ? t("tasktime.monthDay", { m, d }) : t("tasktime.yearMonthDay", { y, m, d });
  return t("tasktime.dueOn", { day });
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
  onError: (msg: string) => void,
  /** 选择器没写库就收起(Esc / 没改 / 没填完)、焦点原在它里面时调:把焦点还给卡(W5 A4 / Q2)。
   *  写了库的那条路走 refresh 重画,焦点由卡片控制器按 id 接回。 */
  refocus: () => void,
  /** 截止 / 优先级真写进库之后调(165 / W5 Q5 ★①):宿主据此出「已设截止 … 撤销」那一条。`before` / `after` = 改前 / 改后的值
   *  (null = 没设 / 清除)。写失败、没改(值一样)不调。 */
  onWritten: (change: { field: "due"; before: string | null; after: string | null } | { field: "priority"; before: number | null; after: number | null }) => void,
  /** 这张卡在不在它那块看板的完成列里(0043:宿主按 core 解析的角色给,⛔ 别在这里比字面量)。 */
  isDone: boolean,
): MetaRow {
  const row = el("div", { className: "task-meta" });
  const dueWrap = el("span", { className: "slot due-slot" });
  const priWrap = el("span", { className: "slot pri-slot" });
  arrowWalk(priWrap); // 优先级那一排展开时 ← → 在档位间挪(W5 A39);平时这里只有一枚不可聚焦的章,不截键

  // 成功 → refresh 重渲整卡(连带拆掉展开中的选择器)。失败 → 报错并调 recover 收起选择器,
  // 别停在没有监听的半开态(选择器的 Esc/点外 监听在 mutate 前已 off())。
  async function call(cmd: string, args: Record<string, unknown>, recover?: () => void): Promise<boolean> {
    try {
      await invoke(cmd, args);
    } catch (e) {
      onError(errText(e));
      recover?.();
      return false;
    }
    refresh();
    return true;
  }

  // ---- due ----
  function renderDue(): void {
    if (!item.due_on) {
      dueWrap.replaceChildren();
      return;
    }
    // 158 G3 / Q4(WD-10):已完成的卡不再说「逾期 / 今天」,只留一枚灰色的截止日期 —— 与顶栏汇总、
    // 卡片朱砂、每日提醒「完成的不算」同一口径(dueAttentionState)。日期照写(这条哪天到期是事实)。
    const done = isDone;
    const st = done ? "done" : dueState(item.due_on, today);
    // 158 G2 / A17(WD-27):章本身点得开选择器(此前只能走 ⋯ → 截止 / `/` S,点章没反应)。
    // ⚠ 宿主卡的 CARD_CONTROLS 认 `.chip`,按在章上不起拖、双击不进编辑。
    const chip = el("span", {
      className: `chip due set ${st} clickable`,
      textContent: done ? dueDateLabel(item.due_on, today) : dueLabel(item.due_on, today),
      title: t("tasktime.dueChipTitle", { day: item.due_on }),
    });
    chip.setAttribute("role", "button");
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      openDue();
    });
    dueWrap.replaceChildren(chip);
  }
  function openDue(): void {
    // Esc 收起不存、点别处 / 回车存(158 G2 / A2,WD-02:此前 `change` 一来就存并收框 ——
    // 日期框逐段输入时**每凑成一个合法日期**都发 change,想打「10」月敲到「1」就存成 1 月,
    // 框一收后面那个「0」还落到悬停卡的数字键上换了色)。现在键盘逐段改只改框里的值,
    // 离开(回车 / 点别处)时一次性存;只有日历弹出层里点选(不经页面 keydown)才当场存。
    // 选值前先 off() 摘监听,成功 refresh 会重渲整卡、失败 renderDue 收起 —— 不留没监听的半开态。
    let off = () => {};
    let done = false;
    /** 不写库就收起:画回原样,焦点原在框里的还给卡。 */
    const fold = (): void => {
      const had = dueWrap.contains(document.activeElement);
      renderDue();
      if (had) refocus();
    };
    const apply = (dueOn: string | null): void => {
      if (done) return;
      done = true;
      off();
      if (dueOn === (item.due_on ?? null)) {
        fold(); // 没改:收起,不打后端
        return;
      }
      const before = item.due_on ?? null;
      void call("set_task_due", { id: item.id, dueOn }, renderDue).then((ok) => {
        if (ok) onWritten({ field: "due", before, after: dueOn });
      });
    };
    const input = el("input", {
      className: "due-input",
      type: "date",
      value: item.due_on ?? "",
      draggable: false,
    });
    // 165 / W5 A11(WD-10 / 第二批新撞-1):框里有字、值却是空的(连着打「20261108」年那一格全吃进去成了「202611/08/日」、
    // 只填了年、打了「-」「/」不跳格)—— 此前回车一收、卡上什么都没设上、一个字不说,以为设好了、到期没提醒。
    // ⇒ 认出这一形就说一句:回车 = 框留着、在框旁说清怎么填(焦点留在框里,接着改;Esc 放弃);点别处 = 照原样收起、
    // 底部说一句没设上。⛔ 只在前端认,截止的存储一个字不动(值合法才写,同此前)。
    // 第二形(走查后实测):卡上原本有截止时,连打「20261108」框里成了「202611-08-04」—— 系统日期框认六位年、值是「合法」的,
    // 回车送下去被库拒(CHECK 约束,横幅一句「和已有的数据对不上」,读不出错在哪)。⇒ 年不是四位的也当没填好、同一句话。
    const unfinished = (): boolean =>
      input.value === "" ? input.validity.badInput || !input.validity.valid : !/^\d{4}-\d{2}-\d{2}$/.test(input.value);
    const say = el("span", { className: "due-err err-msg", textContent: t("tasktime.dueUnfinished") });
    say.setAttribute("role", "alert");
    /** 离开时把框里的值落盘。逐段没填完(`badInput`)= 什么也不存,照原样收起 —— 不猜,但说一声(A11)。 */
    const commit = (): void => {
      if (unfinished()) {
        done = true;
        off();
        fold();
        toastAction(t("tasktime.dueNotSet"));
        return;
      }
      apply(input.value || null);
    };
    off = armDismiss(dueWrap, commit, { escape: () => {
      done = true;
      fold();
    } });
    // 键盘改段那几下发的 change 不算「选定」:按键那一拍之内到的 change 一律只记在框里。
    let typing = false;
    input.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if (e.key === "Enter") {
        e.preventDefault();
        // A11:没填完的日期回车 ⇒ 不收、不存,框旁说怎么填(再回车同样;改对了回车才存)。
        if (unfinished()) {
          if (!say.isConnected) dueWrap.append(say);
          return;
        }
        commit();
        return;
      }
      if (say.isConnected) say.remove(); // 接着改了:那句先收,等下一次回车再判
      typing = true;
      setTimeout(() => (typing = false), 0);
    });
    input.addEventListener("change", () => {
      if (typing) return;
      commit();
    });
    const kids: Node[] = [input];
    if (item.due_on) {
      kids.push(el("button", {
        className: "link",
        textContent: t("tasktime.clear"),
        draggable: false,
        onclick: () => apply(null),
      }));
    }
    dueWrap.replaceChildren(...kids);
    input.focus();
    // 列尾那张卡的「清除」被列可视区切掉半截(158 G2 / A11,WD-20):开出来就滚进视野。
    dueWrap.scrollIntoView({ block: "nearest" });
  }

  // ---- priority ----
  function renderPri(): void {
    if (!item.priority) {
      priWrap.replaceChildren();
      return;
    }
    priWrap.replaceChildren(
      el("span", { className: `chip pri set p${item.priority}`, textContent: t("tasktime.priorityChip", { p: PRIORITY_LABEL[item.priority] }) }),
    );
  }
  function openPri(): void {
    // Esc / 点别处 收起(同截止),无「取消」按钮。Esc 走 armDismiss 的文档级监听,不依赖焦点。
    let off = () => {};
    off = armDismiss(priWrap, () => {
      const had = priWrap.contains(document.activeElement);
      renderPri();
      if (had) refocus();
    });
    const apply = (p: number | null): void => {
      off();
      const before = item.priority ?? null;
      if (p === before) {
        // 点的就是当前那档:不打后端(此前照写一遍、白发一条 op),收起;焦点原在这排里的还给卡。
        const had = priWrap.contains(document.activeElement);
        renderPri();
        if (had) refocus();
        return;
      }
      void call("set_task_priority", { id: item.id, priority: p }, renderPri).then((ok) => {
        if (ok) onWritten({ field: "priority", before, after: p });
      });
    };
    // 高档在前(高 · 中 · 低 · 清除)。
    const choices: (number | null)[] = [3, 2, 1, null];
    const buttons = choices.map((p) =>
      el("button", {
        className: `choice ${p ? `p${p}` : "none"}${item.priority === p ? " cur" : ""}`,
        textContent: p ? PRIORITY_LABEL[p] : t("tasktime.clear"),
        draggable: false,
        onclick: () => apply(p),
      }),
    );
    priWrap.replaceChildren(...buttons);
    // W5 A39(WD-22):焦点进这一排(落在当前那档,没设落第一枚),整排滚进列的可视区 —— 此前焦点不进、
    // 列尾那张的【清除】被列下沿截掉、列也不跟着滚。
    (buttons.find((b) => b.classList.contains("cur")) ?? buttons[0])?.focus({ preventScroll: true });
    priWrap.scrollIntoView({ block: "nearest" });
  }

  renderDue();
  renderPri();
  row.append(dueWrap, priWrap);
  return { root: row, openDue, openPri };
}

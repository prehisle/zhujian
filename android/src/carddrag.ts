// 竖屏长按拖卡(158 G3 / Q7,W2 走查 WM-11):手机竖放时任务面是四节串成的一条长列表,此前长按没反应、
// 一拖就是滚页面,换列只能走「列 ▾」菜单或横滑(横滑只到相邻那列)。⇒ 长按一张任务卡把它拿起来,
// 拖到哪一节的哪两张之间就落在那儿;拖到屏上沿 / 下沿自动滚。
//
// 手势怎么和滚动、横滑分开(⛔ 三条别拆):
//  ① **拿起之前一切照旧**:按下后手指挪出 SLOP 就放弃(竖挪 = 原生滚动,横挪 = swipe.ts 的横滑);
//     只有「按住不动 LONG_PRESS_MS」才拿起。
//  ② **拿起之后不许页面滚**:`#timeline` 上挂一只**非被动**的 touchmove,拖着的时候 preventDefault。
//     ⚠ 必须是**从按下那一刻起就挂着**的非被动监听 —— Chromium 在 touchstart 那一下决定这一串 touch
//     要不要等主线程答复,拿起时才临时挂上的监听拿到的 touchmove 是不可取消的。只挂在时间轴上
//     (不挂 document):别的面滑动不受这只监听拖累。
//  ③ 拿起那一下有手感:卡浮起来(放大一点 + 阴影)+ 原生短震(`__zhujianHaptic`,MainActivity.kt;
//     `performHapticFeedback` 不要权限,跟随系统「触感反馈」开关)。⚠ 鸿蒙壳没有这只桥 —— 震不了,
//     浮起那一下照样有(同 theme.ts 那条系统栏桥的降级:看得见的那一半是真生效的)。
//
// 落点 = 手指所在那一节、按各卡中线切出来的那个空位(一条朱砂横线标着)。写走 `reorder_task`(强契约路):
// 筛选着的时候屏上只是一列的子集 ⇒ 按「紧跟在屏上前一张之后 / 屏上后一张之前」换算回整列序
// (与 core 的 reorder_visible 同一个锚法),base 用整列真序,乐观并发闸照常把关。
// 回执与撤销同其余三条挪卡路(taskmove.ts):撤销放回原位置,落到屏外带「去看看」。
//
// 不拖的几种:宽屏看板(那儿是横滑 + 列并排;本轮只做竖屏)、只看到期时(那时按截止排,不是手动序 ——
// 长按说一句为什么)、已删的列(只读收容区,卡只出不进:那一节不画落点线)。
// ⚠ 空节在竖屏上不画(146 §2.1)⇒ 拖不进一张卡都没有的列;那种走「列 ▾」菜单。
import { reorderTask, type TimelineItem } from "./api";
import { t } from "./i18n";
import { showBar } from "./ui";
import { showErr } from "./err";
import { isTaskStage, liveTaskColumns, stageLabel } from "./columns";
import { moveReceipt, spotOf } from "./taskmove";

const LONG_PRESS_MS = 380; // 抢在 WebView 自己的长按(选字 / 菜单,~500ms)之前
const SLOP = 8; // 拿起之前手指挪出这么远 = 不是长按
const EDGE = 72; // 离可视区上 / 下沿这么近开始自动滚
const MAX_SPEED = 16; // 每帧最多滚这么多 px

type Deps = {
  getItem: (id: string) => TimelineItem | undefined;
  getCurrentSpace: () => string;
  isSwitching: () => boolean;
  hasDirtyDraft: () => boolean;
  /** 屏上是宽屏看板吗(body.board)。 */
  isBoard: () => boolean;
  /** 任务面「只看到期」开着吗(那时卡按截止排)。 */
  dueSorted: () => boolean;
  /** 看板手动序全量(含被筛掉的)。 */
  order: () => { id: string; stage: string }[];
  refresh: () => Promise<void>;
  /** 拖完:补上拖着期间被延后的刷新(main.ts 的 onDraftClosed 那一支)。 */
  onDone: () => void;
};

type Target = { stage: string; before: string | null; after: string | null };

let deps: Deps;
let pending: { card: HTMLElement; id: string; pointerId: number; x: number; y: number; timer: number } | null = null;
let drag: {
  card: HTMLElement;
  id: string;
  from: string;
  pointerId: number;
  startY: number;
  startScroll: number;
  y: number;
  line: HTMLElement;
  raf: number;
  target: Target | null;
} | null = null;
let swallowClick = false;

/** 长按拖拿起着吗(swipe.ts 据此让手;main.ts 的刷新据此延后)。 */
export const isDragging = (): boolean => drag !== null;

function cancelPending(): void {
  if (!pending) return;
  clearTimeout(pending.timer);
  pending = null;
}

/** 可视区的上下沿(顶栏 + 吸顶筛选条之下、底栏之上)。 */
function band(): { top: number; bottom: number } {
  const cs = getComputedStyle(document.documentElement);
  const top = (parseFloat(cs.getPropertyValue("--head-h")) || 0) + (parseFloat(cs.getPropertyValue("--fbar-h")) || 0);
  const nav = document.getElementById("bottombar");
  const navR = nav && nav.getClientRects().length > 0 ? nav.getBoundingClientRect() : null;
  return { top, bottom: navR && navR.top > window.innerHeight / 2 ? navR.top : window.innerHeight };
}

function lift(): void {
  if (!pending) return;
  const { card, id, pointerId, y } = pending;
  pending = null;
  const item = deps.getItem(id);
  if (!item || !card.isConnected || deps.isSwitching() || deps.hasDirtyDraft() || deps.isBoard()) return;
  if (deps.dueSorted()) {
    showBar(t("carddrag.dueSorted"), true);
    swallowClick = true;
    return;
  }
  const line = document.createElement("div");
  line.className = "drag-line";
  line.hidden = true;
  document.body.appendChild(line);
  drag = { card, id, from: item.stage, pointerId, startY: y, startScroll: window.scrollY, y, line, raf: 0, target: null };
  card.classList.add("lifted");
  document.body.classList.add("card-dragging");
  swallowClick = true;
  (window as unknown as { __zhujianHaptic?: { longPress(): void } }).__zhujianHaptic?.longPress();
  frame();
}

/** 每帧:屏边自动滚 → 卡跟手 → 重算落点。 */
function frame(): void {
  if (!drag) return;
  const b = band();
  let v = 0;
  if (drag.y < b.top + EDGE) v = -MAX_SPEED * Math.min(1, (b.top + EDGE - drag.y) / EDGE);
  else if (drag.y > b.bottom - EDGE) v = MAX_SPEED * Math.min(1, (drag.y - (b.bottom - EDGE)) / EDGE);
  if (v !== 0) window.scrollBy(0, Math.round(v));
  drag.card.style.transform = `translateY(${drag.y - drag.startY + window.scrollY - drag.startScroll}px) scale(1.02)`;
  drag.target = locate(drag.y, b);
  drag.raf = requestAnimationFrame(frame);
}

/** 手指此刻对着的落点,顺手摆好那条横线;对着已删的列(或什么都没对着)= null。 */
function locate(y: number, b: { top: number; bottom: number }): Target | null {
  if (!drag) return null;
  const line = drag.line;
  const secs = [...document.querySelectorAll<HTMLElement>("#timeline > .tl-group[data-col]")];
  if (secs.length === 0) {
    line.hidden = true;
    return null;
  }
  // 手指所在那一节;夹在两节之间 / 越出首尾就取最近的那节。
  let sec = secs[0];
  let best = Infinity;
  for (const s of secs) {
    const r = s.getBoundingClientRect();
    const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    if (d < best) {
      best = d;
      sec = s;
    }
  }
  const stage = sec.dataset.col!;
  if (!liveTaskColumns().some((c) => c.id === stage)) {
    line.hidden = true;
    return null;
  }
  const cards = [...sec.querySelectorAll<HTMLElement>(":scope > article.card[data-id]")].filter((c) => c !== drag!.card);
  let before: HTMLElement | null = null;
  for (const c of cards) {
    const r = c.getBoundingClientRect();
    if (r.top + r.height / 2 > y) {
      before = c;
      break;
    }
  }
  const after = before ? (cards[cards.indexOf(before) - 1] ?? null) : (cards[cards.length - 1] ?? null);
  const sr = sec.getBoundingClientRect();
  let ly: number;
  if (before) ly = before.getBoundingClientRect().top - 5;
  else if (after) ly = after.getBoundingClientRect().bottom + 3;
  else ly = (sec.querySelector(".tl-sec")?.getBoundingClientRect().bottom ?? sr.top) + 3;
  line.hidden = ly < b.top || ly > b.bottom;
  line.style.top = `${Math.round(ly)}px`;
  line.style.left = `${Math.round(sr.left)}px`;
  line.style.width = `${Math.round(sr.width)}px`;
  return { stage, before: before?.dataset.id ?? null, after: after?.dataset.id ?? null };
}

function endDrag(commit: boolean): void {
  if (!drag) return;
  const { card, id, from, line, raf, target } = drag;
  cancelAnimationFrame(raf);
  line.remove();
  card.classList.remove("lifted");
  card.style.transform = "";
  document.body.classList.remove("card-dragging");
  drag = null;
  if (commit && target) void drop(id, from, target);
  else deps.onDone();
}

/** 屏上的落点换算回整列序再写。 */
async function drop(id: string, from: string, tg: Target): Promise<void> {
  const full = deps.order().filter((x) => x.stage === tg.stage).map((x) => x.id);
  const rest = full.filter((x) => x !== id);
  let at: number;
  if (tg.after !== null && rest.includes(tg.after)) at = rest.indexOf(tg.after) + 1;
  else if (tg.before !== null && rest.includes(tg.before)) at = rest.indexOf(tg.before);
  else at = tg.before === null ? rest.length : 0; // 两个邻居都不在了(两次读之间被挪走):按「在列尾 / 列首」那半落
  const ordered = [...rest.slice(0, at), id, ...rest.slice(at)];
  if (from === tg.stage && ordered.every((x, i) => x === full[i])) {
    deps.onDone(); // 原位放下:不写
    return;
  }
  const space = deps.getCurrentSpace();
  const spot = spotOf(id);
  try {
    await reorderTask(space, id, from, tg.stage, full, ordered);
  } catch (err) {
    showErr(err);
    deps.onDone();
    await deps.refresh();
    return;
  }
  deps.onDone();
  await deps.refresh();
  if (deps.getCurrentSpace() !== space) return;
  const msg = from === tg.stage ? t("carddrag.reordered") : t("swipe.changedTo", { stage: stageLabel(tg.stage)! });
  moveReceipt(space, id, msg, spot);
}

export function initCardDrag(d: Deps): void {
  deps = d;
  const timeline = document.getElementById("timeline")!;

  timeline.addEventListener("pointerdown", (e) => {
    cancelPending();
    swallowClick = false;
    if (drag || !e.isPrimary || e.button !== 0) return;
    if (document.body.dataset.view !== "tasks" || deps.isBoard() || deps.isSwitching() || deps.hasDirtyDraft()) return;
    const el = e.target as HTMLElement;
    if (el.closest(".tick, .ckbox, .thumb, .panel, .cm-badge, .fold-toggle")) return;
    const card = el.closest<HTMLElement>("article.card[data-id]");
    if (!card || card.querySelector(".panel")) return;
    const id = card.dataset.id!;
    const item = deps.getItem(id);
    if (!item || !isTaskStage(item.stage)) return;
    pending = { card, id, pointerId: e.pointerId, x: e.clientX, y: e.clientY, timer: window.setTimeout(lift, LONG_PRESS_MS) };
  });

  // 拖的阶段挂在 document 上:拖着时卡被重画掉(理论上不会 —— 刷新被延后了)也收得到抬手。
  document.addEventListener("pointermove", (e) => {
    if (pending && e.pointerId === pending.pointerId) {
      if (Math.hypot(e.clientX - pending.x, e.clientY - pending.y) > SLOP) cancelPending();
      return;
    }
    if (drag && e.pointerId === drag.pointerId) drag.y = e.clientY;
  });
  document.addEventListener("pointerup", (e) => {
    if (pending && e.pointerId === pending.pointerId) cancelPending();
    if (drag && e.pointerId === drag.pointerId) endDrag(true);
  });
  document.addEventListener("pointercancel", (e) => {
    if (pending && e.pointerId === pending.pointerId) cancelPending();
    if (drag && e.pointerId === drag.pointerId) endDrag(false);
  });

  // ② 拿起之后不许页面滚(为什么必须一直挂着,见文件头)。
  timeline.addEventListener(
    "touchmove",
    (e) => {
      if (drag) e.preventDefault();
    },
    { passive: false },
  );
  // 长按那一下 WebView 自己的菜单 / 选字:等着拿起或已拿起时不要。
  timeline.addEventListener("contextmenu", (e) => {
    if (pending || drag) e.preventDefault();
  });
  // 拿起过 = 这一指不是点击:吞掉抬手后那一记 click(别顺手把操作面开了)。
  timeline.addEventListener(
    "click",
    (e) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.stopImmediatePropagation();
      e.preventDefault();
    },
    true,
  );
}

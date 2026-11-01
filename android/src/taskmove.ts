// 挪卡的回执与撤销(158 G3:Q1 / Q2 / Q7)—— 状态菜单换列、横滑、勾完成 / 点回待办、长按拖,四条路共用这一套。
//
// ① **撤销回原位置**(Q7):此前撤销 = `update_task_status` 换回原列,而那条命令恒把卡落到列尾 ⇒ 挪一下再撤销,
//    卡就从列首跑到了列尾。⇒ 动手前记下它在原列里的**邻居**(前一张 / 后一张),撤销时现读一遍看板序,
//    插回那两张之间,走 `reorder_task`(跨列也认,单键写,core 不用动)。邻居都不在了(别处删了 / 挪了)
//    就按「原来在列首 ⇒ 列首,否则列尾」落。
// ② **落在视野外 ⇒ 回执带「去看看」**(Q1):挪完重画之后量一下那张卡在不在屏上;在就闪一下,
//    不在就在「撤销」旁边挂一枚「去看看」(main.ts 的 focusTimelineCard:必要时清掉藏着它的筛选、滚过去、闪一下)。
//    ⛔ 不自动滚过去 —— 用户正在读的那一屏不该被一次挪卡拽走(同 158 G2 新建那半的拍法)。
import { listTasks, reorderTask } from "./api";
import { t } from "./i18n";
import { actionBar } from "./ui";
import { showErr } from "./err";

/** 卡在看板里的位置:哪一列 + 前后两个邻居(null = 列首 / 列尾)。 */
export type Spot = { stage: string; prev: string | null; next: string | null };

type Deps = {
  /** 最近一次读到的看板手动序(全量,含被筛掉的;list_tasks 的序)。 */
  order: () => { id: string; stage: string }[];
  refresh: () => Promise<void>;
  /** main.ts 的 focusTimelineCard。 */
  focusCard: (id: string) => void;
  isSwitching: () => boolean;
  getCurrentSpace: () => string;
};

let deps: Deps;

export function initTaskMove(d: Deps): void {
  deps = d;
}

/** 这张卡此刻在哪(动手**之前**调)。卡在屏上 ⇒ 必在看板序里;不在 = 调用方的 bug,响亮抛。 */
export function spotOf(id: string): Spot {
  const all = deps.order();
  const me = all.find((x) => x.id === id);
  if (!me) throw new Error(`看板序里没有这张卡:${id}`);
  const col = all.filter((x) => x.stage === me.stage).map((x) => x.id);
  const i = col.indexOf(id);
  return { stage: me.stage, prev: i > 0 ? col[i - 1] : null, next: i < col.length - 1 ? col[i + 1] : null };
}

/** 把卡放回 `spot`(现读看板序,base 用的是库里此刻的真序 ⇒ reorder 的乐观并发闸照常把关)。 */
export async function putBack(space: string, id: string, spot: Spot): Promise<void> {
  const tasks = await listTasks(space);
  const me = tasks.find((x) => x.id === id);
  if (!me) throw new Error(t("main.itemGone"));
  const col = tasks.filter((x) => x.status === spot.stage).map((x) => x.id);
  const rest = col.filter((x) => x !== id);
  let at: number;
  if (spot.prev !== null && rest.includes(spot.prev)) at = rest.indexOf(spot.prev) + 1;
  else if (spot.next !== null && rest.includes(spot.next)) at = rest.indexOf(spot.next);
  else at = spot.prev === null ? 0 : rest.length;
  const ordered = [...rest.slice(0, at), id, ...rest.slice(at)];
  if (me.status === spot.stage && ordered.every((x, i) => x === col[i])) return; // 已在原位
  await reorderTask(space, id, me.status, spot.stage, col, ordered);
}

function cardEl(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`#timeline article.card[data-id="${id}"]`); // ULID 仅字母数字
}

/** 卡在不在「看得见」的那一段里:顶栏 + 筛选条(吸顶)之下、底栏之上,露出至少一截。 */
export function inView(card: HTMLElement): boolean {
  const r = card.getBoundingClientRect();
  if (r.height === 0) return false;
  const cs = getComputedStyle(document.documentElement);
  const top = (parseFloat(cs.getPropertyValue("--head-h")) || 0) + (parseFloat(cs.getPropertyValue("--fbar-h")) || 0);
  const nav = document.getElementById("bottombar");
  const navR = nav && nav.getClientRects().length > 0 ? nav.getBoundingClientRect() : null;
  const floor = navR && navR.top > window.innerHeight / 2 ? navR.top : window.innerHeight;
  const SLICE = 24;
  return r.bottom > top + SLICE && r.top < floor - SLICE;
}

export function flashCard(card: HTMLElement): void {
  card.classList.remove("flash");
  void card.offsetWidth; // 连挪两次:重启动画
  card.classList.add("flash");
  window.setTimeout(() => card.classList.remove("flash"), 1200);
}

/** 挪完(写已成、轴已重拉)之后的回执:在屏上就闪一下;不在就挂「去看看」。撤销 = 放回原位。 */
export function moveReceipt(space: string, id: string, msg: string, spot: Spot): void {
  const card = cardEl(id);
  const seen = card !== null && inView(card);
  if (card && seen) flashCard(card);
  const undo = (): void => {
    if (deps.isSwitching() || deps.getCurrentSpace() !== space) return; // 换空间的旧撤销作废
    void (async () => {
      try {
        await putBack(space, id, spot);
      } catch (err) {
        showErr(err);
      }
      await deps.refresh();
      const c = cardEl(id);
      if (c && inView(c)) flashCard(c);
    })();
  };
  actionBar(msg, t("ui.undo"), undo, seen ? undefined : { label: t("cardpanel.goSee"), on: () => deps.focusCard(id) });
}

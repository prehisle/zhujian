// 卡片「更多…」的屏底菜单(906,用户 2026-11-13 拍「屏底弹出的菜单列表」):此前「更多…」是卡片里展开的一面
// —— 一堆药丸钮折成两三排、底下单挂一枚「返回」。换成屏底滑上来的一张菜单层(与捕获 / 编辑 / 选日期同一座底部层,
// 宽屏上跟着变浮窗):一行一项、左对齐、行间细线;「删除」在最底下单独一段。没有「返回」钮 ——
// 点遮罩 / 返回键 / 选了一项都收层。
//
// 分工同选日期那一层(datepick.ts,⛔ 别揉到一起):本层只管 DOM、开合与返回键守门条目;列哪几项、各自的出现条件、
// 选了之后做什么(busy 闸、session 判弃、两拍确认)全在宿主(cardpanel)。
// 关层两条路:UI(选一项 / 点遮罩 / 宿主收场)→ `closeMoreSheet()`(收 DOM + settleHistory);
// 返回键 → main.ts 的 popstate 已弹掉条目 ⇒ `closeMoreSheetNow()`(只收 DOM)。两者都幂等。
import { createKbSheet, type KbSheet } from "./kbsheet";
import { $, esc } from "./ui";

/** 菜单里的一项。`warn` = 朱砂字(撤回 / 删除)。 */
export type MoreItem = { act: string; label: string; warn?: boolean };

export type MoreSheetHost = {
  /** 选了一项。层已收。 */
  onPick(act: string): void;
};

type Deps = {
  /** 开层压一枚返回键守门条目(main.ts 的层账本)。 */
  pushLayer: () => void;
  /** UI 主动收层后平掉那枚条目;popstate 关的层⛔不许调。 */
  settleHistory: () => void;
};

let deps: Deps;
let kb: KbSheet | null = null;
let host: MoreSheetHost | null = null;

/** 顶上至少留这么一条背景(手机横放时可见区比菜单矮 ⇒ 层按它夹高、层里滚;数同选日期那一层)。 */
const RESERVE_TOP = 40;

export function isMoreSheetOpen(): boolean {
  return host !== null;
}

/** 画菜单。`tail` = 最底下单独那一段(删除);其余按宿主给的次序一行一项。 */
function paint(items: MoreItem[], tail: MoreItem[]): void {
  const row = (it: MoreItem): string => {
    return `<button type="button" role="menuitem" class="ms-item${it.warn ? " warn" : ""}" data-more-act="${esc(it.act)}">${esc(it.label)}</button>`;
  };
  $("more-list").innerHTML =
    `<div class="ms-group">${items.map(row).join("")}</div>` + (tail.length > 0 ? `<div class="ms-group ms-tail">${tail.map(row).join("")}</div>` : "");
}

/** 层开着时宿主那张卡变了(同步推来的改动重画了操作面):原地换菜单,不动开合。层没开 = no-op。 */
export function repaintMoreSheet(items: MoreItem[], tail: MoreItem[]): void {
  if (host) paint(items, tail);
}

/** 收层的 DOM 部分:popstate(返回键)与 UI 关层共用;history 账目由调用方处置。幂等。 */
export function closeMoreSheetNow(): void {
  if (!host) return;
  host = null;
  kb?.close();
  $("more-list").innerHTML = "";
}

/** UI 主动收层:顺带平掉守门条目。层没开就是 no-op(返回键那条路已先收掉)。 */
export function closeMoreSheet(): void {
  if (!host) return;
  closeMoreSheetNow();
  deps.settleHistory();
}

export function openMoreSheet(items: MoreItem[], tail: MoreItem[], h: MoreSheetHost): void {
  const first = host === null;
  host = h;
  paint(items, tail);
  if (!first) return;
  // 键盘开着(过滤框握着焦点)时先收键盘:这一层里没有要打字的东西(同选日期那一层)。
  const a = document.activeElement;
  if (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement) a.blur();
  $("more-sheet").scrollTop = 0;
  kb?.open();
  deps.pushLayer(); // 返回键第一本能 = 关掉这层
}

export function initMoreSheet(d: Deps): void {
  deps = d;
  const sheet = $("more-sheet");
  kb = createKbSheet({
    sheet,
    scrim: $("more-scrim"),
    input: sheet, // 层里没有输入框;kbsheet 收层时 blur 它是空操作
    reserveTop: RESERVE_TOP,
    onDismiss: closeMoreSheet, // 点遮罩 = 什么都不做、收层
  });
  $("more-list").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-more-act]");
    const h = host;
    if (!b || !h) return;
    const act = b.dataset.moreAct!;
    closeMoreSheet(); // 先收层,再交给宿主(进历史 / 移动 / 挪到看板这些子面照旧在卡片里展开)
    h.onPick(act);
  });
}

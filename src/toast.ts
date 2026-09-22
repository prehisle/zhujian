// 一次性浮动回执(228)——桌面此前**没有通用回执通道**:同步面板那条是同步专用的,
// item-images 里的 flashToast 只会跟随光标飘一下,于是「跨空间移动成功」这类动作做完
// 什么都不说(卡片默默消失),而安卓那边给的是绿条——端间不对称。把它提成共享件,
// 免得 board.ts / inbox.ts 各抄一份(漂移必须消灭)。
//
// 刻意不做成常驻通知中心:朱简的回执只需要「我看到了,做完了」,读完即走。
import "./toast.css";
import { TOAST_ERROR_MS, UNDO_WINDOW_MS, toastSuccessMs } from "./timing";

const HOLD_MS = 1000; // 跟随光标那种(复制链接/复制图片):瞥一眼就够

/** 在视口坐标 (x, y) 上方飘一条,`ms` 内淡入-停留-淡出后自己移除。
 *  `extraClass` 给调用方调 z(如大图遮罩里要抬到遮罩之上)。 */
export function flashToast(
  x: number,
  y: number,
  text: string,
  opts: { extraClass?: string; ms?: number } = {},
): void {
  const ms = opts.ms ?? HOLD_MS;
  const t = document.createElement("div");
  t.className = `copy-toast${opts.extraClass ? ` ${opts.extraClass}` : ""}`;
  t.textContent = text;
  t.style.left = `${x}px`;
  t.style.top = `${y}px`;
  // 动画与移除同一个时长参数:keyframes 是百分比的,拉长时长会连带拉长停留段。
  t.style.animationDuration = `${ms}ms`;
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

/** 动作回执:落视口底部中央。比跟随光标那种停久一点(要读一句话,不是瞥一眼)。
 *
 *  停留时长**按字数读秒**(§2.4 `TOAST_SUCCESS`)。340 之前这里写死 2.2s ——
 *  222 那轮给安卓改的读秒,桌面从没跟上;「已移到「家庭」· 撤销」这种长回执和
 *  「已复制」一样两秒就走,读不完。`ms` 仍可显式覆盖(调用方有特殊节奏时用)。 */
export function toastAction(text: string, ms = toastSuccessMs(text)): void {
  flashToast(window.innerWidth / 2, window.innerHeight - 28, text, { ms });
}

/** 错误型回执(§3.1):后端原话要读懂,给满 `TOAST_ERROR_MS`。文案由调用方带「…失败:」
 *  这类前缀 —— 错误不得只靠颜色区分(§2.1)。 */
export function toastError(text: string): void {
  toastAction(text, TOAST_ERROR_MS);
}

// ---- 操作型回执(716,§3.1 第二形)--------------------------------------------------
// 回执文案 + 一枚「撤销」钮:单键 D / T / ] [ / A 与数字色键在**悬停即生效**,此前卡片无声
// 离场,误敲一个字母只能自己去回收站找。全视图**至多一条**:新条来了旧条整个作废(旧钮随
// 节点移除,无需 token —— 与安卓 `ui.ts::actionBar` 同规);点钮 = 撤销并收,点条身 = 只收,
// 没人点 `UNDO_WINDOW_MS` 后自收。⛔ 不做通用撤销栈(profit-readiness §2 那句「最小形」)。
let undoEl: HTMLElement | null = null;
let undoTimer: ReturnType<typeof setTimeout> | undefined;

export function toastUndo(text: string, undoLabel: string, onUndo: () => void): void {
  dismissUndo();
  const box = document.createElement("div");
  box.className = "undo-toast";
  box.setAttribute("role", "status");
  const label = document.createElement("span");
  label.className = "undo-text";
  label.textContent = text;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "undo-btn";
  btn.textContent = undoLabel;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    dismissUndo();
    onUndo();
  });
  box.addEventListener("click", () => dismissUndo());
  box.append(label, btn);
  document.body.append(box);
  undoEl = box;
  undoTimer = setTimeout(dismissUndo, UNDO_WINDOW_MS);
}

/** 收掉在场的撤销回执(视图 unmount 时必调:那枚钮指着的是这棵 mount 的条目)。 */
export function dismissUndo(): void {
  clearTimeout(undoTimer);
  undoTimer = undefined;
  undoEl?.remove();
  undoEl = null;
}

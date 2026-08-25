// UI 共享件(120):$ / esc / 时间格式 / 错误提示条 / stage 词汇——从 main.ts 上抬,
// 供卡片操作面板与回收站/归档册/搜索各面共用(单一真相源,别在模块里各抄一份)。

import { t } from "./i18n";
import { CONFIRM_REVERT_MS, TOAST_ERROR_MS, toastSuccessMs } from "./timing";

export const $ = (id: string) => document.getElementById(id)!;

export const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// ⛔ **stage → 印文的那张表已搬去 `columns.ts`**(B-f 第 1 段):列可由用户增删改名 ⇒
//    它不再是一张能在模块求值期算完的常量表,而是每轮加载登记的库内事实。
//    印文取 `stageLabel(stage)`、任务态判定取 `isTaskStage(stage)`,语义与从前一字不差
//    (灵感态仍答 undefined —— 灵感是纸面的默认态,不盖印)。

/** 时间戳:今天只报时刻,今年带月日,跨年带年。 */
export function fmtWhen(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === now.toDateString()) return hm;
  const md = { m: d.getMonth() + 1, d: d.getDate(), hm };
  return d.getFullYear() === now.getFullYear()
    ? t("ui.whenThisYear", md)
    : t("ui.whenOtherYear", { ...md, y: d.getFullYear() });
}

// ---- 错误/提示条:后端原话,响亮但会自己退场(notice = 非错误的提示) ----------
// 退场时长按「读得完」定,不再一律 6s(221:全部 24 个调用点共用 6s,「已移到「X」」
// 这种六个字的回执也要顶在时间轴上方杵满六秒)。错误=后端原话、要读懂才好处置,
// 保持 6s;notice=回执,按字数给读秒(下限 2.2s 够扫一眼,上限仍 6s 兜住长指引)。
// 另外补一条:点一下就收——此前 6s 内只能干等或等下一条顶掉。

// 340:这四个值原是本文件的内联字面量,已提进 ./timing(§2.4 的代码侧真身),
// 与桌面 src/timing.ts 逐值对齐、由 check-timing-drift 看着。

let errTimer: number | undefined;
let errWired = false;

function hideBar(): void {
  clearTimeout(errTimer);
  $("error").hidden = true;
}

/** 懒接线(模块加载期不碰 DOM):点条身即收,不等读秒走完。 */
function wireBar(el: HTMLElement): void {
  if (errWired) return;
  el.addEventListener("click", hideBar);
  errWired = true;
}

export function showBar(msg: string, notice = false) {
  const el = $("error");
  wireBar(el);
  el.textContent = msg;
  el.classList.toggle("notice", notice);
  el.classList.remove("with-act");
  el.hidden = false;
  clearTimeout(errTimer);
  errTimer = window.setTimeout(() => {
    el.hidden = true;
  }, notice ? toastSuccessMs(msg) : TOAST_ERROR_MS);
}

/** 操作型回执(§3.1):回执文案 + 一枚动作钮(如滑动改状态的「撤销」),notice 形。
 *  点钮=执行并收(冒泡到条身完成收条),点条身=只收;没人点则 CONFIRM_REVERT_MS 后
 *  自动收(动作窗口长度与此前借 confirmBar 的形一致)。新条来了整条重建、旧钮随节点
 *  移除自然作废,无需 token。⛔ 别再拿 confirmBar 当回执用:它左钮恒印「取消」,与
 *  「已改为…」这类既成事实并排,「取消/撤销」读成一对反义词(用户 2026-08-16 实报)。 */
export function actionBar(msg: string, actLabel: string, onAct: () => void): void {
  const el = $("error");
  wireBar(el);
  el.textContent = "";
  const text = document.createElement("span");
  text.textContent = msg;
  const act = document.createElement("button");
  act.className = "bar-act";
  act.textContent = actLabel;
  act.onclick = onAct;
  el.append(text, act);
  el.classList.add("notice", "with-act");
  el.hidden = false;
  clearTimeout(errTimer);
  errTimer = window.setTimeout(() => {
    el.hidden = true;
  }, CONFIRM_REVERT_MS);
}

export const showError = (msg: string) => showBar(msg);

// ---- 底部固定确认条(ui-audit P0 #4):两拍确认的第二拍 --------------------------
// 第一拍只弹这条 fixed 条,原按钮与周围布局零改动——第二拍永远落在几何恒定、
// 远离单拍控件的位置。token 防旧定时器/旧回调作用于新确认;调用方在 onYes 里
// 自行复核状态(session/行还在)再执行,过期即弃。

let cbTimer: number | undefined;
let cbToken = 0;

export function confirmBar(question: string, yesLabel: string, onYes: () => void): void {
  const token = ++cbToken;
  const bar = $("confirmbar");
  $("confirmbar-q").textContent = question;
  const yes = $("confirmbar-yes") as HTMLButtonElement;
  ($("confirmbar-no") as HTMLButtonElement).onclick = () => hideConfirmBar();
  yes.textContent = yesLabel;
  yes.onclick = () => {
    if (token !== cbToken) return; // 已被新确认/收起替代:旧回调作废
    hideConfirmBar();
    onYes();
  };
  bar.hidden = false;
  clearTimeout(cbTimer);
  cbTimer = window.setTimeout(() => {
    if (token === cbToken) hideConfirmBar();
  }, CONFIRM_REVERT_MS); // 没接第二拍自动收;放宽到 6s 的来龙去脉见 timing.ts 那一格
}

export function hideConfirmBar(): void {
  cbToken++;
  clearTimeout(cbTimer);
  $("confirmbar").hidden = true;
}

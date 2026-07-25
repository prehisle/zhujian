// UI 共享件(120):$ / esc / 时间格式 / 错误提示条 / stage 词汇——从 main.ts 上抬,
// 供卡片操作面板与回收站/归档册/搜索各面共用(单一真相源,别在模块里各抄一份)。

export const $ = (id: string) => document.getElementById(id)!;

export const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** stage → 中文印(单一真相源)。灵感态(inbox/filed)不入表:灵感是纸面的默认态,
 *  不盖印;任务行盖 stage 印,done 行另有勾框与淡化背书。 */
export const STAGE_LABEL: Record<string, string> = {
  todo: "待办",
  doing: "进行中",
  confirming: "待确认",
  done: "已完成",
};

/** 任务态判定(与 STAGE_LABEL 同一词汇表)。 */
export const isTaskStage = (stage: string): boolean => STAGE_LABEL[stage] !== undefined;

/** 时间戳:今天只报时刻,今年带月日,跨年带年。 */
export function fmtWhen(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === now.toDateString()) return hm;
  const year = d.getFullYear() === now.getFullYear() ? "" : `${d.getFullYear()}年`;
  return `${year}${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

// ---- 错误/提示条:后端原话,响亮但会自己退场(notice = 非错误的提示) ----------
// 退场时长按「读得完」定,不再一律 6s(221:全部 24 个调用点共用 6s,「已移到「X」」
// 这种六个字的回执也要顶在时间轴上方杵满六秒)。错误=后端原话、要读懂才好处置,
// 保持 6s;notice=回执,按字数给读秒(下限 2.2s 够扫一眼,上限仍 6s 兜住长指引)。
// 另外补一条:点一下就收——此前 6s 内只能干等或等下一条顶掉。

const ERROR_MS = 6000;
/** notice 读秒:基线 1s + 每字 110ms,钳在 [2.2s, 6s]。 */
const noticeMs = (msg: string) => Math.min(ERROR_MS, Math.max(2200, 1000 + msg.length * 110));

let errTimer: number | undefined;
let errWired = false;

function hideBar(): void {
  clearTimeout(errTimer);
  $("error").hidden = true;
}

export function showBar(msg: string, notice = false) {
  const el = $("error");
  if (!errWired) {
    // 懒接线(模块加载期不碰 DOM):点条身即收,不等读秒走完。
    el.addEventListener("click", hideBar);
    errWired = true;
  }
  el.textContent = msg;
  el.classList.toggle("notice", notice);
  el.hidden = false;
  clearTimeout(errTimer);
  errTimer = window.setTimeout(() => {
    el.hidden = true;
  }, notice ? noticeMs(msg) : ERROR_MS);
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
  }, 6000); // 没接第二拍自动收(原 3s 因按钮会跳位而赶;固定条不赶,放宽到 6s)
}

export function hideConfirmBar(): void {
  cbToken++;
  clearTimeout(cbTimer);
  $("confirmbar").hidden = true;
}

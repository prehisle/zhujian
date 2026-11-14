// 界面字号缩放(桌面 232 设置族)——用户在 PC 上看正文吃力时整体放大 / 缩小。
// 走 WebView 原生缩放(`setZoom`,等价浏览器 Ctrl+):整体等比,不碰 CSS 坐标,
// 主窗里的 fixed 弹层 / 悬停菜单全都一致跟随;比缩根字号可靠(本项目布局几乎全 px、
// 缩根字号只动少数 rem 元素)。⚠ Tauri 的缩放是**逐 WebView** 的:看大图那只遮罩窗(606 起是独立的第三只窗)
// 与捕获窗不会自己跟 —— 909 E2 起它们走 zoom-follow.ts(开窗读这一档 + 听这里改档时发的广播)。纯设备本地——localStorage 记忆、重启保留,**不进同步**
// (每台机器屏幕大小 / 视力舒适度各管各的,同过去反而添乱)。
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { emit } from "@tauri-apps/api/event";
import { t } from "./i18n";
import { ZOOM_DEFAULT, ZOOM_EVENT, ZOOM_KEY, ZOOM_MAX, ZOOM_MIN, clampZoom, savedZoom } from "./zoom-follow";
import "./zoom.css";

const MIN = ZOOM_MIN;
const MAX = ZOOM_MAX;
const STEP = 0.1;
const DEFAULT = ZOOM_DEFAULT;
/** 两头的百分比(设置里那一行到头变灰、写「已到最大 / 最小」用,W4 A21)。 */
export const ZOOM_MIN_PERCENT = Math.round(MIN * 100);
export const ZOOM_MAX_PERCENT = Math.round(MAX * 100);

let factor = DEFAULT;
let onChange: ((percent: number) => void) | null = null;

// 字号回执单例:复用一个元素,快速连按只更新文字 + 重置淡出计时,不再每档飘一条
// (每条各停 2.2s + 缩放改视口位置各不同 → 叠成一片拖影,用户实测报的正是这个)。
let badge: HTMLElement | null = null;
let badgeTimer: number | undefined;

function showBadge(text: string): void {
  if (!badge) {
    badge = document.createElement("div");
    badge.className = "zoom-badge";
    document.body.appendChild(badge);
  }
  badge.textContent = text;
  badge.classList.add("show");
  clearTimeout(badgeTimer);
  badgeTimer = window.setTimeout(() => badge?.classList.remove("show"), 1100);
}

function percent(): number {
  return Math.round(factor * 100);
}

// 应用一档:落库 → 通知 WebView → 广播给捕获窗 / 看大图(zoom-follow.ts)→ 回调设置面板刷新标签。`announce` 决定要不要飘回执
// (键盘 / 滚轮 / 设置按钮改字号时飘;启动恢复时不飘)。
async function apply(next: number, announce: boolean): Promise<number> {
  const prev = factor;
  factor = clampZoom(next);
  localStorage.setItem(ZOOM_KEY, String(factor));
  await getCurrentWebview().setZoom(factor);
  void emit(ZOOM_EVENT, factor);
  onChange?.(percent());
  // 到上下限也飘(飘当前值),免得用户以为坏了;单例复用,连按不叠。
  if (announce) {
    const limit = factor === prev ? (factor === MAX ? t("zoom.atMax") : factor === MIN ? t("zoom.atMin") : "") : "";
    showBadge(t("zoom.badge", { percent: percent(), limit }));
  }
  return percent();
}

export function zoomIn(): Promise<number> {
  return apply(factor + STEP, true);
}

export function zoomOut(): Promise<number> {
  return apply(factor - STEP, true);
}

export function zoomReset(): Promise<number> {
  return apply(DEFAULT, true);
}

export function currentZoomPercent(): number {
  return percent();
}

// 设置面板挂在这;面板销毁时传 null 摘掉(避免对已卸载 DOM 的悬空引用)。
export function onZoomChange(cb: ((percent: number) => void) | null): void {
  onChange = cb;
}

// 启动接线:先恢复上次字号(不飘回执),再挂键盘 / 滚轮。放在 notebook boot 里。
export function initZoom(): void {
  void apply(savedZoom(), false);

  // Ctrl +/-/0(含小键盘);用 e.code 认键,不受布局 / shift 影响(= 与 + 同键)。
  document.addEventListener("keydown", (e) => {
    if (!e.ctrlKey || e.altKey || e.metaKey) return;
    switch (e.code) {
      case "Equal":
      case "NumpadAdd":
        e.preventDefault();
        void zoomIn();
        break;
      case "Minus":
      case "NumpadSubtract":
        e.preventDefault();
        void zoomOut();
        break;
      case "Digit0":
      case "Numpad0":
        e.preventDefault();
        void zoomReset();
        break;
    }
  });

  // Ctrl+滚轮:preventDefault 抢在 WebView 内置缩放之前,由我们统一走 setZoom(否则
  // 两套缩放并存、还不落库)。passive:false 才允许 preventDefault。
  document.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      if (e.deltaY < 0) void zoomIn();
      else if (e.deltaY > 0) void zoomOut();
    },
    { passive: false },
  );
}

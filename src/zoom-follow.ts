// 界面字号的「跟随」那一半(909 E2):主窗是改字号的地方(zoom.ts:键盘 / 滚轮 / 设置),捕获窗与看大图那只
// 遮罩窗(lightbox.html)只**跟着**同一档走 —— 此前 setZoom 只作用在主窗那只 WebView 上(Tauri 的缩放是逐 WebView 的),
// 放大到 150% 之后,看大图的关闭钮 / 计数牌、捕获窗的字仍是 100%。
//
// 两条路缺一不可:
//   ① 开窗时读 localStorage 那一档(三只窗同源,同一份存储)—— 新开 / 刚加载的窗一上来就是当前档;
//   ② 改档时走 Tauri 事件广播(同 theme-mode / i18n 的形:storage 事件跨 WebView 不保证送到)—— 已经开着的窗当场跟上。
// ⚠ 只放常量与读档 / 跟随,不 import i18n / CSS:三只窗都装得起。
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";

export const ZOOM_KEY = "zhujian.zoom";
/** 跨窗广播「主窗换了一档」,载荷 = 新的倍数。⛔ 别在别处写字面量。 */
export const ZOOM_EVENT = "zoom-changed";
export const ZOOM_MIN = 0.7;
export const ZOOM_MAX = 2.0;
export const ZOOM_DEFAULT = 1.0;

// 步进落在 0.1 网格上,避免浮点毛刺(1.0 - 0.1 - 0.1… 漂成 0.799999)。
export function clampZoom(f: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(f * 10) / 10));
}

/** 存着的那一档;没存过 = 100%(这是「用户没改过」的那一档,不是兜底:改过就一定写进了这一格)。 */
export function savedZoom(): number {
  const raw = localStorage.getItem(ZOOM_KEY);
  if (raw === null) return ZOOM_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) ? clampZoom(n) : ZOOM_DEFAULT;
}

let followed = ZOOM_DEFAULT;

/** 跟随窗此刻用的那一档(捕获窗量窗用:它的窗口尺寸按 CSS px × 这一档摆)。 */
export function followedZoom(): number {
  return followed;
}

/** 跟随窗(捕获窗 / 看大图)启动时调一次:先套上存着的那一档,再听主窗改档。
 *  `onApplied` = 这一档真落到本窗之后要做的事(捕获窗重新量窗)。 */
export function followZoom(onApplied?: (factor: number) => void): void {
  const apply = async (f: number): Promise<void> => {
    followed = clampZoom(f);
    await getCurrentWebview().setZoom(followed);
    onApplied?.(followed);
  };
  void apply(savedZoom());
  void listen<number>(ZOOM_EVENT, (e) => void apply(e.payload));
}

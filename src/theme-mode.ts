// 明暗三档(250):自动 / 亮 / 暗。「自动」跟系统(手机的日夜定时深色、Windows 的
// 自动深色都走这条),亮 / 暗是用户对系统的覆盖。
//
// 单一真相源在这里:算出「生效色」(light|dark)写进 <html data-theme>,CSS 只认这个
// 属性——theme.css 的暗色令牌块不再自己判 prefers-color-scheme,免得两处判断打架。
// 首帧之前的定色由 index.html / notebook.html 头里那段同规则的内联小脚本负责(晚一帧
// 上色 = 亮暗闪一下,163 闪烁族契约)。
//
// 纯设备本地:localStorage 记忆、**不进同步**。明暗是环境属性不是账户属性(手机夜里要
// 暗、桌面白天要亮),同步过去反而添乱;与界面字号(241)、全局热键(232)同一条规矩。
import { emit, listen } from "@tauri-apps/api/event";

export type ThemeMode = "auto" | "light" | "dark";

const KEY = "zhujian.theme";
/** 跨窗广播:捕获窗与主窗同源但各是各的 WebView,localStorage 的 storage 事件跨
 *  WebView 不保证送到,改档一律走 Tauri 事件确定性地通知对方。 */
const EVENT = "theme-mode-changed";

const media = window.matchMedia("(prefers-color-scheme: dark)");
let mode: ThemeMode = "auto";

function read(): ThemeMode {
  const raw = localStorage.getItem(KEY);
  return raw === "light" || raw === "dark" ? raw : "auto";
}

function paint(): void {
  document.documentElement.dataset.theme =
    mode === "auto" ? (media.matches ? "dark" : "light") : mode;
}

/** 两个窗口各自在启动时调一次。 */
export function initTheme(): void {
  mode = read();
  paint();
  media.addEventListener("change", () => {
    if (mode === "auto") paint(); // 只有「自动」档跟系统;手动选定的亮 / 暗不被系统改
  });
  void listen<ThemeMode>(EVENT, (e) => {
    if (e.payload === mode) return; // 自己发的那一份回声,忽略
    mode = e.payload;
    paint();
  });
}

export function currentThemeMode(): ThemeMode {
  return mode;
}

/** 设置面板改档:记住 → 本窗上色 → 广播给另一窗。 */
export function setThemeMode(next: ThemeMode): void {
  mode = next;
  if (next === "auto") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, next);
  paint();
  void emit(EVENT, next);
}

// 明暗三档(250):自动 / 亮 / 暗。「自动」跟系统——安卓的深色模式常按日夜自动切,
// 手机端最早只有这一档,所以入夜整个 app 自己变暗、用户没得选;亮 / 暗就是那个「我不
// 想跟系统」的出口。
//
// 单一真相源在这里:算出「生效色」(light|dark)写进 <html data-theme>,CSS 只认这个
// 属性——index.html 里的暗色令牌块不再自己判 prefers-color-scheme,免得两处判断打架。
// 首帧之前的定色由 index.html 头里那段同规则的内联小脚本负责(晚一帧上色 = 亮暗闪一下)。
//
// 纯设备本地:localStorage 记忆、**不进同步**。明暗是环境属性不是账户属性(手机夜里要
// 暗、桌面白天要亮),同步过去反而添乱——桌面侧同规矩(src/theme-mode.ts)。
export type ThemeMode = "auto" | "light" | "dark";

const KEY = "zhujian.theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");
let mode: ThemeMode = "auto";

/** 系统状态栏/导航栏的图标颜色是原生的,CSS 管不着——锁「暗」而系统仍是浅色时,系统
 *  会继续把时间/信号画成深色顶在深色纸面上(几乎看不见)。桥在 MainActivity.kt。
 *  桥缺席就是构建出了问题(不是可容忍的降级),验收里直接断言它在。 */
declare global {
  interface Window {
    __zhujianSystemBars?: { setDark(dark: boolean): void };
  }
}

function paint(): void {
  const dark = mode === "auto" ? media.matches : mode === "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  window.__zhujianSystemBars?.setDark(dark);
}

/** 启动时调一次:接上「自动」档对系统的跟随(首帧的定色内联脚本已做)。 */
export function initTheme(): void {
  const raw = localStorage.getItem(KEY);
  mode = raw === "light" || raw === "dark" ? raw : "auto";
  paint();
  media.addEventListener("change", () => {
    if (mode === "auto") paint(); // 手动选定的亮 / 暗不被系统改
  });
}

export function currentThemeMode(): ThemeMode {
  return mode;
}

export function setThemeMode(next: ThemeMode): void {
  mode = next;
  if (next === "auto") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, next);
  paint();
}

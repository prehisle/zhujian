// 界面字号(251):小 / 标准 / 大 / 特大。桌面(241)走 WebView 原生 setZoom,但 wry
// 0.55.1 在安卓的 zoom() 是空实现(src/android/mod.rs:380 参数带下划线、直接 Ok)——
// 调用「成功」屏幕纹丝不动,是最难查的静默失效;CSS zoom 又会改整棵树的 px 坐标系,
// 240 捕获层的键盘抬升、226/227 大图手势的几何计算全得补偿。安卓的平台正道是 WebView
// 自带的 textZoom:只放大文字、布局自然回流,不碰任何坐标数学。
//
// 原生半截在 MainActivity.kt(__zhujianTextSize 窄桥,与 250 的 __zhujianSystemBars
// 同一形制):百分比乘在 WebView 创建时的初始 textZoom 上——初始值已含系统「字体大小」
// 的放大,不覆盖用户的系统级选择。桥缺席就是构建出了问题(不是可容忍的降级),验收里
// 直接断言它在。
//
// 纯设备本地:localStorage 记忆、**不进同步**——字号是屏幕/视力的环境属性不是账户属性,
// 与明暗(250)、桌面字号(241)同一条规矩。首帧之前的应用由 index.html 头里的内联小
// 脚本负责(桥在页面加载前就挂上了),晚一帧放大就是字号跳一下。
const KEY = "zhujian.textsize";
const STEPS = [90, 100, 115, 130] as const;
export type TextSize = (typeof STEPS)[number];

let size: TextSize = 100;

declare global {
  interface Window {
    __zhujianTextSize?: { set(percent: number): void };
  }
}

function apply(): void {
  window.__zhujianTextSize?.set(size);
}

/** 启动时调一次:恢复上次档位(首帧的内联脚本已做,这里兜同一规则,幂等)。 */
export function initTextSize(): void {
  const raw = Number(localStorage.getItem(KEY));
  size = (STEPS as readonly number[]).includes(raw) ? (raw as TextSize) : 100;
  apply();
}

export function currentTextSize(): TextSize {
  return size;
}

export function setTextSize(next: TextSize): void {
  size = next;
  if (next === 100) localStorage.removeItem(KEY); // 标准档不留键,同 theme 的「自动」
  else localStorage.setItem(KEY, String(next));
  apply();
}

// 交互时长常量(340)—— docs/ui-guidelines.md §2.4 那张表的代码侧真身。
//
// # 为什么要有这个文件
//
// §2.4 从 v0.1 起就列着五个常量名,而**代码里一个都不存在**:桌面的成功回执是
// `toastAction(text, ms = 2200)` 的一个默认参数、安卓的读秒是 ui.ts 里的一串内联
// 字面量,两端各写各的、行为还不一样(桌面根本没实现按字数读秒,固定 2.2s)。
// 没有名字的值没人能核 —— 于是 `CONFIRM_REVERT` 在安卓从 3s 放宽到 6s(理由正当,
// 见 android/src/timing.ts 那一格)之后,规范里那一格**没跟着改,也没人发现**。
//
// 颜色轴有三道门禁盯着(令牌定义 / 用法对比度 / 写死的颜色),时长轴一道都没有。
// 这个文件 + `scripts/check-timing-drift.mjs` 补上那道,并且**把 §2.4 那张表本身
// 变成被核对的对象** —— 本轮的根因不是某个值错了,是「文档与代码各说各的、无人对账」。
//
// # 为什么是两份而不是一份
//
// 同 theme.css 那三份令牌表(理由详见 check-theme-drift 文件头):安卓是**独立 vite
// 工程**,要引仓根的模块得动 `server.fs.allow` + rollup 输入 + tauri 打包三处。物理上
// 合不成一份,就各写一份 + 门禁逐值比对。**新增/改动任一个值 = 另一份必须同步改**,
// 否则门禁当场拒。

/** 成功回执的读秒基线:再短的回执也至少让人扫一眼。 */
export const TOAST_SUCCESS_BASE_MS = 1000;
/** 每字加多少毫秒 —— 回执是要读的,长指引不能和「已复制」一样快。 */
export const TOAST_SUCCESS_PER_CHAR_MS = 110;
/** 读秒下限:够扫一眼。 */
export const TOAST_SUCCESS_MIN_MS = 2200;
/** 读秒上限 = 错误条的时长,长指引到此为止。 */
export const TOAST_SUCCESS_MAX_MS = 6000;

/** 错误提示:后端原话要读懂才好处置,给满 6s(且一律可点按提前收,见 §3.1)。 */
export const TOAST_ERROR_MS = 6000;

/** 过滤 / 搜索输入去抖。两端同值。 */
export const INPUT_DEBOUNCE_MS = 150;

/**
 * 成功回执按字数读秒:基线 + 每字,钳在 [下限, 上限]。
 *
 * 221 之前全部 24 个调用点共用 6s,「已移到「X」」这种六个字的回执也要在时间轴上方
 * 杵满六秒;222 改成读秒。**桌面此前没跟上这一改**(固定 2.2s),340 两端对齐。
 */
export function toastSuccessMs(text: string): number {
  const want = TOAST_SUCCESS_BASE_MS + text.length * TOAST_SUCCESS_PER_CHAR_MS;
  return Math.min(TOAST_SUCCESS_MAX_MS, Math.max(TOAST_SUCCESS_MIN_MS, want));
}

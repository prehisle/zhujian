// 交互时长常量(340)—— 安卓那一份。**与桌面 src/timing.ts 逐值对齐**,由
// `scripts/check-timing-drift.mjs` 看着;为什么是两份而不是一份,见桌面那份的文件头。
//
// 只有 `CONFIRM_REVERT_MS` 是安卓独有的(桌面的两拍确认走 armDismiss,靠 Esc / 点别处
// 收起,没有自动复原定时器)—— 门禁的登记表里写明了归谁、为什么。

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
 * 两拍确认没接第二拍时的自动复原。**安卓独有。**
 *
 * 规范 v0.1 写的是 3s,那是「确认态原位换长文案、按钮会跳位」年代的值 —— 几何会变,
 * 就得赶紧复原,免得用户的手指停在一个已经变了意思的位置上。P0 #4 落地固定几何
 * (第一拍只弹底部 fixed 确认条、原按钮与周围布局零改动)之后,**那个前提本身没了**:
 * 条不跳位、也不压着别的单拍控件,不赶。放宽到 6s 与错误条同长 —— 读完一句话再决定。
 *
 * 340 注:代码早就是 6s,规范那一格一直写着 3s。这次以代码为准改文档,并让门禁盯住。
 */
export const CONFIRM_REVERT_MS = 6000;

/**
 * 成功回执按字数读秒:基线 + 每字,钳在 [下限, 上限]。
 * 与桌面 `src/timing.ts::toastSuccessMs` 同一套算法,门禁逐值比对它的四个输入常量。
 */
export function toastSuccessMs(text: string): number {
  const want = TOAST_SUCCESS_BASE_MS + text.length * TOAST_SUCCESS_PER_CHAR_MS;
  return Math.min(TOAST_SUCCESS_MAX_MS, Math.max(TOAST_SUCCESS_MIN_MS, want));
}

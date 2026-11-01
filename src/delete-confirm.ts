// 「删任务前确认」偏好(158 G3 / Q6,WD-18)。此前只在看板删除确认里有一枚「不再提示」,勾了就再也
// 问不回来、设置里也找不到;现在设置 → 通用里有同名开关,两处读写同一个键。
//
// 纯 UI 偏好、存 localStorage(同明暗 / 字号:这台屏幕怎么用),不进库、不同步。键名沿用老的
// `taskArchiveConfirmDismissed`(值 "1" = 不再确认)—— 改名会把用户勾过的那一下作废。
// 读不到 / 读失败 = 照常确认(安全的那一边);写失败不假装写成了,返回 false 由调用方照实说。
const KEY = "ysNotebook.taskArchiveConfirmDismissed";

/** 删任务前要不要先问一句。 */
export function taskDeleteConfirmOn(): boolean {
  try {
    return localStorage.getItem(KEY) !== "1";
  } catch {
    return true;
  }
}

/** 开 / 关。返回是否真写进去了。 */
export function setTaskDeleteConfirm(on: boolean): boolean {
  try {
    if (on) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, "1");
    return true;
  } catch {
    return false;
  }
}

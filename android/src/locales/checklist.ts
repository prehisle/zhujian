// 正文里那枚待办方框(android/src/checklist.ts + main.ts 的卡片渲染)的文案分片。
// 两形:可点的说**动作**(点下去会怎样),只读视图里那枚说**状态**(它现在是什么)。
import { defineMessages } from "./entry";

export const checklist = defineMessages({
  "checklist.check": { zh: "标为已完成", en: "Mark as done" },
  "checklist.uncheck": { zh: "取消完成", en: "Mark as not done" },
  "checklist.checked": { zh: "已完成", en: "Done" },
  "checklist.unchecked": { zh: "未完成", en: "Not done" },
});

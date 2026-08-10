// 小件合收的分片(键前缀 = 来源 ts 文件名,全局唯一、跨分片不许撞):
// api.ts(空间展示名)/ identity.ts(署名)/ images.ts + thumbs.ts(配图)/
// swipe.ts(滑动改状态回执)/ ui.ts(stage 印文 + 时间格式)。
import { defineMessages } from "./entry";

export const misc = defineMessages({
  "api.defaultSpace": { zh: "默认空间", en: "Default space" },
  "api.unnamedSpace": { zh: "未命名空间 · {id}", en: "Unnamed space · {id}" },
  "api.mainSuffix": { zh: "(默认空间)", en: " (default space)" },
  "identity.authorUnknown": { zh: "作者未知", en: "Author unknown" },
  "images.removeThis": { zh: "移除这张图", en: "Remove this image" },
  "images.imageN": { zh: "图{n}", en: "Image {n}" },
  "swipe.changedTo": { zh: "已改为「{stage}」", en: "Moved to “{stage}”" },
  "swipe.undo": { zh: "撤销", en: "Undo" },
  "ui.stageTodo": { zh: "待办", en: "To do" },
  "ui.stageDoing": { zh: "进行中", en: "In progress" },
  "ui.stageConfirming": { zh: "待确认", en: "To confirm" },
  "ui.stageDone": { zh: "已完成", en: "Done" },
  "ui.whenThisYear": { zh: "{m}月{d}日 {hm}", en: "{m}/{d} {hm}" },
  "ui.whenOtherYear": { zh: "{y}年{m}月{d}日 {hm}", en: "{m}/{d}/{y} {hm}" },
});

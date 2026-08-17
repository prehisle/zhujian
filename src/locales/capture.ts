// src/main.ts(捕获窗入口)的文案分片;capture-commands.ts 无用户可见串(命令词是稳定 id,label/hint 由 main.ts 传入)。
import { defineMessages } from "./entry";

export const capture = defineMessages({
  "capture.hotkeyConflict": { zh: "⚠ 快捷键 {keys} 被占用,点此改键", en: "⚠ Shortcut {keys} is taken by another app — click here to change it" },
  "capture.listSep": { zh: "、", en: ", " },
  "capture.gotIt": { zh: "知道了", en: "Got it" },
  "capture.kindTask": { zh: "任务", en: "Task" },
  "capture.kindIdea": { zh: "随记", en: "Note" },
  "capture.chipBackToIdea": { zh: "改回随记", en: "Change back to note" },
  "capture.chipRemoveTag": { zh: "移除标签", en: "Remove tag" },
  "capture.cmdSpaceLabel": { zh: "切换空间", en: "Switch space" },
  "capture.cmdSpaceHint": { zh: "换个本子记", en: "Note in another space" },
  "capture.cmdTaskLabel": { zh: "记为任务", en: "Save as a task" },
  "capture.cmdTaskHint": { zh: "存进看板而非随记", en: "Save to Tasks instead of Notes" },
  "capture.cmdTagLabel": { zh: "打标签", en: "Add a tag" },
  "capture.cmdTagHint": { zh: "/tag 家庭", en: "/tag family" },
  "capture.preview": { zh: "预览", en: "Preview" },
  "capture.tagWarnSuffix": { zh: " 部分标签未挂上({err})", en: " Some tags were not added ({err})" },
  "capture.savedImagesFailed": { zh: "{kind}已保存,但 {failed} 张图未能附加{hint}{tagWarn}", en: "{kind} saved, but {failed} {failed|image|images} failed to attach{hint}{tagWarn}" },
  "capture.savedTagsFailed": { zh: "{kind}已保存,但部分标签未挂上({err})", en: "{kind} saved, but some tags were not added ({err})" },
});

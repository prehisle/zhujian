// 两个窗口壳(notebook.html / index.html)的静态文案:markup 里保留中文原文防首帧闪,
// 启动 applyStaticI18n 覆写;原文与这里 zh 值的逐字相等由 check-i18n-drift 核。
import { defineMessages } from "./entry";

export const shell = defineMessages({
  "shell.collapseSidebarTitle": { zh: "折叠侧栏 (Ctrl+B)", en: "Collapse sidebar (Ctrl+B)" },
  "shell.collapseSidebar": { zh: "折叠侧栏", en: "Collapse sidebar" },
  "shell.switchSpace": { zh: "切换空间", en: "Switch space" },
  "shell.spacesEntry": { zh: "空间…", en: "Spaces…" },
  "shell.personalSpace": { zh: "个人空间", en: "Personal space" },
  "shell.navIdeas": { zh: "随记", en: "Notes" },
  "shell.navTasks": { zh: "任务", en: "Tasks" },
  "shell.navTags": { zh: "标签", en: "Tags" },
  "shell.navSearch": { zh: "搜索", en: "Search" },
  "shell.sync": { zh: "同步", en: "Sync" },
  "shell.settings": { zh: "设置", en: "Settings" },
  "shell.winMin": { zh: "最小化", en: "Minimize" },
  "shell.winMax": { zh: "最大化", en: "Maximize" },
  "shell.winClose": { zh: "关闭", en: "Close" },
  "shell.captureTitle": { zh: "朱简 · 捕获", en: "Zhujian · Capture" },
  // 621:标题句与三段按键说明此前是**同一条 placeholder**(四空格分隔、同色同字号同 italic)
  // ⇒ 屏上读作一句 40 字的灰话,而它是捕获窗**唯一**的功能说明(ui-consistency-plan J)。
  // 拆开之后:placeholder 只留邀请句(与随记页那句逐字相同,zh/en 都是),三段按键各自成键,
  // 由 index.html 的 #cap-keys 带键帽渲染。⚠ en 的「记下」照 §4.2 取 `Note it`(与
  // inbox.composeAdd 同一个词;`Save` 在本仓是**编辑类**动词,cols/common/sync/topics 四处都是它)。
  "shell.capturePlaceholder": { zh: "随手记一笔…", en: "Jot something down…" },
  "shell.capKeyNote": { zh: "记下", en: "Note it" },
  // ⚠ 三段现在各自成一个视觉单元(键帽 + 一句),故 en 各自首字母大写 —— 原先是一句话里的
  // 三个从句(`↵ Save  Esc hide…  / commands`),那时不大写才对。
  "shell.capKeyHide": { zh: "收起(草稿保留)", en: "Hide (draft kept)" },
  "shell.capKeyCmd": { zh: "命令", en: "Commands" },
});

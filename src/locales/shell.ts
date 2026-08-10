// 两个窗口壳(notebook.html / index.html)的静态文案:markup 里保留中文原文防首帧闪,
// 启动 applyStaticI18n 覆写;原文与这里 zh 值的逐字相等由 check-i18n-drift 核。
import { defineMessages } from "./entry";

export const shell = defineMessages({
  "shell.collapseSidebarTitle": { zh: "折叠侧栏 (Ctrl+B)", en: "Collapse sidebar (Ctrl+B)" },
  "shell.collapseSidebar": { zh: "折叠侧栏", en: "Collapse sidebar" },
  "shell.switchSpace": { zh: "切换空间", en: "Switch space" },
  "shell.personalSpace": { zh: "个人空间", en: "Personal space" },
  "shell.navIdeas": { zh: "灵感", en: "Ideas" },
  "shell.navTasks": { zh: "任务", en: "Tasks" },
  "shell.navTags": { zh: "标签", en: "Tags" },
  "shell.navSearch": { zh: "搜索", en: "Search" },
  "shell.sync": { zh: "同步", en: "Sync" },
  "shell.settings": { zh: "设置", en: "Settings" },
  "shell.winMin": { zh: "最小化", en: "Minimize" },
  "shell.winMax": { zh: "最大化", en: "Maximize" },
  "shell.winClose": { zh: "关闭", en: "Close" },
  "shell.captureTitle": { zh: "朱简 · 捕获", en: "Zhujian · Capture" },
  "shell.capturePlaceholder": { zh: "记下这个念头……    ↵ 收存    ⇧↵ 换行    Esc 退出    可粘贴图片    / 唤起命令", en: "Jot down the thought…    ↵ save    ⇧↵ new line    Esc dismiss    paste images    / commands" },
});

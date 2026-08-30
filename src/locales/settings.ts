// src/settings.ts(设置面板)的文案分片。
import { defineMessages } from "./entry";

export const settings = defineMessages({
  "settings.title": { zh: "设置", en: "Settings" },
  // 左栏分类(445)。⭐ **只分 3 类**:我们 4 个小节里有 3 个只有一两行,分细了是另一种难看。
  // 「快捷键」一词两处共用(左栏那枚按钮 + 右栏那一节的标题),刻意同一个键 —— 两处说的
  // 就是同一件事,分成两个键迟早会漂。
  "settings.catGeneral": { zh: "通用", en: "General" },
  "settings.catBackup": { zh: "备份与恢复", en: "Backup & restore" },
  // 标题行的 ✕(2026-08-31 用户点名「只能点面板外关」——Esc 与点外面一直能关,缺的是看得见的入口)。
  "settings.closeTitle": { zh: "关闭", en: "Close" },
  // 「说明 ▸」折叠(2026-08-31 用户拍板「收纳不删」):长段说明默认收起、点开全文。
  "settings.notes": { zh: "说明", en: "Details" },
  "settings.hotkeysTitle": { zh: "快捷键", en: "Shortcuts" },
  "settings.hotkeysIntro": { zh: "全局快捷键——在任何程序里都能唤起朱简。若和别的软件撞了用不了,在这里换一个。", en: "Global shortcuts — summon Zhujian from anywhere. If one clashes with another app, change it here." },
  "settings.captureWin": { zh: "捕获窗", en: "Capture window" },
  "settings.captureWinDesc": { zh: "从任何地方弹出快速记录窗", en: "Pop up the quick capture slip from anywhere" },
  "settings.notebookWin": { zh: "主窗", en: "Main window" },
  "settings.notebookWinDesc": { zh: "从任何地方唤起朱简主窗口", en: "Bring up the Zhujian main window from anywhere" },
  "settings.recordHintMac": { zh: "点「更改」后,按住 Cmd / Ctrl / Option 等修饰键再按一个字母或数字;Esc 取消。", en: "After clicking Change, hold Cmd / Ctrl / Option and press a letter or digit; Esc cancels." },
  "settings.recordHint": { zh: "点「更改」后,按住 Ctrl / Alt / Shift 等修饰键再按一个字母或数字;Esc 取消。", en: "After clicking Change, hold Ctrl / Alt / Shift and press a letter or digit; Esc cancels." },
  "settings.appearance": { zh: "外观", en: "Appearance" },
  "settings.appearanceSub": { zh: "「自动」跟随系统的浅色 / 深色设置;想固定成一种,直接选亮或暗。", en: "Auto follows the system light / dark setting; pick Light or Dark to pin one." },
  "settings.themeName": { zh: "明暗", en: "Theme" },
  "settings.themeAuto": { zh: "自动", en: "Auto" },
  "settings.themeLight": { zh: "亮", en: "Light" },
  "settings.themeDark": { zh: "暗", en: "Dark" },
  "settings.langTitle": { zh: "语言", en: "Language" },
  "settings.langSub": { zh: "界面语言。「自动」跟随系统;改档后窗口会重新加载。", en: "Interface language. Auto follows the system; windows reload after switching." },
  "settings.langAuto": { zh: "自动", en: "Auto" },
  "settings.langZh": { zh: "中文", en: "中文" },
  "settings.langEn": { zh: "English", en: "English" },
  "settings.textSize": { zh: "界面字号", en: "Text size" },
  "settings.textSizeSub": { zh: "整体放大 / 缩小主窗,看着吃力时调大。也可用 Ctrl + / Ctrl - 调节、Ctrl 0 复位。", en: "Scale the main window up / down when text feels small. Ctrl + / Ctrl - also adjust, Ctrl 0 resets." },
  "settings.zoomName": { zh: "字号", en: "Size" },
  "settings.zoomReset": { zh: "复位", en: "Reset" },
  "settings.aliasTitle": { zh: "本机别名", en: "Device alias" },
  "settings.aliasSub": { zh: "给这台设备起个名字(如「书房台式机」)。它会同步给同一账户的其他设备,让他们看到条目是谁记的。留空 = 不起名。", en: "Name this device (e.g. “Study desktop”). The name syncs to the other devices on this account, so they can see which device noted each item. Empty = unnamed." },
  "settings.aliasName": { zh: "名字", en: "Name" },
  "settings.aliasUnnamed": { zh: "未命名", en: "Unnamed" },
  "settings.thisDevice": { zh: "本机 · {id}", en: "This device · {id}" },
  "settings.aliasCleared": { zh: "已清除别名", en: "Alias cleared" },
  "settings.aliasSaved": { zh: "已保存,会同步到其他设备", en: "Saved — will sync to your other devices" },
  "settings.change": { zh: "更改", en: "Change" },
  "settings.pressNewHotkey": { zh: "按下新快捷键…", en: "Press the new shortcut…" },
  "settings.needModifier": { zh: "要按住至少一个修饰键(Ctrl / Alt …)", en: "Hold at least one modifier key (Ctrl / Alt …)" },
  "settings.keyUnsupported": { zh: "这个键不支持,换一个", en: "That key is not supported — try another" },
  "settings.hotkeyUpdated": { zh: "已更新,立即生效", en: "Updated — effective immediately" },
});

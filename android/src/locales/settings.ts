// 设置面里「语言」那一段(358 第②笔)。键名与桌面 src/locales/settings.ts 的语言族
// 同名同义(两端说的是同一件事),但**值刻意可以各说各的**:桌面提的是「窗口会重新
// 加载」,手机是「本页会重新载入」——故不进 CROSS_END_KEYS。
import { defineMessages } from "./entry";

export const settings = defineMessages({
  "settings.langTitle": { zh: "语言", en: "Language" },
  "settings.langSub": { zh: "界面语言。「自动」跟随系统;改档后本页会重新载入。只影响这台设备,不同步到别的设备。", en: "Interface language. Auto follows the system; the page reloads after switching. This device only — it does not sync." },
  "settings.langAuto": { zh: "自动", en: "Auto" },
  "settings.langZh": { zh: "中文", en: "中文" },
  "settings.langEn": { zh: "English", en: "English" },
});

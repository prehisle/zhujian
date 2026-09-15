// 设置面里两段自带前缀的文案:「语言」(358 第②笔)与「意见反馈」(国内上架 17)。
//
// 语言族的键名与桌面 src/locales/settings.ts 同名同义(两端说的是同一件事),但**值刻意
// 可以各说各的**:桌面提的是「窗口会重新加载」,手机是「本页会重新载入」——故不进 CROSS_END_KEYS。
// `feedback.*` 同理:桌面那半键名叫 `settings.feedback*`(它住在通用页的一组里),
// 两端说的是同一件事、措辞按各自承载走,⛔ 也别去 CROSS_END_KEYS 里登记(那张表只列
// 真该逐字相同的筛选 pill,CLAUDE.md 的「门禁停止扩张线」)。
import { defineMessages } from "./entry";

export const settings = defineMessages({
  "settings.langTitle": { zh: "语言", en: "Language" },
  "settings.langSub": { zh: "界面语言。「自动」跟随系统;改档后本页会重新载入。只影响这台设备,不同步到别的设备。", en: "Interface language. Auto follows the system; the page reloads after switching. This device only; it does not sync." },
  "settings.langAuto": { zh: "自动", en: "Auto" },
  "settings.langZh": { zh: "中文", en: "中文" },
  "settings.langEn": { zh: "English", en: "English" },

  // ⚠ 邮箱地址**不在这里** —— 它是 android/index.html 那个 input 的 value(唯一出处),
  // 复制钮读的也是它。地址不是文案,不该随语言变。
  "feedback.title": { zh: "意见反馈", en: "Feedback" },
  "feedback.sub": { zh: "用着有问题、有建议,或者想注销同步账户,发邮件到下面这个地址。作者本人看信。", en: "Found a problem, have a suggestion, or want to close your sync account? Email the address below. The author reads it personally." },
  "feedback.copy": { zh: "复制", en: "Copy" },
  "feedback.copied": { zh: "邮箱地址已复制", en: "Email address copied" },
  "feedback.copyFailed": { zh: "复制失败,请长按选中文字手动复制", en: "Copy failed; long-press to select the text and copy it by hand" },
});

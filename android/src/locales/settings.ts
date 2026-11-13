// 设置面里两段自带前缀的文案:「语言」(358 第②笔)与「意见反馈」(国内上架 17)。
//
// 语言族的键名与桌面 src/locales/settings.ts 同名同义(两端说的是同一件事),但**值刻意
// 可以各说各的**:桌面提的是「窗口会重新加载」,手机是「本页会重新载入」——故不进 CROSS_END_KEYS。
// `feedback.*` 同理:桌面那半键名叫 `settings.feedback*`(它住在通用页的一组里),
// 两端说的是同一件事、措辞按各自承载走,⛔ 也别去 CROSS_END_KEYS 里登记(那张表只列
// 真该逐字相同的筛选 pill,CLAUDE.md 的「门禁停止扩张线」)。
import { defineMessages } from "./entry";

export const settings = defineMessages({
  // 159 / W3 Q7(WM-16 / X-08):设置里那一行「空间…」(开的是同步页那同一页)。
  "settings.spacesTitle": { zh: "空间", en: "Spaces" },
  // 906:设置首页入口行右边那句摘要(index.html `.set-row`,main.ts paintSettingsSummaries)与二级页顶上那枚返回钮的读屏名。
  "settings.back": { zh: "返回设置", en: "Back to Settings" },
  "settings.sumSpaces": { zh: "{n} 个", en: "{n}" },
  "settings.sumRemindOn": { zh: "每天 {time}", en: "Daily at {time}" },
  "settings.sumRemindOff": { zh: "关着", en: "Off" },
  "settings.sumBackupLast": { zh: "上次 {when}", en: "Last {when}" },
  "settings.sumBackupUnset": { zh: "还没设置", en: "Not set up" },
  // 901:设置面长说明的折叠钮(index.html `details.notes`);词与桌面同键同值。
  "settings.notes": { zh: "说明", en: "Details" },
  "settings.langTitle": { zh: "语言", en: "Language" },
  // 901(用户拍板,同桌面「每节只留第一句常显」):这一句常显,其余几句一字不动地住进 settings.langMore(节下那只「说明」折叠)。
  "settings.langSub": { zh: "界面语言。「自动」跟随系统;改档后本页会重新载入。", en: "Interface language. Auto follows the system; the page reloads after switching." },
  "settings.langMore": { zh: "只影响这台设备,不同步到别的设备。", en: "This device only; it does not sync." },
  "settings.compressTitle": { zh: "压缩大图", en: "Compress large images" },
  // 901(用户拍板,同桌面「每节只留第一句常显」):这一句常显,其余几句一字不动地住进 settings.compressMore(节下那只「说明」折叠)。
  "settings.compressSub": { zh: "默认关:按原图保存,截图里的字清清楚楚。", en: "Off by default: images are saved as-is, so text in screenshots stays sharp." },
  "settings.compressMore": { zh: "打开后,加图前会把大照片缩小并转成 JPEG,省同步流量和空间,但画质有损、原图找不回来;长截图不会被压成窄条。已存的图不受影响。只影响这台设备。", en: "When on, large photos are shrunk and re-saved as JPEG when added—less sync traffic and storage, but lossy, and the original can’t be recovered; long screenshots are never squeezed into a thin strip. Images already saved aren’t affected. This device only." },
  "settings.compressOn": { zh: "开", en: "On" },
  "settings.compressOff": { zh: "关", en: "Off" },
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

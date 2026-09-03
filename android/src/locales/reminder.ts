// 截止提醒(用户面 39①)手机那半的文案。键名与桌面 `src/locales/reminder.ts` 同名同义,
// **值刻意可以各说各的**(手机多一句「只数当前空间」、少一枚桌面那种表格行名),
// 故不进 CROSS_END_KEYS —— 同 `settings.lang*` 那一族既有的形。
//
// ⚠ **通知正文不在这里** —— 那句话是 `main.dueSoonLate` / `main.dueSoonToday`
// (任务面那枚汇总钮 558 用的同一把尺),⛔ 别在本分片里再造一句「逾期 M · 今天 N」。
import { defineMessages } from "./entry";

export const reminder = defineMessages({
  "reminder.title": { zh: "截止提醒", en: "Due reminder" },
  "reminder.sub": { zh: "朱简开着的时候,每天到点用一条系统通知报今天到期与已逾期的任务数;应用没开不会响。只数当前空间。开关与时刻只属于这台手机,不同步到别的设备。", en: "While Zhujian is open, one system notification a day reports how many tasks are due today or overdue; nothing fires when the app is closed. Counts the current space only. The switch and time are per-device and never synced." },
  "reminder.on": { zh: "开", en: "On" },
  "reminder.off": { zh: "关", en: "Off" },
  "reminder.everyDay": { zh: "每天", en: "Daily at" },
  "reminder.test": { zh: "试一条", en: "Send test" },
  "reminder.testSent": { zh: "已发送,请下拉看通知栏", en: "Sent — pull down to check your notifications" },
  "reminder.testEmpty": { zh: "目前没有今天到期或已逾期的任务", en: "No tasks due today or overdue right now" },
  "reminder.saved": { zh: "已保存,每天 {time} 报一次", en: "Saved — daily at {time}" },
  "reminder.notifTitle": { zh: "截止提醒", en: "Due reminder" },
  "reminder.spaceLine": { zh: "「{name}」{sum}", en: "{name}: {sum}" },
  "reminder.permDenied": { zh: "系统没允许朱简发通知:去手机「设置 → 应用 → 朱简 → 通知」里打开", en: "Notifications are not allowed — turn them on in Settings › Apps › Zhujian › Notifications" },
});

// 截止提醒(用户面 39 第一版)的文案分片:设置面「截止提醒」一节 + 系统通知正文。
// 通知正文必须走字典 —— 它是用户可见文字,而 Rust 侧诊断串拍板不翻,所以调度与
// 文案都住前端(src/reminder.ts)。「逾期 M · 今天 N」那句复用 board.dueSoonLate /
// board.dueSoonToday(与看板顶栏汇总钮同一把尺,见 tasktime.dueSummaryLabel)。
import { defineMessages } from "./entry";

export const reminder = defineMessages({
  "reminder.title": { zh: "截止提醒", en: "Due reminder" },
  "reminder.sub": { zh: "应用开着时,每天到点用一条系统通知报今天到期与已逾期的任务数;应用没开不会响。开关与时刻只属于这台设备,不同步。", en: "While the app is running, one system notification a day reports how many tasks are due today or overdue; nothing fires when the app is closed. The switch and time are per-device and never synced." },
  "reminder.rowName": { zh: "每日提醒", en: "Daily reminder" },
  "reminder.on": { zh: "开", en: "On" },
  "reminder.off": { zh: "关", en: "Off" },
  "reminder.test": { zh: "试一条", en: "Send test" },
  "reminder.testSent": { zh: "已发送,请看系统通知", en: "Sent — check your system notifications" },
  "reminder.testEmpty": { zh: "目前没有今天到期或已逾期的任务", en: "No tasks due today or overdue right now" },
  "reminder.saved": { zh: "已保存,每天 {time} 报一次", en: "Saved — daily at {time}" },
  "reminder.notifTitle": { zh: "截止提醒", en: "Due reminder" },
  "reminder.spaceLine": { zh: "「{name}」{sum}", en: "{name}: {sum}" },
  "reminder.permDenied": { zh: "系统未授权通知:请在系统设置里允许朱简发通知", en: "Notifications not permitted — allow Zhujian notifications in system settings" },
});

// 截止提醒(用户面 39 第一版)的文案分片:设置面「截止提醒」一节 + 系统通知正文。
// 通知正文必须走字典 —— 它是用户可见文字,而 Rust 侧诊断串拍板不翻,所以调度与
// 文案都住前端(src/reminder.ts)。「逾期 M · 今天 N」那句复用 board.dueSoonLate /
// board.dueSoonToday(与看板顶栏汇总钮同一把尺;158 G3 / Q10 起整句同钮,见 tasktime.dueSummaryFullLabel)。
import { defineMessages } from "./entry";

export const reminder = defineMessages({
  "reminder.title": { zh: "截止提醒", en: "Due reminder" },
  // 158 G3 / Q10:通知与看板顶栏那枚到期钮说同一句(带「3 天内」);电脑上点通知不会跳转,照实说。
  "reminder.sub": { zh: "应用开着时,每天到点用一条系统通知报逾期、今天到期与 {days} 天内到期的任务数,和看板顶栏那枚到期钮说的一样;只在有逾期或今天到期时才响,每天至多一条,应用没开不会响。电脑上点通知不会跳转,打开看板点那枚到期钮就只剩这些。开关与时刻只属于这台设备,不同步。", en: "While the app is running, one system notification a day reports tasks overdue, due today, and due within {days}d — the same line as the due button on the board. It only fires when something is overdue or due today, at most once a day, and never when the app is closed. On a computer, clicking the notification doesn’t jump anywhere; open the board and click that due button to see just those tasks. The switch and time are per-device and never synced." },
  "reminder.on": { zh: "开", en: "On" },
  "reminder.off": { zh: "关", en: "Off" },
  "reminder.test": { zh: "试一条", en: "Send test" },
  "reminder.testSent": { zh: "已发送,请看系统通知", en: "Sent, check your system notifications" },
  "reminder.testEmpty": { zh: "目前没有今天到期或已逾期的任务", en: "No tasks due today or overdue right now" },
  "reminder.saved": { zh: "已保存,每天 {time} 报一次", en: "Saved, daily at {time}" },
  "reminder.notifTitle": { zh: "截止提醒", en: "Due reminder" },
  "reminder.spaceLine": { zh: "「{name}」{sum}", en: "{name}: {sum}" },
  "reminder.permDenied": { zh: "系统未授权通知:请在系统设置里允许朱简发通知", en: "Notifications not permitted. Allow Zhujian notifications in system settings" },
});

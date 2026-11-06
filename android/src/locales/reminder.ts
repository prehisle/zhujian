// 截止提醒(用户面 39①)手机那半的文案。键名与桌面 `src/locales/reminder.ts` 同名同义,
// **值刻意可以各说各的**(手机多一句「只数当前空间」、少一枚桌面那种表格行名),
// 故不进 CROSS_END_KEYS —— 同 `settings.lang*` 那一族既有的形。
//
// ⚠ **通知正文不在这里** —— 那句话是 `main.dueSoonLate` / `main.dueSoonToday`
// (任务面那枚汇总钮 558 用的同一把尺),⛔ 别在本分片里再造一句「逾期 M · 今天 N」。
import { defineMessages } from "./entry";

export const reminder = defineMessages({
  "reminder.title": { zh: "截止提醒", en: "Due reminder" },
  // 161 / W4 Q9(WM-37 / X-11):①「不开着不响」挪到第一句,并照这一端的实际写:V1986A 真机量过 —— 进程活着、只是切到后台,
  //   过了钟点 4 分钟一条都没有(WebView 的定时拍在后台不走,CDP 都连不进页面);一回到前台 40 秒内补报了那一条。
  //   ②范围照指南与电脑统一成「逾期、今天到期与 {days} 天内到期」——通知那句 158 起本来就带「{days} 天内 K」(main.ts::dueDigest),
  //   是这段说明落下了;响不响仍只看逾期 + 今天。{days} 由 main.ts 的 DUE_SOON_DAYS 注入(⛔ 别写死)。
  "reminder.sub": { zh: "只有朱简开在屏幕上时才会响:切到别的应用、锁了屏、或者被关掉,到点都不会响(回到朱简时今天还没报过,就补报一次)。每天到点用一条系统通知报逾期、今天到期与 {days} 天内到期的任务数,和任务页上那枚到期钮说的一样;只在有逾期或今天到期时才响,每天至多一条。只数当前空间。开关与时刻只属于这台手机,不同步到别的设备。", en: "It only fires while Zhujian is on screen: if you switch to another app, lock the phone, or close Zhujian, nothing fires at that time (when you come back and today's has not gone out yet, it reports once). At the set time each day, one system notification reports tasks overdue, due today, and due within {days}d, the same line as the due button on the Tasks page. It only fires when something is overdue or due today, at most once a day. Counts the current space only. The switch and time are per-device and never synced." },
  "reminder.on": { zh: "开", en: "On" },
  "reminder.off": { zh: "关", en: "Off" },
  "reminder.everyDay": { zh: "每天", en: "Daily at" },
  "reminder.test": { zh: "试一条", en: "Send test" },
  "reminder.testSent": { zh: "已发送,请下拉看通知栏", en: "Sent, pull down to check your notifications" },
  "reminder.testEmpty": { zh: "目前没有今天到期或已逾期的任务", en: "No tasks due today or overdue right now" },
  "reminder.saved": { zh: "已保存,每天 {time} 报一次", en: "Saved, daily at {time}" },
  "reminder.notifTitle": { zh: "截止提醒", en: "Due reminder" },
  "reminder.spaceLine": { zh: "「{name}」{sum}", en: "{name}: {sum}" },
  "reminder.permDenied": { zh: "系统没允许朱简发通知:去手机「设置 → 应用 → 朱简 → 通知」里打开", en: "Notifications are not allowed. Turn them on in Settings › Apps › Zhujian › Notifications" },
});

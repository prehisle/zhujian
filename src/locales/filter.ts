// 筛选条(filter-bar.ts)的文案分片。⚠ **键名与安卓侧 android/src/locales/filter.ts
// 逐键相同、值逐字相同**——check-filter-parity 把两端的筛选函数体切进 data: 模块、
// 按各自的真字典给 t(),期望表钉着中文 pill 标签;两份字典对同一枚 pill 说不同的话,
// 那道闸当场红。哪些键须两端相同由 check-i18n-drift 的 CROSS_END_KEYS 恰等登记。
import { defineMessages } from "./entry";

export const filter = defineMessages({
  "filter.all": { zh: "所有", en: "All" },
  "filter.none": { zh: "无标签", en: "Untagged" },
  "filter.thatTag": { zh: "该标签", en: "that tag" },
  "filter.kindAxis": { zh: "类型", en: "Kind" },
  "filter.allKinds": { zh: "全部类型", en: "All kinds" },
  "filter.pillTitle": { zh: "单击只筛此标签 · 按住 Ctrl 多选", en: "Click to filter by this tag only · Ctrl-click to multi-select" },
  // 49:pill 行尾那枚说明位的两态(桌面独有——安卓点按即切换,天然多选、无此手势)。
  // ⚠ 只写 Ctrl 不写 ⌘,与上面 pillTitle 同口径(mac 桌面未正式对外发)。
  "filter.multiHint": { zh: "按住 Ctrl 点另一枚可多选", en: "Ctrl-click another tag to add it" },
  "filter.unionHint": { zh: "{n} 个标签 · 挂任一个都算", en: "{n} tags · any one counts" },
  "filter.collapseKids": { zh: "收起子标签", en: "Hide child tags" },
  "filter.expandKids": { zh: "展开 {n} 个子标签", en: "Show {n} child {n|tag|tags}" },
  // 时间轴(461):按创建时间三档互斥分区 + 「所有」重置(复用 filter.all)。仅桌面接线,
  // 未进 CROSS_END_KEYS——安卓这条轴还没做,补齐时再登记。
  "filter.timeAxis": { zh: "时间", en: "Time" },
  "filter.time1d": { zh: "近1天", en: "Last 1 day" },
  "filter.time7d": { zh: "近7天", en: "Last 7 days" },
  "filter.timeOld": { zh: "7天前", en: "7+ days ago" },
});

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
  "filter.collapseKids": { zh: "收起子标签", en: "Hide child tags" },
  "filter.expandKids": { zh: "展开 {n} 个子标签", en: "Show {n} child {n|tag|tags}" },
});

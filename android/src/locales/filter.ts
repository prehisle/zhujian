// 筛选条(android/src/filter.ts)的文案分片。⚠ **键名与桌面 src/locales/filter.ts
// 逐键相同、值逐字相同**——check-filter-parity 把两端的筛选函数体切进 data: 模块、
// 按各自的真字典给 t(),期望表钉着中文 pill 标签;两份字典对同一枚 pill 说不同的话,
// 那道闸当场红。哪些键须两端相同由 check-i18n-drift 的 CROSS_END_KEYS 恰等登记
// (桌面另有三枚 hover 提示键,触屏没有 hover,不在共有集里)。
import { defineMessages } from "./entry";

export const filter = defineMessages({
  "filter.all": { zh: "所有", en: "All" },
  "filter.none": { zh: "无标签", en: "Untagged" },
  "filter.thatTag": { zh: "该标签", en: "that tag" },
  "filter.kindAxis": { zh: "类型", en: "Kind" },
  // 635(ui-consistency-plan M7):标签轴此前是三条轴里唯一没有轴名的一条(桌面 623 已补,
  // 手机端当时没跟)。⇒ 桌面那条「安卓补上再登记」的注释同轮兑现,已进 CROSS_END_KEYS。
  "filter.topicAxis": { zh: "标签", en: "Tags" },
  // 159 / W3 Q8(WM-26):筛着时筛选条底下写条数(值与桌面 src/locales/filter.ts 同键逐字相同)。
  "filter.count": { zh: "筛出 {n} 条", en: "{n} {n|match|matches}" },
  // 906:标签行收起态那枚钮「更多 N ▾」/ 摊开态「收起 ▴」(main.ts syncTagsToggle;键与值同桌面 src/locales/filter.ts 逐字)。
  "filter.more": { zh: "更多 {n}", en: "{n} more" },
  "filter.less": { zh: "收起", en: "Show less" },
  "filter.allKinds": { zh: "全部类型", en: "All kinds" },
});

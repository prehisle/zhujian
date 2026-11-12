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
  // 623(用户面 74 / F):标签轴此前是三条轴里唯一没有轴名的一条,pill 左缘比另两行短一个
  // 轴名的宽度。⚠ 635 起**两端都有了**(手机端 M7),已按那条注释说的进 CROSS_END_KEYS
  // 恰等登记 ⇒ 改这枚的值就得两端一起改,否则 check-i18n-drift 当场红。
  // W3 159 / Q8(WD-20):筛着时过滤框旁写条数(同搜索页「N 条匹配」)。
  "filter.count": { zh: "筛出 {n} 条", en: "{n} {n|match|matches}" },
  "filter.topicAxis": { zh: "标签", en: "Tags" },
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
  // 157 G3(WD-19):筛空空态补的那一句(filter-bar.ts::otherLayersNote)。
  "filter.alsoActive": { zh: "还同时筛着:{layers}。", en: "Also filtering by {layers}. " },
  "filter.layerTags": { zh: "标签「{labels}」", en: "tag “{labels}”" },
  "filter.layerKind": { zh: "类型「{kind}」", en: "kind “{kind}”" },
  "filter.layerTime": { zh: "时间「{time}」", en: "time “{time}”" },
  "filter.layerSep": { zh: "、", en: ", " },
  "filter.timeAxis": { zh: "时间", en: "Time" },
  // 898 D3:同一条轴在看板页上的名字(页头那排到期汇总也有个「今天」,这条按的是创建时间)。
  "filter.createdAxis": { zh: "记于", en: "Created" },
  "filter.layerCreated": { zh: "记于「{time}」", en: "created “{time}”" },
  // 157 G3(WD-11):三档是互斥分段,名字也得读成分段 —— 「近1天 / 近7天」读着像后者包含前者。
  "filter.time1d": { zh: "今天", en: "Today" },
  "filter.time7d": { zh: "昨天至6天前", en: "Yesterday–6 days ago" },
  "filter.timeOld": { zh: "更早", en: "Older" },
});

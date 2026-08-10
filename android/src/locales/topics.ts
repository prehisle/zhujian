// android/src/topics.ts(标签面:排序拖手柄 + 类型编辑)的文案分片。
import { defineMessages } from "./entry";

export const topics = defineMessages({
  "topics.loading": { zh: "读取中…", en: "Loading…" },
  "topics.loadFailed": { zh: "标签读取失败:{error}", en: "Could not load tags: {error}" },
  "topics.empty": { zh: "还没有标签——在卡片上打标签,标签就会出现在这里。", en: "No tags yet — tag an item on its card and the tag shows up here." },
  "topics.kindPh": { zh: "类型(如 人名)", en: "Kind (e.g. Person)" },
  "topics.kindSave": { zh: "存", en: "Save" },
  "topics.kindClear": { zh: "清", en: "Clear" },
  "topics.kindAdd": { zh: "+ 类型", en: "+ Kind" },
  "topics.dragHint": { zh: "拖动排序", en: "Drag to reorder" },
  "topics.count": { zh: "{n} 项", en: "{n} {n|item|items}" },
  "topics.kindSet": { zh: "已设类型", en: "Kind set" },
  "topics.kindCleared": { zh: "已清类型", en: "Kind cleared" },
});

// android/src/topics.ts(标签面:排序拖手柄 + 类型编辑 + 改名 + 颜色 + 新建)的文案分片。
import { defineMessages } from "./entry";

export const topics = defineMessages({
  "topics.loading": { zh: "读取中…", en: "Loading…" },
  "topics.loadFailed": { zh: "标签读取失败:{error}", en: "Could not load tags: {error}" },
  "topics.empty": { zh: "还没有标签——点上方「+ 新建标签」直接建一个,或在卡片上打标签。", en: "No tags yet — tap “+ New tag” above to create one, or tag an item on its card." },
  "topics.kindPh": { zh: "类型(如 人名)", en: "Kind (e.g. Person)" },
  "topics.kindSave": { zh: "存", en: "Save" },
  "topics.kindClear": { zh: "清", en: "Clear" },
  "topics.kindAdd": { zh: "+ 类型", en: "+ Kind" },
  "topics.dragHint": { zh: "拖动排序", en: "Drag to reorder" },
  "topics.count": { zh: "{n} 项", en: "{n} {n|item|items}" },
  "topics.kindSet": { zh: "已设类型", en: "Kind set" },
  "topics.kindCleared": { zh: "已清类型", en: "Kind cleared" },
  // 改名(514):点名字进编辑态。⛔ 键空间与桌面独立(两份字典),别去和 src/locales 对齐。
  "topics.renameHint": { zh: "点一下改名", en: "Tap to rename" },
  "topics.renamePh": { zh: "标签名", en: "Tag name" },
  "topics.renameSave": { zh: "存", en: "Save" },
  "topics.renameCancel": { zh: "取消", en: "Cancel" },
  "topics.renamed": { zh: "已改名", en: "Renamed" },
  // 颜色(user-44 第二刀):点行内色点开调色板,点色块即写。
  "topics.colorHint": { zh: "改颜色", en: "Change color" },
  "topics.colorNone": { zh: "无", en: "None" },
  "topics.colorCancel": { zh: "取消", en: "Cancel" },
  "topics.colorSet": { zh: "已改颜色", en: "Color set" },
  "topics.colorCleared": { zh: "已清颜色", en: "Color cleared" },
  // 新建标签(user-44 第二刀):面头按钮开一行输入框,与改名行同形。
  "topics.newBtn": { zh: "+ 新建标签", en: "+ New tag" },
  "topics.newPh": { zh: "标签名", en: "Tag name" },
  "topics.newSave": { zh: "建", en: "Create" },
  "topics.newCancel": { zh: "取消", en: "Cancel" },
  "topics.created": { zh: "已建标签", en: "Tag created" },
});

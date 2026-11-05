// 跨视图通用文案。⚠ 清扫 agent 不动这份(避免并行冲突):各文件的文案进各自分片,
// 值重复无妨、键不许撞。
import { defineMessages } from "./entry";

export const common = defineMessages({
  "common.appName": { zh: "朱简", en: "Zhujian" },
  "common.save": { zh: "保存", en: "Save" },
  "common.loading": { zh: "读取中…", en: "Loading…" },
  "common.undo": { zh: "撤销", en: "Undo" },
  "common.undoFailed": { zh: "撤销失败:{err}", en: "Undo failed: {err}" },
  // 错误文案人话前置(C8,src/err.ts):认得出的几类换一句人话,原话跟在括号里;认不出的加前缀。
  "err.raw": { zh: "(原文:{raw})", en: " (details: {raw})" },
  "err.unknown": { zh: "出错:{raw}", en: "Error: {raw}" },
  "err.net": { zh: "没连上服务器,或者连接中途断了。", en: "Couldn't reach the server, or the connection dropped." },
  "err.revoked": { zh: "同步服务器不认这台设备了(可能已被移出账户,或账户被停用)。", en: "The sync server no longer accepts this device (it may have been removed from the account, or the account suspended)." },
  "err.conflict": { zh: "这次改动和已有的数据对不上,没有存。", en: "This change conflicts with existing data and wasn't saved." },
  "err.gone": { zh: "要改的那一条已经不在了(可能在另一台设备上删掉或移走了)。", en: "That entry is no longer there (it may have been deleted or moved on another device)." },
  "err.probeNext": { zh: "网络自检", en: "Network check" },
  // 两个回收站共用的话(W3 159:A7 / A9 / A19 —— 清空确认长成一个样、彻底删除写明无法恢复与连带、做完都说一声)。
  "trash.emptyTrash": { zh: "清空回收站", en: "Empty trash" },
  "trash.cancel": { zh: "取消", en: "Cancel" },
  "trash.purgeAllYes": { zh: "彻底删除全部", en: "Delete all forever" },
  "trash.purgeAllQ": { zh: "彻底删除回收站里全部 {n} 条?无法恢复。", en: "Delete all {n} {n|item|items} in the trash forever? This cannot be undone." },
  "trash.purgeAllMixedQ": { zh: "彻底删除回收站里全部 {n} 条和 {m} 张配图?无法恢复。", en: "Delete all {n} {n|item|items} and {m} {m|image|images} in the trash forever? This cannot be undone." },
  "trash.purgeAllImagesQ": { zh: "彻底删除回收站里全部 {m} 张配图?无法恢复。", en: "Delete all {m} {m|image|images} in the trash forever? This cannot be undone." },
  "trash.emptied": { zh: "回收站已清空", en: "Trash emptied" },
  "trash.purgeOneQ": { zh: "彻底删除这条?无法恢复", en: "Delete this forever? This cannot be undone" },
  "trash.purgeOneImagesQ": { zh: "彻底删除这条和它的 {m} 张配图?无法恢复", en: "Delete this and its {m} {m|image|images} forever? This cannot be undone" },
  "trash.purged": { zh: "已彻底删除", en: "Deleted forever" },
  "trash.restoredNote": { zh: "已还原到随记", en: "Restored to Notes" },
  "trash.restoredDoc": { zh: "已还原到「长文」", en: "Restored to Long-form" },
  "trash.restoredTask": { zh: "已还原到看板「{col}」列", en: "Restored to the “{col}” column" },
  "trash.restoredBoard": { zh: "已还原到看板", en: "Restored to the board" },
  // W3 159 / WD-37:两个回收站的卡写删除时刻(照手机「删于 …」)。
  "trash.deletedAt": { zh: "删于 {when}", en: "Deleted {when}" },
});

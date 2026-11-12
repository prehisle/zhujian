// 分片:item-comments.ts(comments.*)与 search.ts(search.*)的文案;键前缀 =
// 来源 ts 文件名(全局唯一,跨分片不许撞)。
import { defineMessages } from "./entry";

export const comments = defineMessages({
  "comments.badge": { zh: "💬 {n}", en: "💬 {n}" },
  "comments.badgeTitle": { zh: "看留言", en: "View comments" },
  "comments.badgeTitleUnread": { zh: "有新留言", en: "New comments" },
  "comments.title": { zh: "留言", en: "Comments" },
  "comments.closeTitle": { zh: "关闭(Esc)", en: "Close (Esc)" },
  "comments.loadMore": { zh: "加载更多", en: "Load more" },
  "comments.inputPlaceholder": { zh: "写句话…", en: "Say something…" },
  "comments.send": { zh: "记下", en: "Send" },
  // 157 G4 / P4:留言不进回收站,钮上就叫「销毁」(键名照旧,命名铁律)。
  "comments.delete": { zh: "销毁", en: "Destroy" },
  "comments.deleteTitle": { zh: "销毁这条留言", en: "Delete this comment forever" },
  "comments.confirmDestroy": { zh: "销毁?不进回收站", en: "Delete forever? It skips the trash" },
  "comments.destroy": { zh: "销毁", en: "Delete forever" },
  "comments.cancel": { zh: "取消", en: "Cancel" },
  "comments.empty": { zh: "还没有留言。", en: "No comments yet." },
  "search.title": { zh: "搜索", en: "Search" },
  "search.inputPlaceholder": { zh: "搜索内容,多个词用空格隔开……", en: "Search… separate words with spaces" },
  "search.clear": { zh: "清空", en: "Clear" },
  "search.statusIdeas": { zh: "随记", en: "Notes" },
  "search.statusTrash": { zh: "回收站", en: "Trash" },
  "search.statusTask": { zh: "卡片", en: "Cards" },
  "search.statusSealed": { zh: "归档", en: "Archive" },
  "search.statusDoc": { zh: "长文", en: "Long-form" },
  // W3 159 / Q12(WD-31):回收站里的命中说清原来是什么。
  "search.statusTrashKind": { zh: "回收站 · {kind}", en: "Trash · {kind}" },
  // W3 159 / A4(WD-02):只在改过的旧版本里命中 —— 结果卡上一枚、落点卡上一句。
  "search.oldVersionHit": { zh: "命中改过的旧版本", en: "Matched an earlier version" },
  "search.landedOld": { zh: "搜到的词在这条改过之前的版本里 —— ⋯ 菜单的「历史」里看得到。", en: "The words you searched for are in an earlier version of this one — see “History” in the ⋯ menu." },
  "search.landedOldTrash": { zh: "搜到的词在这条改过之前的版本里 —— 还原后在 ⋯ 菜单的「历史」里看得到。", en: "The words you searched for are in an earlier version of this one — restore it, then see “History” in the ⋯ menu." },
  "search.failed": { zh: "搜索失败", en: "Search failed" },
  "search.idleTitle": { zh: "在当前空间的所有条目里查找", en: "Search everything in this space" },
  "search.idleHint": { zh: "随记、长文、卡片、归档、回收站和改过的旧版本都一起搜。", en: "Notes, long-form, cards, the archive, the trash and past versions are all searched." },
  "search.noMatch": { zh: "没有匹配的条目", en: "No matches" },
  "search.noMatchDetail": { zh: "当前空间里没有内容匹配「{q}」。", en: "Nothing in this space matches “{q}”." },
  "search.matchCount": { zh: "{n} 条匹配", en: "{n} {n|match|matches}" },
});

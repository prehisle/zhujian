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
  "comments.send": { zh: "写下", en: "Send" },
  "comments.delete": { zh: "删除", en: "Delete" },
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
  "search.statusTask": { zh: "任务", en: "Tasks" },
  "search.statusSealed": { zh: "归档", en: "Archive" },
  "search.failed": { zh: "搜索失败", en: "Search failed" },
  "search.idleTitle": { zh: "在当前空间的所有条目里查找", en: "Search everything in this space" },
  "search.idleHint": { zh: "随记、任务、归档、回收站和改过的旧版本都一起搜。", en: "Notes, tasks, the archive, the trash and past versions are all searched." },
  "search.noMatch": { zh: "没有匹配的条目", en: "No matches" },
  "search.noMatchDetail": { zh: "当前空间里没有内容匹配「{q}」。", en: "Nothing in this space matches “{q}”." },
  "search.matchCount": { zh: "{n} 条匹配", en: "{n} {n|match|matches}" },
});

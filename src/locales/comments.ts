// 分片:item-comments.ts(comments.*)与 search.ts(search.*)的文案;键前缀 =
// 来源 ts 文件名(全局唯一,跨分片不许撞)。
import { defineMessages } from "./entry";

export const comments = defineMessages({
  "comments.badge": { zh: "💬 {n}", en: "💬 {n}" },
  "comments.badgeTitle": { zh: "看留言", en: "View comments" },
  "comments.title": { zh: "留言", en: "Comments" },
  "comments.closeTitle": { zh: "关闭(Esc)", en: "Close (Esc)" },
  "comments.loadMore": { zh: "加载更多", en: "Load more" },
  "comments.inputPlaceholder": { zh: "写句话…(Enter 发出,Shift+Enter 换行)", en: "Say something… (Enter to send, Shift+Enter for a new line)" },
  "comments.send": { zh: "写下", en: "Send" },
  "comments.delete": { zh: "删除", en: "Delete" },
  "comments.deleteTitle": { zh: "销毁这条留言", en: "Delete this comment forever" },
  "comments.confirmDestroy": { zh: "销毁?不进回收站", en: "Delete forever? It skips the trash" },
  "comments.destroy": { zh: "销毁", en: "Delete forever" },
  "comments.cancel": { zh: "取消", en: "Cancel" },
  "comments.empty": { zh: "还没有留言。", en: "No comments yet." },
  "search.title": { zh: "搜索", en: "Search" },
  "search.inputPlaceholder": { zh: "搜索灵感的内容……", en: "Search your ideas…" },
  "search.clear": { zh: "清空", en: "Clear" },
  "search.statusIdeas": { zh: "灵感", en: "Ideas" },
  "search.statusTrash": { zh: "回收站", en: "Trash" },
  "search.statusTask": { zh: "任务", en: "Tasks" },
  "search.statusSealed": { zh: "归档", en: "Archive" },
  "search.failed": { zh: "搜索失败", en: "Search failed" },
  "search.idleTitle": { zh: "在所有条目里查找", en: "Search all your items" },
  "search.idleHint": { zh: "输入关键词,跨灵感 / 任务 / 回收站搜索内容,连改过的旧版本一起找。", en: "Type a keyword to search across ideas, tasks and trash — past versions included." },
  "search.noMatch": { zh: "没有匹配的灵感", en: "No matching ideas" },
  "search.noMatchDetail": { zh: "没有灵感的内容包含「{q}」。", en: "No idea contains “{q}”." },
  "search.matchCount": { zh: "{n} 条匹配", en: "{n} {n|match|matches}" },
});

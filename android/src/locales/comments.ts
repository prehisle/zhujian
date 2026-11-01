// android/src/comments.ts(条目留言:卡上徽章 + 屏底留言层)的文案分片。
import { defineMessages } from "./entry";

export const comments = defineMessages({
  "comments.badgeAria": { zh: "看留言", en: "View comments" },
  "comments.badgeAriaUnread": { zh: "有新留言", en: "New comments" },
  "comments.loading": { zh: "读取中…", en: "Loading…" },
  // 157 G4 / P4:留言不进回收站,那一下是永久的 ⇒ 钮上就叫「销毁」(此前钮叫「删除」、确认钮才叫「销毁」)。
  "comments.destroy": { zh: "销毁", en: "Destroy" },
  "comments.moreAria": { zh: "这条留言的更多操作", en: "More for this comment" },
  "comments.empty": { zh: "还没有留言。", en: "No comments yet." },
  "comments.loadFailed": { zh: "留言读取失败", en: "Could not load comments" },
  "comments.destroyQ": { zh: "销毁这条留言?不进回收站、无法找回", en: "Destroy this comment? It does not go to Trash and cannot be recovered" },
  "comments.destroyYes": { zh: "销毁", en: "Destroy" },
  "comments.hostGone": { zh: "这条记录已不在,留言面已收起", en: "That item is gone, the comments sheet was closed" },
});

// android/src/viewer.ts(大图查看器:角标 / 删图两拍)的文案分片。
// 「图N」本身走 images.imageN(与卡上缩略图 alt 同一枚键,misc 分片)。
import { defineMessages } from "./entry";

export const viewer = defineMessages({
  "viewer.badgeOfN": { zh: "图{n} · {i}/{total}", en: "Image {n} · {i}/{total}" },
  "viewer.deleteQ": { zh: "删除这张图?删了不可恢复", en: "Delete this image? It cannot be recovered" },
  "viewer.deleteYes": { zh: "删除", en: "Delete" },
  "viewer.deleted": { zh: "已删除该图", en: "Image deleted" },
  "viewer.pending": { zh: "还没记下", en: "Not saved yet" },
  "viewer.pendingOfN": { zh: "还没记下 · {i}/{total}", en: "Not saved yet · {i}/{total}" },
  "viewer.removeQ": { zh: "把这张图从暂存里移除?它还没记下", en: "Remove this image from the draft? It hasn't been saved yet" },
  "viewer.removeYes": { zh: "移除", en: "Remove" },
  "viewer.removed": { zh: "已移除该图", en: "Image removed" },
});

// android/src/viewer.ts(大图查看器:角标 / 删图两拍)的文案分片。
// 「图N」本身走 images.imageN(与卡上缩略图 alt 同一枚键,misc 分片)。
import { defineMessages } from "./entry";

export const viewer = defineMessages({
  "viewer.badgeOfN": { zh: "图{n} · {i}/{total}", en: "Image {n} · {i}/{total}" },
  "viewer.deleteQ": { zh: "删除这张图?删了不可恢复", en: "Delete this image? It cannot be recovered" },
  "viewer.deleteYes": { zh: "删除", en: "Delete" },
  "viewer.deleted": { zh: "已删除该图", en: "Image deleted" },
});

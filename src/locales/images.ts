// src/item-images.ts 与 src/clipboard.ts(配图 / 复制)的文案分片。
import { defineMessages } from "./entry";

export const images = defineMessages({
  "itemImages.repasteHint": { zh: "(可在卡片编辑态重新粘贴)", en: "(you can paste again in the card's edit mode)" },
  "itemImages.copiedImage": { zh: "已复制图片", en: "Image copied" },
  "itemImages.copyFail": { zh: "复制失败", en: "Copy failed" },
  "itemImages.pasteFail": { zh: "粘贴图片失败", en: "Failed to paste image" },
  "itemImages.badge": { zh: "图{n}", en: "Image {n}" },
  "itemImages.loading": { zh: "图片载入中…", en: "Loading image…" },
  "itemImages.loadFail": { zh: "图片加载失败", en: "Image failed to load" },
  "itemImages.prev": { zh: "上一张(←)", en: "Previous (←)" },
  "itemImages.next": { zh: "下一张(→)", en: "Next (→)" },
  "itemImages.counter": { zh: "图{n} · {i}/{total}", en: "Image {n} · {i}/{total}" },
  "itemImages.preview": { zh: "预览", en: "Preview" },
  "itemImages.deleteImage": { zh: "删除这张图(编号不再复用)", en: "Delete this image (its number is never reused)" },
  "itemImages.linkTitle": { zh: "{url}\n点击打开 · 右键复制链接", en: "{url}\nClick to open · right-click to copy the link" },
  "itemImages.copiedLink": { zh: "已复制链接", en: "Link copied" },
  "itemImages.clickZoom": { zh: "点击放大", en: "Click to enlarge" },
  "itemImages.removeImage": { zh: "移除这张图", en: "Remove this image" },
  "clipboard.copy": { zh: "复制", en: "Copy" },
  "clipboard.copied": { zh: "已复制", en: "Copied" },
  "clipboard.copyFail": { zh: "复制失败", en: "Copy failed" },
});

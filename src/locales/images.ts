// src/item-images.ts 与 src/clipboard.ts(配图 / 复制)的文案分片。
import { defineMessages } from "./entry";

export const images = defineMessages({
  "itemImages.repasteHint": { zh: "(可在卡片编辑态重新粘贴)", en: " (you can paste again in the card's edit mode)" },
  // 挂图失败时**说得准的那几句**(538,用户面 56)。⛔ 它们**替掉** repasteHint,不是并列:
  // 这三种拒法都是确定性的,同样的字节再贴一次还是同样被拒 ⇒ 叫用户「重新粘贴」是错的。
  "itemImages.failEmpty": { zh: "(图片是空的)", en: " (the image is empty)" },
  "itemImages.failTooBig": { zh: "({mb} MB 超过 {max} MB 上限)", en: " ({mb} MB is over the {max} MB limit)" },
  "itemImages.failBadType": { zh: "(不支持 {mime} 这种格式,只收 png / jpeg / webp / gif)", en: " ({mime} isn’t a supported format; only png / jpeg / webp / gif)" },
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
  "itemImages.deleteImage": { zh: "删除这张图(保存时生效,进回收站,可还原到原编号)", en: "Delete this image (takes effect when you save; it goes to the trash and can be restored to the same number)" },
  "itemImages.undoDelete": { zh: "保存时会删掉这张 · 点一下撤销", en: "Will be deleted when you save · click to undo" },
  "itemImages.deleteFailed": { zh: "删图没成功:{err}", en: "Couldn’t delete the image: {err}" },
  "itemImages.linkTitle": { zh: "{url}\n点击打开 · 右键复制链接", en: "{url}\nClick to open · right-click to copy the link" },
  "itemImages.copiedLink": { zh: "已复制链接", en: "Link copied" },
  "itemImages.clickZoom": { zh: "点击放大", en: "Click to enlarge" },
  "itemImages.removeImage": { zh: "移除这张图", en: "Remove this image" },
  // 回收站里的「已删配图」一节(用户面 149,src/trash-images.ts)。
  "trashImages.title": { zh: "已删配图", en: "Deleted images" },
  "trashImages.row": { zh: "图{n} · 删除于 {when}", en: "Image {n} · deleted {when}" },
  "trashImages.noText": { zh: "(没有文字)", en: "(no text)" },
  "trashImages.restore": { zh: "还原", en: "Restore" },
  "trashImages.deleteForever": { zh: "彻底删除", en: "Delete forever" },
  "trashImages.deleteForeverQ": { zh: "彻底删除这张图?不可恢复", en: "Delete this image forever? This cannot be undone" },
  "trashImages.cancel": { zh: "取消", en: "Cancel" },
  "clipboard.copy": { zh: "复制", en: "Copy" },
  "clipboard.copied": { zh: "已复制", en: "Copied" },
  "clipboard.copyFail": { zh: "复制失败", en: "Copy failed" },
});

// android/src/images.ts(取图 / 挂图)的文案分片。桌面孪生 = src/locales/images.ts 里
// 那几枚 `itemImages.fail*`(⚠ **键空间两端独立**,不必同名;`CROSS_END_KEYS` 也没登记它们)。
import { defineMessages } from "./entry";

export const images = defineMessages({
  // 挂图失败时**说得准的那几句**(538,用户面 56)。⛔ 它们**替掉**「可在该卡片『加图』重贴」
  // 那句,不是并列:这三种拒法都是确定性的,同样的字节再贴一次还是同样被拒。
  "images.failEmpty": { zh: ":图片是空的", en: ": the image is empty" },
  "images.failTooBig": { zh: ":{mb} MB 超过 {max} MB 上限", en: ": {mb} MB is over the {max} MB limit" },
  "images.failBadType": { zh: ":不支持 {mime} 这种格式,只收 png / jpeg / webp / gif", en: ": {mime} isn’t a supported format — only png / jpeg / webp / gif" },
  // 说不准时退回的那句泛指引(原本焊在 main.imagesNotAttached 里,538 拆出来做备选)。
  "images.retryHint": { zh: ",可在该卡片「加图」重贴", en: " — use “Add image” on that card to retry" },
});

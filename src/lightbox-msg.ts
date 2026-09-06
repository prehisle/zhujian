// 「开图」这条跨窗口消息的**唯一契约**(606)。发信方 = 主窗 / 捕获窗(`item-images.ts`),
// 收信方 = 遮罩窗(`lightbox.ts`)。⛔ 两边别各写一份形状 —— 那是 memory `ys-notebook-doc-drift`
// 那一族:打架时谁也不能修谁。⚠ 这份**只放类型与常量**,不 import 任何窗口专属的东西,
// 三个入口(notebook / capture / lightbox)都装得起。

/** Mirror of lib.rs `ImageMeta` (no bytes): an image's id, 「图N」编号, and MIME. */
export type ImageMeta = { id: string; seq: number; mime: string };

/** 显示器的物理矩形。**由开图那个窗量**(它调 `currentMonitor()`),遮罩窗照着摆 ——
 *  遮罩窗自己去量会落到「它上次在的那块屏」,双屏下就摆错屏。 */
export type MonitorRect = { x: number; y: number; w: number; h: number };

/** 开图的**内容**那一半(发信方拼的);信封那一半见 LightboxOpen。
 *  ⛔ 别把两半并成一个类型再 Omit —— TS 的 Omit 会把可辨识联合压平成一个宽对象,
 *  `kind:"saved"` 的载荷就能少写 src/alt 而不报错(本轮实撞)。 */
export type LightboxBody = (
  | {
      /** 已入库的图:只送元数据,字节由遮罩窗自己 `get_item_image`(全尺寸 base64 不过事件)。 */
      kind: "saved";
      spaceId: string;
      images: ImageMeta[];
      index: number;
    }
  | {
      /** 还没入库的暂存图(compose / 捕获窗):object URL 跨不了窗,只能送 data URL。
       *  ⚠ 那份 base64 与保存时 `attachBlob` 过 IPC 的是同一个量级,不是新引入的开销。 */
      kind: "data";
      src: string;
      alt: string;
    }
);

/** 开图载荷 = 信封 + 内容。`from` = 开图那个窗的 label,关图时把焦点还给它。 */
export type LightboxOpen = {
  from: string;
  monitor: MonitorRect | null; // 量不到显示器就为 null:遮罩窗保持自己当前的几何(仍能看图)
} & LightboxBody;

/** 事件名。⛔ 别在别处写字面量。 */
export const LIGHTBOX_OPEN = "lightbox://open";

/** 「你在吗」/「我在了」。遮罩窗的页面在 app 启动后约 1.4 秒才加载完并装上 listener,
 *  在那之前发过去的开图事件**没人收、一声不响** —— 发信方靠这一对把那个静默丢失堵死
 *  (每 100ms ping 一次,答了才发开图)。⚠ e2e 里这一段更长:驱动一进来时遮罩窗还是
 *  `about:blank`(606 实测),不堵就是一支随机红。 */
export const LIGHTBOX_PING = "lightbox://ping";
export const LIGHTBOX_READY = "lightbox://ready";

/** 遮罩窗的窗口 label(tauri.conf.json 里那只)。 */
export const LIGHTBOX_LABEL = "lightbox";

// Shared 配图 (item images) controller — one source of truth for attaching, showing,
// referencing, and deleting the numbered 「图N」 images that hang off an item. Used by both
// the 灵感 cards (inbox.ts) and the 任务看板 cards (board.ts), mirroring the backend's
// images.rs / hotkey-menu.ts shared-controller pattern so the behaviour is identical across
// views. Images are a per-item 1:N attachment; the 编号 is stable and never reused, so a
// 正文「见图N」 reference always points at the same picture (see migration 0016).

import { invoke, invokeInSpace } from "./space";
import { openUrl } from "@tauri-apps/plugin-opener";
import { copyText } from "./clipboard";
import { PhysicalPosition, PhysicalSize, LogicalSize } from "@tauri-apps/api/dpi";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import "./item-images.css";

/** Mirror of lib.rs `ImageMeta` (no bytes): an image's id, 「图N」编号, and MIME. */
export type ImageMeta = { id: string; seq: number; mime: string };

// ---- small DOM helper (kept local so this module stands alone) -------------
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) node.append(c);
  return node;
}

/** List an item's images (编号 ascending; deleted 编号 leave gaps). */
export function listImages(itemId: string): Promise<ImageMeta[]> {
  return invoke<ImageMeta[]>("list_item_images", { itemId });
}

// 图字节内存纪律(163② 学安卓 117):缩略图条**每张卡都渲染只读小图**、桌面又无懒加载,
// 若像 163③ 那样按 id 缓「全尺寸 data URL」,缓存会随图库线性膨胀且永不释放——base64 是 JS
// 强引用字符串,不受 WebView 图片缓存的压力驱逐;且每个 <img> 还常驻解码整张全尺寸位图。
// 改为:缩略图**过 canvas 降采样成 ≤144² 方裁小图**(与 .img-thumb 的 72² object-fit:cover
// 同款中心裁,视觉不变),只缓小图;lightbox 要全尺寸,只留「最近看过的 1 张」(二开秒显、
// 又不无界)。两处都只缓**已到手的字符串**、不缓 Promise——统一 invoke 包装把跨空间迟到响应
// 变成「永不决议」(space.ts stale),缓 Promise 会把这种挂起永久钉进 Map(163③ 教训)。
// 图不可变(只增删不改,0016)故小图永不失效,删图时清项。
const thumbCache = new Map<string, string>(); // imageId → 降采样 ≤144² data URL

// lightbox 的全尺寸缓存:只留最近看过的一张(换图即顶掉旧的 → 至多 1 张全尺寸常驻)。
let lastFull: { id: string; url: string } | null = null;

/** 全尺寸字节 → data URL(lightbox 用)。命中「刚看过那张」秒回,否则取回并顶掉旧的。 */
function getFullImage(imageId: string): Promise<string> {
  if (lastFull && lastFull.id === imageId) return Promise.resolve(lastFull.url);
  return invoke<string>("get_item_image", { imageId }).then((url) => {
    lastFull = { id: imageId, url }; // 旧 url 无人引用即可回收(至多留 1 张全尺寸)
    return url;
  });
}

// 降采样(安卓 117 手法):一律过 canvas 重编码成 ≤144² 的 cover 方裁——原图哪怕像素尺寸小
// 也可能字节巨大(多帧/元数据),直接缓原 data URL = 缓存无界;只钉短边则超宽长图 thumb 仍
// 巨大,故两边都钉死。小图不放大、照样重编码;透明 PNG 经 JPEG 扁平化会失透明(与安卓一致,
// lightbox 看的仍是原图)。解码失败响亮 reject,调用方标 .broken。
const THUMB_PX = 144;
function shrinkToThumb(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = (): void => {
      const crop = Math.min(img.naturalWidth, img.naturalHeight); // 原图中央方形
      const side = Math.min(THUMB_PX, crop);
      const c = document.createElement("canvas");
      c.width = side;
      c.height = side;
      const ctx = c.getContext("2d");
      if (!ctx) return reject(new Error("canvas 2d 上下文不可用"));
      // 中央方裁 → 缩到 side×side(cover;source rect 居中,dest 铺满)。
      ctx.drawImage(img, (img.naturalWidth - crop) / 2, (img.naturalHeight - crop) / 2, crop, crop, 0, 0, side, side);
      resolve(c.toDataURL("image/jpeg", 0.8));
    };
    img.onerror = (): void => reject(new Error("图片解码失败"));
    img.src = url;
  });
}

/** 缩略图小图(缩略图条用):命中缓存秒回,否则取全尺寸→降采样→只缓小图(全尺寸随即丢弃)。 */
function getThumb(imageId: string): Promise<string> {
  const hit = thumbCache.get(imageId);
  if (hit !== undefined) return Promise.resolve(hit);
  return invoke<string>("get_item_image", { imageId })
    .then(shrinkToThumb)
    .then((small) => {
      thumbCache.set(imageId, small);
      return small;
    });
}

// Blob -> base64 (no data: prefix) for the IPC hop. Chunked so a large image never
// blows the argument limit of String.fromCharCode(...spread).
async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Attach one image blob (pasted screenshot or picked file) to an item as its next 「图N」.
 *  Resolves to the new image's metadata. Throws on a bad type / empty blob (the backend's
 *  CHECK is the authority — fail-fast, no silent default). */
export async function attachBlob(itemId: string, blob: Blob, space?: string): Promise<ImageMeta> {
  const dataB64 = await toBase64(blob);
  // 显式空间 = 必落账链(创建后挂图):响应恒到达,不走「跨空间迟到即永不决议」的
  // 统一包装——那会把 in-flight 闸卡死(codex P1 二审 H1)。
  if (space !== undefined)
    return invokeInSpace<ImageMeta>(space, "add_item_image", { itemId, mime: blob.type, dataB64 });
  return invoke<ImageMeta>("add_item_image", { itemId, mime: blob.type, dataB64 });
}

/** The first image on a paste, or null if the clipboard carried none (so the caller can let
 *  a normal text paste through). Screenshots arrive as a `file`-kind image item. */
export function imageFromPaste(e: ClipboardEvent): Blob | null {
  const items = e.clipboardData?.items;
  if (!items) return null;
  for (const it of items) {
    if (it.kind === "file" && it.type.startsWith("image/")) {
      const f = it.getAsFile();
      if (f) return f;
    }
  }
  return null;
}

/** Mount a full-window overlay around `inner`; click anywhere or press Esc closes it.
 *  `onClose` runs while the overlay is STILL up and is awaited before teardown — so a caller
 *  that shrinks a grown window does it under the dark backdrop (no bare-window flash on close). */
function mountLightbox(
  inner: HTMLElement,
  onClose?: () => void | Promise<void>,
): { overlay: HTMLElement; close: () => Promise<void> } {
  const overlay = el("div", { className: "img-lightbox" }, [inner]);
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return; // a click + Esc race shouldn't run teardown twice
    closing = true;
    try {
      await onClose?.();
    } finally {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
    }
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };
  overlay.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.append(overlay);
  return { overlay, close };
}

/** Lightbox image viewer:「整图」或「铺满宽度」两种取向 + 原生滚动 + Ctrl+滚轮缩放。图尺寸
 *  由 JS 直接写 width/height(不用 transform),溢出交给 `.img-lightbox`(overflow:auto)原生
 *  滚动——开图默认「整图」先看全貌(超高长截图也不例外;默认铺宽会让人误以为图到视口底为止),
 *  双击切「铺宽」滚看细节。交互(方案 A):无 Ctrl 滚轮=能竖滚就原生滚、否则(整图放得下)缩放;`Ctrl+滚轮`
 *  永远缩放(rect 锚点);双击切「整图↔铺宽」(且此后 resize 不再自动改取向);溢出时拖着滚(手
 *  型),整图放得下时单击关闭(延迟一个双击判定窗口,免与双击抢)。`init()` 在自然尺寸 + 最终窗口
 *  尺寸都定后挑取向并布局一次(mode 未被用户双击改过时,resize 会自动重挑取向,兜住 capture 先小
 *  窗 init 再放大的时序)。`cleanup()` 摘 EVERY 监听(含 window resize)——调用方必须在关闭时调,
 *  否则 resize 监听常驻拽住 img 的全尺寸位图不放,破「不缓存全尺寸图」内存纪律(codex 三审 H3)。 */
function makeImageViewer(
  img: HTMLImageElement,
  requestClose: () => void,
): { init: () => void; cleanup: () => void; signal: AbortSignal } {
  const ac = new AbortController();
  const { signal } = ac;
  // 布局未定不显示(ui-guidelines §3.7):.img-lightbox-img 无 CSS 尺寸约束,宽高全靠下面
  // layout() 写——从 src 解码到 init() 之间隔着取字节/量窗/放大窗数个 await,裸渲染会以
  // 原始尺寸闪现、随窗口放大反排、最后猛缩定位(2026-07-19 用户实测的「过渡状态」)。
  // 故出生即隐形零占位,init() 定形后一次成形亮相。
  img.style.visibility = "hidden";
  img.style.width = "0px";
  img.style.height = "0px";
  const PAD = 32; // 与 .img-lightbox-stage padding 一致
  const DRAG_THRESHOLD = 4; // px:超过才算拖动(否则算单击)
  const CLICK_DELAY = 500; // ms:单击关闭延迟 ≥ 系统双击判定,免真双击被第一击提前关(H1)
  let mode: "fit" | "fill" = "fit"; // fill = 铺满宽度、竖向可滚
  let zoom = 1; // 在 mode 基准尺寸上再乘的缩放(Ctrl+滚轮)
  let userToggled = false; // 用户双击切过取向后,resize 不再自动改 mode
  let dragged = false;
  let closeTimer: number | null = null;

  const scroller = (): HTMLElement | null => img.closest<HTMLElement>(".img-lightbox");
  const nw = (): number => img.naturalWidth || 1;
  const nh = (): number => img.naturalHeight || 1;
  const viewport = (): { w: number; h: number } => {
    const s = scroller();
    const w = s ? s.clientWidth : window.innerWidth;
    const h = s ? s.clientHeight : window.innerHeight;
    return { w: Math.max(1, w - PAD * 2), h: Math.max(1, h - PAD * 2) };
  };
  // fit 基准与最小缩放都封顶 1:1——小图不放大(旧 CSS max-width/height 的行为,M3)。
  const fitWholeScale = (): number => {
    const { w, h } = viewport();
    return Math.min(w / nw(), h / nh(), 1);
  };
  const baseScale = (): number => {
    if (mode === "fit") return fitWholeScale();
    const { w } = viewport();
    return Math.min(w / nw(), 1); // 铺宽同样不超 1:1
  };
  const canScrollY = (): boolean => {
    const s = scroller();
    return !!s && s.scrollHeight - s.clientHeight > 1;
  };
  const canScrollX = (): boolean => {
    const s = scroller();
    return !!s && s.scrollWidth - s.clientWidth > 1;
  };
  const canPan = (): boolean => canScrollX() || canScrollY();
  const layout = (): void => {
    const scale = baseScale() * zoom;
    img.style.width = `${Math.round(nw() * scale)}px`;
    img.style.height = `${Math.round(nh() * scale)}px`;
    img.style.cursor = canPan() ? "grab" : "zoom-out";
  };
  // 取向:默认恒「整图」——超高长截图也先看全貌(默认铺宽会让人以为图就到那儿为止);
  // 想看清双击切「铺宽」或 Ctrl+滚轮放大,一步就到(2026-07-18 用户拍板,反转 139 的自动挑)。
  const decideMode = (): void => {
    mode = "fit";
  };
  const init = (): void => {
    if (signal.aborted) return;
    wire(); // 遮罩此时已进 DOM → 把滚轮挂到 scroller(见 onWheel/wire)
    if (!userToggled) decideMode();
    zoom = 1;
    layout();
    const s = scroller();
    if (s) {
      s.scrollTop = 0;
      s.scrollLeft = 0;
    }
    img.style.visibility = ""; // 定形完毕,一次成形亮相(与构造时的出生隐形配对)
  };

  // 光标锚点缩放:用 img 真实 rect 算光标在图内的归一坐标,缩放后调 scroll 让它回到光标处
  // (避开 padding + 居中偏移;图仍居中未溢出时无 scroll 范围、这帧锚点近似,浏览器边界钳位)。
  const zoomAt = (cx: number, cy: number, factor: number): void => {
    const s = scroller();
    if (!s) return;
    const before = img.getBoundingClientRect();
    // 光标在图内的归一坐标钳到 [0,1]:Ctrl+滚轮落在图外 padding 时也不会算出离谱锚点(退化到边缘)。
    const fx = before.width > 0 ? Math.min(1, Math.max(0, (cx - before.left) / before.width)) : 0.5;
    const fy = before.height > 0 ? Math.min(1, Math.max(0, (cy - before.top) / before.height)) : 0.5;
    const base = baseScale();
    const oldScale = base * zoom;
    const maxScale = Math.max(1, fitWholeScale() * 8); // 上限=1:1 或整图基准 8× 取大(避免大图被放到离谱尺寸)
    const newScale = Math.min(maxScale, Math.max(fitWholeScale(), oldScale * factor));
    if (newScale === oldScale) return;
    zoom = newScale / base;
    layout();
    const after = img.getBoundingClientRect();
    s.scrollLeft += after.left + fx * after.width - cx;
    s.scrollTop += after.top + fy * after.height - cy;
  };
  // resize/mode 变后 baseScale 变,把绝对 scale 钳回 [整图可见, 8×](zoom 是相对 baseScale 的乘子)。
  const clampZoom = (): void => {
    const base = baseScale();
    const scale = Math.min(Math.max(1, fitWholeScale() * 8), Math.max(fitWholeScale(), base * zoom));
    zoom = scale / base;
  };

  // 滚轮挂在 scroller(整个遮罩,含图外 padding)——Ctrl+滚轮在任何位置都缩放(M1);普通滚轮
  // 能竖滚就交原生、只横溢出的横滚也交原生、否则(整图放得下)缩放。scroller 挂载后由 init 里的
  // wire() 接上(makeImageViewer 构造时遮罩还没进 DOM,拿不到 scroller)。
  const onWheel = (e: WheelEvent): void => {
    if (e.ctrlKey) {
      e.preventDefault();
      if (e.deltaY !== 0) zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
      return;
    }
    if (canScrollY()) return;
    if (canScrollX() && (e.deltaX !== 0 || e.shiftKey)) return;
    if (e.deltaY !== 0) {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    }
  };
  let wired = false;
  const wire = (): void => {
    if (wired) return;
    const s = scroller();
    if (!s) return;
    wired = true;
    s.addEventListener("wheel", onWheel, { passive: false, signal });
  };
  img.addEventListener(
    "dblclick",
    (e) => {
      e.stopPropagation();
      if (closeTimer !== null) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
      mode = mode === "fit" ? "fill" : "fit";
      userToggled = true; // 手动切过 → resize 不再自动改取向
      zoom = 1;
      layout();
      const s = scroller();
      if (s) {
        s.scrollTop = 0;
        s.scrollLeft = 0;
      }
    },
    { signal },
  );
  // 拖动=拽着滚(手型平移):只在有溢出时接管;主指针左键、过阈值才算拖动。
  let sx = 0;
  let sy = 0;
  let moved = 0;
  let panning = false;
  let activePointer: number | null = null;
  img.addEventListener(
    "pointerdown",
    (e) => {
      if (e.button !== 0 || !e.isPrimary) return;
      if (closeTimer !== null) {
        clearTimeout(closeTimer); // 第二次按下 → 取消上一击的待关(双击不误关,H1 兜底)
        closeTimer = null;
      }
      if (!canPan()) return; // 整图放得下:让单击走 click→关闭
      panning = true;
      dragged = false;
      moved = 0;
      activePointer = e.pointerId;
      sx = e.clientX;
      sy = e.clientY;
      img.setPointerCapture(e.pointerId);
      img.style.cursor = "grabbing";
    },
    { signal },
  );
  img.addEventListener(
    "pointermove",
    (e) => {
      if (!panning || e.pointerId !== activePointer) return;
      const s = scroller();
      if (s) {
        s.scrollLeft -= e.clientX - sx;
        s.scrollTop -= e.clientY - sy;
      }
      moved += Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy);
      sx = e.clientX;
      sy = e.clientY;
      if (moved > DRAG_THRESHOLD) dragged = true;
    },
    { signal },
  );
  const endPan = (e: PointerEvent): void => {
    if (!panning || e.pointerId !== activePointer) return;
    panning = false;
    activePointer = null;
    img.style.cursor = canPan() ? "grab" : "zoom-out";
    try {
      img.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  };
  img.addEventListener("pointerup", endPan, { signal });
  img.addEventListener(
    "pointercancel",
    (e) => {
      endPan(e);
      dragged = false; // 取消后无 click 收尾:主动复位,免下次单击被误当拖动吞掉(M4)
      moved = 0;
    },
    { signal },
  );
  img.addEventListener(
    "click",
    (e) => {
      e.stopPropagation(); // 图上的单击永不直接冒泡到遮罩关(交给下面的延迟判定)
      if (dragged) {
        dragged = false;
        return;
      }
      if (canPan()) return; // 长图/放大态:单击不关
      if (e.detail !== 1) return; // 只有真正的单击(非双击的第二下)才安排关闭
      if (closeTimer !== null) return;
      closeTimer = window.setTimeout(() => {
        closeTimer = null;
        requestClose();
      }, CLICK_DELAY); // 延迟关,给双击(dblclick 会 clearTimeout)取消的机会(H1)
    },
    { signal },
  );
  // resize 后视口变:未被用户双击改过取向则重挑 mode(兜 capture 先小窗后放大),再重排(zoom 留)。
  // 监听走 signal,关闭时随 cleanup 一起摘(H3:不靠"下次 resize 自摘")。
  window.addEventListener(
    "resize",
    () => {
      if (signal.aborted) return;
      if (!userToggled) decideMode();
      clampZoom(); // 视口变后把绝对 scale 钳回合法区间(zoom 保留;M2/M3 残留)
      layout();
    },
    { signal },
  );
  return {
    init,
    signal,
    cleanup: (): void => {
      if (closeTimer !== null) clearTimeout(closeTimer);
      ac.abort();
    },
  };
}

/** 看已保存图时把笔记本主窗放大到「图原尺寸 + 边距」(上限=显示器 92%),返回还原原
 *  几何的闭包;不需要放大(已最大化 / 图比当前窗口还小)时返回 null。lightbox 的暗遮罩
 *  铺满的是窗口而非屏幕,故只有把窗口撑到接近屏幕,CSS 的「适配容器」才等于用户要的
 *  「适配屏幕」——小图近原大、大图缩到屏幕合适。复用捕获窗 openPreviewLarge 验证过的
 *  92%/PAD 算法(main.ts)。所有权限调用失败(没授权/取不到显示器)都吞成 null:lightbox
 *  照常显示,只是仍受窗口边界。scaleFactor 走免权限的 devicePixelRatio。 */
async function planGrowMainWindow(
  naturalW: number,
  naturalH: number,
): Promise<{ restore: () => Promise<void>; applyGrow: () => Promise<void> } | null> {
  const win = getCurrentWindow();
  try {
    if (await win.isMaximized()) return null; // 已铺满屏幕,lightbox 本就是屏幕尺寸
    const sf = window.devicePixelRatio || 1;
    const prevSize = await win.innerSize(); // physical;原样存、原样还原,免 DPI 换算误差
    const prevPos = await win.outerPosition(); // physical
    const prevW = prevSize.width / sf; // 逻辑单位,与 naturalWidth(CSS px)/显示器逻辑尺寸同口径
    const prevH = prevSize.height / sf;
    let maxW = 1280;
    let maxH = 880;
    const mon = await currentMonitor();
    if (mon) {
      const msf = mon.scaleFactor || 1;
      maxW = Math.floor((mon.size.width / msf) * 0.92);
      maxH = Math.floor((mon.size.height / msf) * 0.92);
    }
    const PAD = 56; // lightbox padding + 一点余量
    const targetW = Math.max(900, Math.min((naturalW || 600) + PAD, maxW)); // 笔记本 minWidth 900
    const targetH = Math.max(600, Math.min((naturalH || 400) + PAD, maxH)); // minHeight 600
    if (targetW <= prevW && targetH <= prevH) return null; // 图已放得下,别动窗口(免无谓跳动)
    // 原地长大,不再无脑 center(用户报:看张图不该把整个主窗甩到屏幕正中):保持原左上角,只在撑大
    // 后会超出当前显示器时朝内钳最小的一段(窗比屏还大就贴左上角)。全程用物理像素算——outerPosition
    // 与显示器 position/size 都是物理量,免 DPI 换算误差;取不到显示器信息(mon 为空)才退回旧的居中。
    let targetPos: PhysicalPosition | null = null;
    if (mon) {
      const msf = mon.scaleFactor || 1;
      const physW = Math.round(targetW * msf); // setSize 用逻辑尺寸;窗在本显示器上,物理尺寸即 ×msf
      const physH = Math.round(targetH * msf);
      const maxX = mon.position.x + mon.size.width - physW; // 右不溢出的左上角上界
      const maxY = mon.position.y + mon.size.height - physH; // 下不溢出的左上角上界
      const x = Math.max(mon.position.x, Math.min(prevPos.x, maxX)); // 先钳上界再钳下界:窗>屏时落左上
      const y = Math.max(mon.position.y, Math.min(prevPos.y, maxY));
      targetPos = new PhysicalPosition(x, y);
    }
    // restore 与 applyGrow 分开返回:调用方先登记 restore 再 applyGrow,故即使关闭抢在
    // 放大过程中(setSize/setPosition 的 await 间隙)发生,onClose 也能把窗口还原回去。
    const restore = async (): Promise<void> => {
      try {
        await win.setSize(new PhysicalSize(prevSize.width, prevSize.height));
        await win.setPosition(new PhysicalPosition(prevPos.x, prevPos.y));
      } catch {
        /* 还原失败无妨——用户可手动调整 */
      }
    };
    const applyGrow = async (): Promise<void> => {
      await win.setSize(new LogicalSize(targetW, targetH));
      if (targetPos) await win.setPosition(targetPos); // 原地长大 + 边界钳位(替代无脑 center)
      else await win.center(); // 无显示器信息:退回旧的居中行为
    };
    return { restore, applyGrow };
  } catch {
    return null;
  }
}

/** 放大窗口的 IPC 返回不等于 WebView 视口已更新(WM_SIZE→webview 重排→JS resize 异步
 *  到达)。init() 若用旧视口布局,亮相后会被迟到的 resize 再排一次——尺寸可见地跳一记
 *  (163 续案,超高图最显眼)。这里等视口真离开放大前的尺寸并连续两帧稳定再放行;600ms
 *  兜底——setSize 被拒/无效时视口永不变,超时按当前视口布局(等于旧行为,不更糟)。 */
function viewportSettle(preW: number, preH: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let lastW = -1;
    let lastH = -1;
    let stable = 0;
    const tick = (): void => {
      if (signal.aborted) return resolve(); // 关闭抢先:立即放行,调用方靠 closed 止步
      const w = window.innerWidth;
      const h = window.innerHeight;
      if ((w !== preW || h !== preH) && w === lastW && h === lastH) {
        stable += 1;
        if (stable >= 2) return resolve();
      } else stable = 0;
      lastW = w;
      lastH = h;
      if (performance.now() - t0 > 600) return resolve();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** A full-window overlay showing a SAVED image at full size (bytes load lazily as a data:
 *  URL by id). 滚轮缩放 / 滚动、拖动平移、双击切取向;click backdrop 或 Esc 关闭(见 makeImageViewer)。
 *  在暗遮罩下把主窗撑到近屏幕(planGrowMainWindow),关闭时先摘监听再还原窗口——两步都在
 *  遮罩仍覆盖时发生,无裸窗闪(与捕获窗同纪律)。 */
export async function openLightbox(imageId: string, seq: number): Promise<void> {
  const img = el("img", { className: "img-lightbox-img", alt: `图${seq}` });
  // 取字节/解码/定窗期间的加载指示(§3.7 审计 #14):CSS 延迟淡入,快路径(命中「刚看过」的
  // 全尺寸缓存)一闪而过时不露脸;init 前 remove,showError 的 replaceChildren 也会带走它。
  const loading = el("div", { className: "img-lightbox-loading", textContent: "图片载入中…" });
  const stage = el("div", { className: "img-lightbox-stage" }, [loading, img]);
  let closed = false;
  let restore: (() => Promise<void>) | null = null;
  let grow: Promise<void> | null = null; // 进行中的放大;关闭须等它跑完(成/败)再唯一一次还原(H4)
  const viewer = makeImageViewer(img, () => close());
  const { overlay, close } = mountLightbox(stage, async () => {
    closed = true; // 关标志:让下面异步流(invoke/load/放大)每个 await 后止步
    viewer.cleanup(); // 摘缩放/滚动监听(含 window resize),不泄漏 img
    if (grow) await grow.catch(() => {}); // 等放大真正结束(即便 center 抛错),避免 restore 与放大并发
    if (restore) await restore(); // 仍在暗遮罩下还原窗口几何(只此一次)
  });
  const showError = (): void => {
    if (closed) return;
    viewer.cleanup();
    overlay.replaceChildren(el("div", { className: "img-lightbox-err", textContent: "图片加载失败" }));
  };
  try {
    const src = await getFullImage(imageId);
    if (closed) return;
    // 图解码出来才知道自然尺寸 → 据此把主窗撑到近屏幕(在暗遮罩下 resize,无闪)。load 监听走
    // viewer.signal:关闭时随 cleanup 一起摘、并由 abort 事件让本 Promise 必定 settle(M5)。
    await new Promise<void>((resolve) => {
      img.addEventListener("load", () => resolve(), { once: true, signal: viewer.signal });
      img.addEventListener("error", () => resolve(), { once: true, signal: viewer.signal });
      viewer.signal.addEventListener("abort", () => resolve(), { once: true });
      img.src = src;
    });
    if (closed) return;
    if (img.naturalWidth === 0) {
      showError(); // 解码失败:明确失败 UI + 立刻 cleanup,别留空白遮罩(M5)
      return;
    }
    const plan = await planGrowMainWindow(img.naturalWidth, img.naturalHeight);
    if (closed) return; // 关在放大前:窗口没动,onClose 里 restore 仍 null,无需还原
    if (plan) {
      const preW = window.innerWidth; // 放大前的视口:viewportSettle 以「离开此尺寸」为信号
      const preH = window.innerHeight;
      restore = plan.restore; // 先登记还原,再启动放大:onClose 会等 grow 完再还原(串行,不并发)
      grow = plan.applyGrow();
      await grow.catch(() => {}); // 放大失败不致命(权限/重启未生效时窗口保持原尺寸)
      if (closed) return; // 关已在放大中发生:onClose 负责等 grow + 还原,这里不再动
      await viewportSettle(preW, preH, viewer.signal); // 视口真落定再布局,亮相后不再被迟到 resize 重排
      if (closed) return;
    }
    loading.remove();
    viewer.init(); // 窗口已定尺(放大过或没放大)→ 挑取向 + 布局一次 + 亮相
  } catch {
    showError();
  }
}

/** A full-window overlay showing an image from a ready src (object URL / data URL) — for an
 *  unsaved preview (e.g. a just-pasted capture image, which has no id yet). `opts.onClose` runs
 *  after it closes; `opts.grow`(捕获窗传入)把浮窗放大到图的近原尺寸——`apply` 在暗遮罩下
 *  放大、`restore` 关闭时缩回。**放大→视口落定→亮相**的无闪时序由本函数统一负责(与已保存图
 *  的 openLightbox 同纪律,163 续案):先前捕获窗是「先小窗 init、放大后 resize 重挑」,亮相后
 *  被迟到的 resize 重排一次(尺寸可见跳一记);现改为图先隐形解码、窗口在暗遮罩下放大、viewport
 *  真落定后一次成形亮相。放大/解码期间显「图片载入中…」加载指示(§3.7,快路径 <0.2s 不露脸)。 */
export function openLightboxUrl(
  src: string,
  alt = "预览",
  opts: {
    onClose?: () => void | Promise<void>;
    grow?: { apply: () => Promise<void>; restore: () => Promise<void> };
  } = {},
): void {
  const img = el("img", { className: "img-lightbox-img", alt });
  const loading = el("div", { className: "img-lightbox-loading", textContent: "图片载入中…" });
  const stage = el("div", { className: "img-lightbox-stage" }, [loading, img]);
  let closed = false;
  let restore: (() => Promise<void>) | null = null;
  let grow: Promise<void> | null = null; // 进行中的放大;关闭须等它跑完(成/败)再唯一一次还原(H4)
  const viewer = makeImageViewer(img, () => close());
  // 关闭:先摘缩放/滚动监听(含 window resize),等在途放大跑完再唯一一次还原窗口,最后跑调用方
  // 的 onClose——都在暗遮罩仍覆盖时发生,无裸窗闪(与 openLightbox 同纪律)。
  const { overlay, close } = mountLightbox(stage, async () => {
    closed = true; // 关标志:让下面异步流每个 await 后止步
    viewer.cleanup();
    if (grow) await grow.catch(() => {}); // 等放大真正结束,避免 restore 与放大并发
    if (restore) await restore(); // 仍在暗遮罩下还原窗口几何(只此一次)
    await opts.onClose?.();
  });
  const showError = (): void => {
    if (closed) return;
    viewer.cleanup();
    overlay.replaceChildren(el("div", { className: "img-lightbox-err", textContent: "图片加载失败" }));
  };
  void (async () => {
    try {
      // src 已就绪(object URL / data URL),但大截图仍要解码——等 load 拿到自然尺寸再走(图此刻
      // 隐形,不闪)。监听走 viewer.signal:关闭随 cleanup 一起摘、abort 让本 Promise 必定 settle。
      await new Promise<void>((resolve) => {
        img.addEventListener("load", () => resolve(), { once: true, signal: viewer.signal });
        img.addEventListener("error", () => resolve(), { once: true, signal: viewer.signal });
        viewer.signal.addEventListener("abort", () => resolve(), { once: true });
        img.src = src;
      });
      if (closed) return;
      if (img.naturalWidth === 0) {
        showError();
        return;
      }
      if (opts.grow) {
        const preW = window.innerWidth; // 放大前视口:viewportSettle 以「离开此尺寸」为信号
        const preH = window.innerHeight;
        restore = opts.grow.restore; // 先登记还原,再启动放大:onClose 会等 grow 完再还原(串行)
        grow = opts.grow.apply();
        await grow.catch(() => {}); // 放大失败不致命(权限/重启未生效时窗口保持原尺寸)
        if (closed) return;
        await viewportSettle(preW, preH, viewer.signal); // 视口真落定再布局,不被迟到 resize 重排
        if (closed) return;
      }
      loading.remove();
      viewer.init(); // 窗口已定尺(放大过或没放大)→ 挑取向 + 布局一次 + 亮相
    } catch {
      showError();
    }
  })();
}

/** A thumbnail strip for an item's images. `editable` adds a × to delete each one (used in a
 *  card's edit mode); read-only strips just open the lightbox on click. Returns the root plus
 *  a `reload` so the editor can refresh it after an attach/delete. `onChange` fires after a
 *  delete so the host can re-linkify its 正文 (a 图N whose image just left becomes plain text). */
export function imageStrip(
  itemId: string,
  opts: { editable: boolean; onChange?: () => void },
): { root: HTMLElement; reload: () => Promise<void> } {
  // 初始即 .empty(隐藏):reload 前默认无图,免得配图工具条在 load 完成前闪一下再收起。
  const root = el("div", { className: "img-strip empty" });

  function thumb(m: ImageMeta): HTMLElement {
    const wrap = el("div", { className: "img-thumb" });
    const img = el("img", { className: "img-thumb-img", alt: `图${m.seq}`, title: `图${m.seq}` });
    getThumb(m.id)
      .then((url) => {
        img.src = url; // 缓存命中=同帧微任务落 src,重渲不再逐张闪现(且落的是小图,不解全尺寸位图)
      })
      .catch(() => {
        wrap.classList.add("broken");
      });
    img.addEventListener("click", (e) => {
      e.stopPropagation();
      void openLightbox(m.id, m.seq);
    });
    wrap.append(img, el("span", { className: "img-badge", textContent: `图${m.seq}` }));
    if (opts.editable) {
      const del = el("button", { className: "img-del", textContent: "×", title: "删除这张图(编号不再复用)" });
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          await invoke("delete_item_image", { imageId: m.id });
        } catch {
          return; // leave the thumb in place if the delete failed
        }
        thumbCache.delete(m.id); // 内存卫生:小图缓存清项
        if (lastFull && lastFull.id === m.id) lastFull = null; // 连带清掉可能命中的「刚看过」
        await reload();
        opts.onChange?.();
      });
      wrap.append(del);
    }
    return wrap;
  }

  async function reload(): Promise<void> {
    let metas: ImageMeta[];
    try {
      metas = await listImages(itemId);
    } catch {
      root.replaceChildren();
      return;
    }
    root.classList.toggle("empty", metas.length === 0);
    root.replaceChildren(...metas.map(thumb));
  }

  void reload();
  return { root, reload };
}

// Trailing punctuation that commonly hugs a URL in prose but isn't part of it, so
// "见 https://a.com。" or "(https://a.com)" don't swallow the 。/) into the link.
const URL_TAIL = /[)\].,;:!?，。、;:!?…）】》」』]+$/;

// A brief floating toast at (x, y) — used to confirm 复制链接 without shifting the
// inline text or needing a global toast system. Self-removes after the fade.
function flashToast(x: number, y: number, text: string): void {
  const t = el("div", { className: "copy-toast", textContent: text });
  t.style.left = `${x}px`;
  t.style.top = `${y}px`;
  document.body.append(t);
  setTimeout(() => t.remove(), 1000);
}

/** Render `text` with two kinds of inline references linkified in a single left-to-right pass:
 *   - 「图N」 that has a matching image → a clickable chip that opens the lightbox. A 图N with NO
 *     such image is left as plain text — we never fake a link.
 *   - an http/https URL → a clickable link that opens in the system browser (never navigates the
 *     webview itself). Only http/https are linkified; any other scheme stays plain text.
 *  Returns a fragment the caller drops into the content node. */
export function renderContent(text: string, images: ImageMeta[]): DocumentFragment {
  const bySeq = new Map(images.map((m) => [m.seq, m]));
  const frag = document.createDocumentFragment();
  // One combined scanner: alternation of a URL or a 图N, matched in document order so the
  // two never overlap or double-consume a span of text.
  const re = /(https?:\/\/[^\s，。、;：！？）】《」』]+)|图(\d+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1] !== undefined) {
      // ---- URL ----
      let url = m[1];
      const tail = URL_TAIL.exec(url);
      const drop = tail ? tail[0].length : 0; // punctuation that hugs the URL stays as text
      url = url.slice(0, url.length - drop);
      if (m.index > last) frag.append(text.slice(last, m.index));
      // title = 完整链接 + 手势提示,悬停即自解释(尾随标点已剥,hover 看得到真实地址)。
      const a = el("a", { className: "link-ref", href: url, title: `${url}\n点击打开 · 右键复制链接` });
      a.textContent = url;
      a.addEventListener("click", (e) => {
        e.preventDefault(); // a bare href would navigate the webview away — open externally
        e.stopPropagation();
        void openUrl(url).catch(() => {});
      });
      // 右键 = 复制链接(想粘到指定浏览器时用),抑制原生右键菜单、就地飘一个「已复制链接」。
      a.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        copyText(url)
          .then(() => flashToast(e.clientX, e.clientY, "已复制链接"))
          .catch(() => flashToast(e.clientX, e.clientY, "复制失败"));
      });
      frag.append(a);
      last = m.index + url.length; // leave any trailing punctuation for the plain-text tail
      continue;
    }
    // ---- 图N ----
    const meta = bySeq.get(Number(m[2]));
    if (!meta) continue; // no such image — leave the literal "图N" text untouched
    if (m.index > last) frag.append(text.slice(last, m.index));
    const chip = el("button", { className: "img-ref", textContent: `图${meta.seq}` });
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      void openLightbox(meta.id, meta.seq);
    });
    frag.append(chip);
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

/** 新建入口的「暂存配图」控制器 —— 捕获浮窗 / 灵感「记下灵感」/ 看板「新建任务」三个入口共用
 *  的单一真相源。条目要等提交才存在,粘贴时还没有 id 可挂,所以图先以内存预览暂存(object URL,
 *  移除/清空时 revoke 不漏内存),提交拿到 id 后 attachAll 逐张挂上。规则:凡是能输入条目正文的
 *  地方,都能 Ctrl+V 配图 —— 新入口一律接这个控制器,不再各写各的。 */
/** 暂存图条目(pendingImages 内部批的元素;takeBatch/putBack/attachBatch 传递用)。 */
export type PendingImage = { blob: Blob; url: string; thumb: HTMLElement };

export function pendingImages(
  opts: {
    /** 增删预览后回调(捕获浮窗用它随内容长/缩窗口)。 */
    onChange?: () => void;
    /** 点预览看大图的方式;不传就用普通遮罩 openLightboxUrl(捕获浮窗要连窗口一起放大)。 */
    openPreview?: (url: string, naturalW: number, naturalH: number) => void;
  } = {},
): {
  root: HTMLElement;
  count: () => number;
  wire: (area: HTMLTextAreaElement) => void;
  attachAll: (itemId: string) => Promise<number>;
  takeBatch: () => PendingImage[];
  putBack: (batch: PendingImage[]) => void;
  disposeBatch: (batch: PendingImage[]) => void;
  attachBatch: (itemId: string, batch: PendingImage[], space?: string) => Promise<number>;
  clear: () => void;
} {
  let held: PendingImage[] = [];
  // 复用保存态缩略图的样式(.img-thumb/.img-del),只是没有「图N」角标——编号要入库才有。
  const root = el("div", { className: "img-strip img-pending empty" });

  function sync(): void {
    root.classList.toggle("empty", held.length === 0);
    opts.onChange?.();
  }

  function add(blob: Blob): void {
    const url = URL.createObjectURL(blob);
    const img = el("img", { className: "img-thumb-img", src: url, title: "点击放大" });
    img.addEventListener("click", () => {
      if (opts.openPreview) opts.openPreview(url, img.naturalWidth, img.naturalHeight);
      else openLightboxUrl(url);
    });
    const del = el("button", { className: "img-del", textContent: "×", title: "移除这张图" });
    const thumb = el("div", { className: "img-thumb" }, [img, del]);
    const entry: PendingImage = { blob, url, thumb };
    del.addEventListener("click", () => {
      URL.revokeObjectURL(url);
      thumb.remove();
      held = held.filter((p) => p !== entry);
      sync();
    });
    held.push(entry);
    root.append(thumb);
    sync();
  }

  function clear(): void {
    for (const p of held) URL.revokeObjectURL(p.url);
    held = [];
    root.replaceChildren();
    sync();
  }

  return {
    root,
    count: () => held.length,
    /** 在输入框上接管图片粘贴(文本粘贴放行)。composeBar 重建时对新框再 wire 一次即可。 */
    wire(area: HTMLTextAreaElement): void {
      area.addEventListener("paste", (e) => {
        const blob = imageFromPaste(e);
        if (!blob) return;
        e.preventDefault();
        add(blob);
      });
    },
    /** 把暂存图逐张挂到刚建好的条目上,随后清空暂存;返回挂失败的张数(fail-fast,调用方
     *  负责把失败数告诉用户——条目已存在,图可以去卡片编辑态重新粘贴)。 */
    // 「保存那刻」同步取批(codex P1 二审 H2):按下保存立即把 held 冻结带走并摘预览
    // ——创建 IPC 等待期间新粘贴的图属于下一条,绝不结算进旧条目。创建失败 putBack
    // 原样退回(thumb 未销毁,可重试);成功后 attachBatch 逐张挂上、按张计 failed。
    takeBatch(): PendingImage[] {
      const batch = held;
      held = [];
      for (const p of batch) p.thumb.remove();
      sync();
      return batch;
    },
    putBack(batch: PendingImage[]): void {
      // 原样恢复:旧批插回等待期间新粘贴的图**之前**,重试时「图N」次序不变(codex 三审)。
      held = [...batch, ...held];
      for (const p of [...batch].reverse()) root.prepend(p.thumb);
      sync();
    },
    disposeBatch(batch: PendingImage[]): void {
      // 空间已切走的失败批:不许追加进别的空间的预览区(codex 三审 H),revoke 即弃。
      for (const p of batch) URL.revokeObjectURL(p.url);
    },
    async attachBatch(itemId: string, batch: PendingImage[], space?: string): Promise<number> {
      let failed = 0;
      for (const p of batch) {
        try {
          await attachBlob(itemId, p.blob, space);
        } catch {
          failed += 1;
        }
      }
      for (const p of batch) URL.revokeObjectURL(p.url);
      return failed;
    },
    async attachAll(itemId: string): Promise<number> {
      // 兼容入口(捕获浮窗:mirrorSpace 保证保存期间空间不动、响应恒到达):
      // 同一套「先取批再挂」,失败图随批清走(可重粘)。
      const batch = held;
      held = [];
      for (const p of batch) p.thumb.remove();
      sync();
      let failed = 0;
      for (const p of batch) {
        try {
          await attachBlob(itemId, p.blob);
        } catch {
          failed += 1;
        }
      }
      for (const p of batch) URL.revokeObjectURL(p.url);
      return failed;
    },
    clear,
  };
}

/** Wire a textarea so pasting an image attaches it (instead of dumping a path / nothing).
 *  Returns nothing; on a successful attach it calls `onAttached` (refresh the strip). A
 *  paste with no image falls through to normal text paste. */
export function wirePasteToAttach(
  area: HTMLTextAreaElement,
  itemId: string,
  onAttached: (meta: ImageMeta) => void,
  onError: (e: unknown) => void,
): void {
  area.addEventListener("paste", (e) => {
    const blob = imageFromPaste(e);
    if (!blob) return; // plain text paste — let it happen
    e.preventDefault();
    attachBlob(itemId, blob).then(onAttached).catch(onError);
  });
}

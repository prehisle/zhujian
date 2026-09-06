// 看大图遮罩窗(第三个窗口壳,606 起)——**它自己就是那层全屏遮罩**。
//
// 为什么是独立窗口(用户 2026-09-06 拍板):遮罩 `position:fixed` 铺满的是**窗口**不是屏幕。
// 138 为此把主窗撑成「图原尺寸 + 边距」、605 改成把主窗切全屏 —— 两者都在**动一个用户没让你
// 动的东西**(用户报:看一张横条截图,主窗被拉成又宽又矮;换全屏之后仍然是「主窗自己变了」)。
// ⇒ 606 起主窗一个字节不动:遮罩是一只常驻隐藏的无边框透明置顶窗,开图那刻铺满**当前显示器**
// 再 show,关图 hide 并把焦点还给开图的那个窗。
//
// ⛔ **别把窗口几何算在这一侧**:哪块显示器是开图那个窗说了算(它调 `currentMonitor()` 把
// 物理矩形随事件送过来),本窗只负责照着摆。自己去查 `currentMonitor()` 会落到「本窗上次在
// 的那块屏」,双屏下就摆错屏。
//
// 载荷两形(`item-images.ts` 那侧发,`LightboxOpen`):
//   ①`saved` —— 已入库的图,只送 `{spaceId, images[], index}`,字节由本窗自己 `get_item_image`;
//   ②`data`  —— 还没入库的暂存图(compose / 捕获窗),object URL 跨不了窗,故送 data URL。
//     ⚠ 那份 base64 与保存时 `attachBlob` 过 IPC 的是同一个量级,不是本轮新引入的开销。
import { invokeInSpace } from "./space";
import { t, initLang } from "./i18n";
import { flashToast } from "./toast";
import { isTabKey } from "./keys";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow, Window } from "@tauri-apps/api/window";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { writeImage } from "@tauri-apps/plugin-clipboard-manager";
import { Image as ShellImage } from "@tauri-apps/api/image";
import {
  type ImageMeta,
  type LightboxOpen,
  type MonitorRect,
  LIGHTBOX_OPEN,
  LIGHTBOX_PING,
  LIGHTBOX_READY,
} from "./lightbox-msg";
import "./lightbox.css";
import { el } from "./dom";

// 与 item-images.ts 那份同源的小 DOM helper(两个模块各留一份、互不 import:遮罩窗
// 只该拖进它真正用得上的东西,`item-images.ts` 拖着的是整条配图 / 粘贴 / 草稿依赖链)。
// 全尺寸缓存:只留最近看过的一张(换图即顶掉旧的 → 至多 1 张全尺寸常驻)。缓的是**已到手
// 的字符串**不是 Promise —— 163③ 的教训:缓 Promise 会把「跨空间迟到 = 永不决议」永久钉进表。
let lastFull: { id: string; url: string } | null = null;

/** 全尺寸字节 → data URL。命中「刚看过那张」秒回,否则取回并顶掉旧的。 */
function getFullImage(spaceId: string, imageId: string): Promise<string> {
  if (lastFull && lastFull.id === imageId) return Promise.resolve(lastFull.url);
  return invokeInSpace<string>(spaceId, "get_item_image", { imageId }).then((url) => {
    lastFull = { id: imageId, url }; // 旧 url 无人引用即可回收(至多留 1 张全尺寸)
    return url;
  });
}

// 看图时 Ctrl+C 复制整张图(223)。剪贴板写图在 Chromium/WebView2 只保证认 image/png,
// 而库里存的可能是 jpeg/webp/gif,故一律过 canvas 重绘成 PNG 再写——不是转码洁癖,是不转
// 就写不进去。已知折损:GIF 动图只得当前帧(canvas 取不到动画),透明 PNG 走 canvas 保 alpha。
// 走的是 <img> 已解码的像素,不重新取字节(全尺寸图本就在眼前这张 img 上)。
async function copyImageToClipboard(img: HTMLImageElement): Promise<void> {
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("canvas 2d 上下文不可用");
  ctx.drawImage(img, 0, 0);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
  if (!blob) throw new Error("图片编码失败");
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  } catch (webErr) {
    // Linux 真机(progress-log 394):WebKitGTK 的异步剪贴板**只认文本**,写图恒
    // `NotAllowedError`(真按键、有用户手势也一样)——那条路上用户拿到的是「复制失败」。
    // 退到壳的剪贴板插件(Rust 侧 arboard)把同一张图交给系统剪贴板。不是兜底默认值:
    // 它是另一条真机制,两条都不成才失败,而失败照旧响亮(调用方的 copyFail 回执)。
    // Windows/mac 上第一条本就成功,永远走不到这里(生产端行为一字不变)。
    // 交的是**canvas 的原始 RGBA**,不是上面那份 PNG 字节:插件的 writeImage 只认 RGBA
    // (喂 PNG 字节报「expected RGBA image data」),而由 PNG 字节造 Image 的
    // `Image.fromBytes` 要 tauri 的 `image-png` feature —— 用 RGBA 两样都不欠。
    try {
      const rgba = ctx.getImageData(0, 0, c.width, c.height).data;
      await writeImage(await ShellImage.new(new Uint8Array(rgba.buffer), c.width, c.height));
    } catch (shellErr) {
      throw new Error(`剪贴板写图失败(web:${String(webErr)} / shell:${String(shellErr)})`);
    }
  }
}

/** Mount a full-window overlay around `inner`; click anywhere or press Esc closes it.
 *  `onClose` runs while the overlay is STILL up and is awaited before teardown —— 606 起那一步
 *  做的是**把本窗藏起来**,藏在遮罩仍铺着的时候发生,所以看不到一瞬间的空透明窗。
 *  焦点陷阱(a11y):开图即把焦点移进遮罩、Tab/Shift+Tab 焦点困在遮罩内转圈(别溜到背后被盖住
 *  的看板/灵感按钮上误触)。⚠ 606 起「打开前的元素」指的是**本窗内**的(遮罩是独立窗,
 *  背后那些按钮压根不在这个文档里);把焦点还给开图那个**窗**是 dismiss() 干的事。 */
function mountLightbox(
  inner: HTMLElement,
  onClose?: () => void | Promise<void>,
  onNav?: (delta: -1 | 1) => void,
): { overlay: HTMLElement; close: () => Promise<void> } {
  const overlay = el("div", { className: "img-lightbox" }, [inner]);
  overlay.tabIndex = -1; // 让遮罩自身可聚焦:遮罩内无可聚焦子元素时,焦点有个「家」落回这里
  const prevFocus = document.activeElement as HTMLElement | null; // 关闭后把焦点还回原处
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return; // a click + Esc race shouldn't run teardown twice
    closing = true;
    try {
      await onClose?.();
    } finally {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      prevFocus?.focus?.(); // 焦点还给打开前的元素,不留在已摘除的遮罩上(读屏/键盘不迷路)
    }
  };
  // Tab 焦点陷阱:遮罩内通常没有可聚焦子元素(只有图+文字),故 Tab 一律钉回遮罩自身;若日后加了
  // 按钮等可聚焦项,则在首/末之间环绕——焦点始终困在遮罩内,不落到背后被盖住的界面上。
  const trapTab = (e: KeyboardEvent): void => {
    const focusable = Array.from(
      overlay.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusable.length === 0) {
      e.preventDefault();
      overlay.focus({ preventScroll: true });
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !overlay.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || !overlay.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  };
  // 遮罩底部中央的一次性回执(z 抬到遮罩之上,否则被 9000 层盖住看不见)。
  const toast = (text: string): void =>
    flashToast(window.innerWidth / 2, window.innerHeight - 20, text, { extraClass: "on-lightbox" });
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    // Ctrl/Cmd+C:把眼前这张图复制到剪贴板。遮罩内没有可选文本,这个键位空着。
    if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C")) {
      e.preventDefault();
      if (e.repeat) return; // 按住不放不重复编码整张图
      const shown = overlay.querySelector<HTMLImageElement>("img.img-lightbox-img");
      if (!shown || shown.naturalWidth === 0) return; // 还没解码出来 / 已换成失败面:不假装复制
      copyImageToClipboard(shown).then(
        () => toast(t("itemImages.copiedImage")),
        () => toast(t("itemImages.copyFail")), // 写剪贴板被拒要响亮,别静默(与 clipboard.ts 同纪律)
      );
      return;
    }
    // ←/→ 在同条目的整组图内翻页(只有多图时 onNav 才在,单图这两键照旧无义)。
    if (onNav && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      onNav(e.key === "ArrowLeft" ? -1 : 1);
      return;
    }
    if (isTabKey(e)) trapTab(e);
  };
  overlay.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.append(overlay);
  overlay.focus({ preventScroll: true }); // 开图即把焦点移进遮罩,Tab 从此在内部转圈
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
  // ms:单击关闭的延迟。旧值 500 是照「系统双击判定」定的,白等半秒(用户报「点了图关不掉、卡」);
  // 但把它一味砍短是拿**双击容错**换的——安卓真机实测:延迟砍到 200ms 后,两次按下间隔 226ms
  // 的双击第一击就把图关了,第二击落在空处(想放大却关了图)。系统标准的双击窗口是 300ms
  // (Android)/500ms(Windows),所以这里回到 300 老实覆盖它。
  // **速度感另有出路**:点下去立刻给遮罩挂 `.closing` 开始淡出(setClosing),延迟这段就不再是
  // 一段静止的白等——用户读成「卡」的是「点了没反应」,不是「没立刻消失」。第二击一按下就
  // clearTimeout + 摘 class,淡出被平滑拉回,双击照常放大。
  const CLICK_DELAY = 300;
  let mode: "fit" | "fill" = "fit"; // fill = 铺满宽度、竖向可滚
  let zoom = 1; // 在 mode 基准尺寸上再乘的缩放(Ctrl+滚轮)
  let userToggled = false; // 用户双击切过取向后,resize 不再自动改 mode
  let dragged = false;
  let closeTimer: number | null = null;

  const scroller = (): HTMLElement | null => img.closest<HTMLElement>(".img-lightbox");
  // 关闭中的淡出开关(246):只淡内容、黑底留着(缩窗要在暗遮罩下发生);撤销时摘掉即平滑拉回。
  const setClosing = (on: boolean): void => {
    scroller()?.classList.toggle("closing", on);
  };
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
      // 大图开着时 Ctrl+滚轮**归大图**:必须连冒泡一起掐掉(244 复扫)。241 的界面字号缩放
      // 挂在 document 上、同样只看 ctrlKey,只 preventDefault 拦不住冒泡——两处会同时缩,
      // 图缩一档、整个界面字号也被静默改一档还写进 localStorage(关掉大图回不去、重启还在),
      // 而回执 badge 被遮罩盖住看不见,用户只会觉得「字怎么变了」。
      e.stopPropagation();
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
        setClosing(false); // 双击撤销待关:淡到一半的内容平滑回来
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
        setClosing(false); // 连带把淡出拉回来(246)
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
      setClosing(true); // 立刻开始淡出 = 立刻有回执(246);延迟这段不再是静止的白等
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

/** 关闭第一步:把遮罩里的**内容**卸干净,只留纯黑底。遮罩本体还盖着,所以不会露裸窗。
 *  为什么单拎一步:关闭要先把窗口从全屏退回原来的几何,而那一下会让 WebView 把整个
 *  窗口重排重绘一遍——此刻若全尺寸位图还挂在遮罩里,它得陪着一起重绘;偏偏遮罩要等
 *  restore 跑完才撤,这一段全发生在用户「已经想关了」之后、且零反馈(用户报的「关闭好卡」
 *  的第二段,第一段是单击延迟)。先卸再退,退的是一屏纯色。
 *  `removeAttribute("src")` 而非 `src=""`:后者在部分 WebView 里会当相对 URL 去重新请求
 *  当前页;移掉属性才是干净地断掉对那份 data URL 的引用,位图可即刻回收。 */
function shedVisuals(overlay: HTMLElement, img: HTMLImageElement): void {
  img.removeAttribute("src");
  overlay.replaceChildren(); // stage / 左右箭头 / 角标一并撤走
}

/** 铺满显示器之后,WebView 的视口不是同一帧就跟上的(WM_SIZE → webview 重排 → JS 侧读数
 *  才变)。`viewer.init()` 若用旧视口布局,亮相后会被迟到的 resize 再排一次 —— 尺寸可见地
 *  跳一记(163 的契约,超高图最显眼)。这里等视口真到达**期望的 CSS 尺寸**再放行。
 *  ⚠ 判据刻意不是「离开原尺寸」(605 那一版的形):遮罩窗第二次开图时几何本来就已经对了,
 *  「等它变」会每次白等到超时。期望值 = 显示器物理尺寸 ÷ dpr(本窗没有页面缩放,dpr 即缩放比)。
 *  600ms 兜底 —— setSize 被拒/无效时视口永不到位,超时按当前视口布局(不更糟)。 */
function awaitViewport(mon: MonitorRect, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let stable = 0;
    const tick = (): void => {
      if (signal.aborted) return resolve();
      const dpr = window.devicePixelRatio || 1;
      const okW = Math.abs(window.innerWidth - mon.w / dpr) <= 2;
      const okH = Math.abs(window.innerHeight - mon.h / dpr) <= 2;
      if (okW && okH) {
        stable += 1;
        if (stable >= 2) return resolve();
      } else stable = 0;
      if (performance.now() - t0 > 600) return resolve();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

// ---- 窗口本体:常驻隐藏,开图铺满显示器再 show,关图 hide ------------------------
const selfWin = getCurrentWindow();
/** 当前开着的那一层(遮罩 + 它的 close);再来一条开图请求时先把它悄悄拆掉。 */
let active: { close: () => Promise<void> } | null = null;
/** 开图那个窗:关图把焦点还给它(否则焦点落在一只已隐藏的窗上,用户要多点一下)。
 *  ⭐ **句柄在开图那一侧就取好**,不留到关图路径上现查 —— `Window.getByLabel` 底下是一趟
 *  `getAllWindows` IPC,而关图那条路是用户读成「卡」的那一段(246 为此专门做过感知补偿):
 *  606 第一版把它放在关图里,验收资产量到 `closeMs` 从 ~400 涨到 **486**(阈值 500)。 */
let openerWin: Window | null = null;

/** 摆到那块显示器上并显形。⛔ 显示器由发信方量(见 lightbox-msg 的 MonitorRect);
 *  量不到(mon 为 null)就保持本窗当前几何 —— 看得成图,只是不铺满。 */
async function present(mon: MonitorRect | null): Promise<void> {
  if (mon) {
    await selfWin.setPosition(new PhysicalPosition(mon.x, mon.y));
    await selfWin.setSize(new PhysicalSize(mon.w, mon.h));
  }
  await selfWin.show();
  await selfWin.setFocus();
}

/** 收工:先隐窗再撤 DOM(反过来会露出一瞬间的空透明窗),然后把焦点还给开图那个窗。 */
async function dismiss(): Promise<void> {
  active = null;
  try {
    await selfWin.hide(); // ⭐ 这一步必须等:遮罩还铺着的时候藏窗,才不会露出一瞬间的空透明窗
  } catch {
    /* 藏不掉是真事故(置顶窗会一直盖着屏幕),但这里没有比「照常撤 DOM」更好的处置 */
  }
  // 还焦**不挡关闭路径**:窗已经藏了,用户此刻看不到这一步,没有理由让它加进「关得快不快」里。
  void openerWin?.setFocus().catch(() => {});
}

/** 已入库的一组图:字节由本窗自己取(全尺寸 base64 不过事件)。
 *  **224 的组内翻页原样保留**:>1 张时 ←/→ 与左右箭头在组内循环,角标显「图N · i/共」;
 *  只一张时按钮与角标都不挂。翻页**不碰窗口几何** —— 窗口开图那刻就摆好了。 */
function renderSaved(spaceId: string, images: ImageMeta[], index: number, mon: MonitorRect | null): void {
  if (images.length === 0) return; // 没图可看:不挂空遮罩
  const multi = images.length > 1;
  let cur = Math.min(Math.max(index, 0), images.length - 1);
  let gen = 0; // 换图代次:翻得快时迟到的字节/解码不许盖住新的那张(同安卓 viewerSeq)
  const img = el("img", { className: "img-lightbox-img", alt: t("itemImages.badge", { n: images[cur].seq }) });
  // 取字节/解码/定窗期间的加载指示(§3.7 审计 #14):CSS 延迟淡入,快路径(命中「刚看过」的
  // 全尺寸缓存)一闪而过时不露脸;init 前 remove,showError 的 replaceChildren 也会带走它。
  const loading = el("div", { className: "img-lightbox-loading", textContent: t("itemImages.loading") });
  const stage = el("div", { className: "img-lightbox-stage" }, [loading, img]);
  let closed = false;
  const viewer = makeImageViewer(img, () => close());
  const { overlay, close } = mountLightbox(
    stage,
    async () => {
      closed = true; // 关标志:让下面异步流(invoke/load)每个 await 后止步
      viewer.cleanup(); // 摘缩放/滚动监听(含 window resize),不泄漏 img
      shedVisuals(overlay, img); // 先卸大图、只留黑底,再去隐窗(见 shedVisuals)
      await dismiss();
    },
    multi ? (delta) => void show((cur + delta + images.length) % images.length, false) : undefined,
  );
  active = { close };
  const showError = (): void => {
    if (closed) return;
    viewer.cleanup();
    overlay.replaceChildren(el("div", { className: "img-lightbox-err", textContent: t("itemImages.loadFail") }));
  };
  // 组内导航件(只在多图时存在):左右箭头 + 「图N · i/共」角标。都 position:fixed 钉在视口,
  // 放大图后拖着滚时不跟着跑。按钮的 click 必须 stopPropagation——遮罩自身的 click 是「关闭」。
  const counter = multi ? el("div", { className: "img-lightbox-count" }) : null;
  const navBtn = (dir: -1 | 1): HTMLButtonElement => {
    const b = el("button", {
      className: `img-lightbox-nav ${dir < 0 ? "prev" : "next"}`,
      textContent: dir < 0 ? "‹" : "›",
      title: dir < 0 ? t("itemImages.prev") : t("itemImages.next"),
    });
    b.addEventListener("click", (e) => {
      e.stopPropagation(); // 别冒泡到遮罩的「点背景关闭」
      void show((cur + dir + images.length) % images.length, false);
    });
    return b;
  };
  if (multi && counter) overlay.append(navBtn(-1), navBtn(1), counter);

  /** 呈现第 i 张。`first`=开图那次(要等视口铺满);换图那次只重新解码 + 重排。 */
  async function show(i: number, first: boolean): Promise<void> {
    if (closed) return;
    const my = ++gen;
    cur = i;
    const m = images[cur];
    img.alt = t("itemImages.badge", { n: m.seq });
    if (counter) counter.textContent = t("itemImages.counter", { n: m.seq, i: cur + 1, total: images.length });
    if (!first) {
      // 换图:先隐去旧图(否则新图按旧尺寸闪一下再重排)、把加载指示放回去——与「布局未定
      // 不显示」同纪律,定形后由 viewer.init() 一次成形亮相。
      img.style.visibility = "hidden";
      if (!loading.isConnected) stage.prepend(loading);
    }
    try {
      const src = await getFullImage(spaceId, m.id);
      if (closed || my !== gen) return;
      // 解码拿到自然尺寸,布局才有依据。load 监听走 viewer.signal:关闭时随 cleanup 一起摘、
      // 并由 abort 事件让本 Promise 必定 settle(M5)。已经是这张(翻回刚看过的一张、或两张
      // 字节相同)则不重新等 load——同 src 不再触发 load 事件会永久挂起。
      if (!(img.src === src && img.complete && img.naturalWidth > 0)) {
        await new Promise<void>((resolve) => {
          img.addEventListener("load", () => resolve(), { once: true, signal: viewer.signal });
          img.addEventListener("error", () => resolve(), { once: true, signal: viewer.signal });
          viewer.signal.addEventListener("abort", () => resolve(), { once: true });
          img.src = src;
        });
        if (closed || my !== gen) return;
      }
      if (img.naturalWidth === 0) {
        showError(); // 解码失败:明确失败 UI + 立刻 cleanup,别留空白遮罩(M5)
        return;
      }
      if (first && mon) {
        await awaitViewport(mon, viewer.signal); // 视口真铺满再布局,亮相后不再被迟到 resize 重排
        if (closed || my !== gen) return;
      }
      loading.remove();
      viewer.init(); // 视口已定 → 挑取向 + 布局一次 + 亮相
    } catch {
      showError();
    }
  }

  void show(cur, true);
}

/** 还没入库的暂存图(compose / 捕获窗):字节以 data URL 随事件送来,本窗不查库。 */
function renderData(src: string, alt: string, mon: MonitorRect | null): void {
  const img = el("img", { className: "img-lightbox-img", alt });
  const loading = el("div", { className: "img-lightbox-loading", textContent: t("itemImages.loading") });
  const stage = el("div", { className: "img-lightbox-stage" }, [loading, img]);
  let closed = false;
  const viewer = makeImageViewer(img, () => close());
  const { overlay, close } = mountLightbox(stage, async () => {
    closed = true;
    viewer.cleanup();
    shedVisuals(overlay, img);
    await dismiss();
  });
  active = { close };
  const showError = (): void => {
    if (closed) return;
    viewer.cleanup();
    overlay.replaceChildren(el("div", { className: "img-lightbox-err", textContent: t("itemImages.loadFail") }));
  };
  void (async () => {
    try {
      // src 已就绪(data URL),但大截图仍要解码——等 load 拿到自然尺寸再走(图此刻隐形,不闪)。
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
      if (mon) {
        await awaitViewport(mon, viewer.signal);
        if (closed) return;
      }
      loading.remove();
      viewer.init();
    } catch {
      showError();
    }
  })();
}

// ---- 装配:一条事件进来 = 开一次图 ---------------------------------------------
// ⚠ 先 present(摆位 + show)再渲染:用户点下缩略图那刻就该看见暗下来的一屏,而不是
// 等字节取回来窗口才蹦出来(遮罩这层的存在意义之一就是「立刻有回执」)。
initLang();
void (async () => {
  await listen<LightboxOpen>(LIGHTBOX_OPEN, (e) => {
    const p = e.payload;
    void (async () => {
      if (active) await active.close().catch(() => {}); // 上一层还开着(理论上不该):先悄悄拆掉
      openerWin = await Window.getByLabel(p.from).catch(() => null); // 关图要用,现在就取好(见 openerWin)
      await present(p.monitor);
      if (p.kind === "saved") renderSaved(p.spaceId, p.images, p.index, p.monitor);
      else renderData(p.src, p.alt, p.monitor);
    })();
  });
  // ⭐ **顺序是承重的**:先把开图 listener 装好,再宣布在场 —— 反过来的话发信方收到「我在了」
  // 就发开图,而那一刻这边还没人收。答 ping 那支同理,装在宣布之前。
  await listen(LIGHTBOX_PING, () => void emit(LIGHTBOX_READY));
  await emit(LIGHTBOX_READY); // 主动广播一次:发信方那侧多半已经在听了,省掉一轮 ping
})();

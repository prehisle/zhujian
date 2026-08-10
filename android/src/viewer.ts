// 大图查看器:全屏覆盖层。未放大时单击关(200ms 让位双击判定)、双击 2.5 倍/复位、
// 双指捏合 1~8 倍、放大后单指拖拽平移、返回键关(history 层)。全图每次打开现取
// (IPC 去重内已并单),关闭即置空 src——大图字节不驻留。请求带代次(codex 二审):
// 快速连点几张图,迟到的旧响应不许盖掉最新点击;关闭也推代次,在途响应作废不复弹。
// 310 第③笔:自 main.ts 纯搬迁成模块(initX(Deps) 的形,事件在 initViewer 里挂;
// 返回键层账本仍住 main.ts,经 Deps 注入——comments.ts 同形),行为零改动。
import { deleteItemImage, getCurrentSpace, type ImageMeta } from "./api";
import { t } from "./i18n";
import { fetchImageUrl } from "./thumbs";
import { $, confirmBar, hideConfirmBar, showBar, showError } from "./ui";

type Deps = {
  /** 返回键层账本(143):首开压一枚守门条目。 */
  pushLayer: () => void;
  /** UI 主动关层之后平掉那枚守门条目(popstate 关的层不许调)。 */
  settleHistory: () => void;
  /** 删图成功后的整轴重拉(main.ts 的 refresh,single-flight):缩略图随之消失。 */
  refresh: () => Promise<void>;
};

let deps: Deps;

let viewerSeq = 0;
let viewerImgId: string | null = null; // 当前大图的 image id(删图按钮据此删这张)
// 225:查看器收**同条目的整组图**,未放大时单指横滑翻页(左滑下一张、右滑上一张,首尾循环)。
// 组来自 lastItems 里那条的 images(时间轴本来就带下来,不另取);只一张时横滑不接管。
let viewerGroup: ImageMeta[] = [];
let viewerIdx = 0;

export function openViewer(group: ImageMeta[], idx: number) {
  viewerGroup = group;
  return showViewerAt(idx);
}

const SLIDE_MS = 180; // 与 applyTransform 里的 transform 0.18s 对齐
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
// 过场进行中不接新的翻页手势:否则新手势的跟手位移与在跑的飞出/滑入抢同一个 vSwipeX,
// 图会在半途被拽回来再跳走。一次过场只有 ~180ms + 取字节,锁掉这一小段比抖动强。
let flipping = false;

/** 设 src 并等它真解码完(或失败)。同 src 不再触发 load,故先短路——否则永远等不到。 */
function loadViewerImage(img: HTMLImageElement, url: string): Promise<void> {
  return new Promise((resolve) => {
    if (img.src === url && img.complete && img.naturalWidth > 0) return resolve();
    const done = (): void => {
      img.removeEventListener("load", done);
      img.removeEventListener("error", done);
      resolve();
    };
    img.addEventListener("load", done); // initViewer 挂的 load 监听先注册(开图前 init 已跑),故 vBase 此刻已量好
    img.addEventListener("error", done);
    img.src = url;
  });
}

/** 呈现组内第 i 张。`dir` = 翻页方向(0 = 开图,不走过场);+1 是「下一张」(旧图向左飞出、
 *  新图从右侧滑入),-1 反之。**不预载相邻图**——全尺寸 data URL 一律不缓存是 117 定下的
 *  内存红线(32MiB 级原图 base64 常驻会撑爆 WebView),所以飞出与滑入之间必然要现取一次;
 *  取字节与飞出并行发起,换图那一瞬图隐形,不让「旧图没走 / 新图没定位」露脸。 */
async function showViewerAt(i: number, dir: -1 | 0 | 1 = 0) {
  const my = ++viewerSeq;
  hideConfirmBar(); // 开大图/换图 = 放弃挂着的两拍确认(确认条 z 在查看器之上,别浮在图上;
  // 且旧确认针对的是上一张)
  const m = viewerGroup[i];
  if (!m) return;
  // 光标**同步**推进(不等字节回来):连划两下要真翻两张——若等 await 后再记,第二下
  // 还从旧位置起算,两下只翻一张。而 viewerImgId(删图按钮的依据)仍等字节落定才改:
  // 那枚必须永远指着**屏幕上真显示的**那张。
  viewerIdx = i;
  const space = getCurrentSpace(); // 点击那一刻的空间(切走后 fetchImageUrl 返 null 即弃)
  const img = $("viewer-img") as HTMLImageElement;
  // 取不到字节就把飞出去的旧图弹回来 + 亮错误条,别留一屏空黑。
  const abortSlide = (): void => {
    if (dir === 0) return;
    vSwipeX = 0;
    img.style.visibility = "";
    applyTransform(true);
  };
  const bytes = fetchImageUrl(space, m.id); // 与飞出动画并行跑,不串行等
  if (dir !== 0) flipping = true; // 过场期间手势闸(同轮只有一次过场,故清标不会踩到别人)
  try {
    if (dir !== 0) {
      vSwipeX = -dir * window.innerWidth; // 顺着手势方向送出屏外
      applyTransform(true);
      await sleep(SLIDE_MS);
      if (my !== viewerSeq) return; // 已被更新的一次翻页接管:位置交给它管
    }
    const url = await bytes;
    if (my !== viewerSeq) return;
    if (!url) {
      abortSlide(); // 空间已切走
      return;
    }
    viewerImgId = m.id; // 现显的这张(删图按钮据此),迟到响应被 my!==viewerSeq 挡在上面
    if (dir !== 0) img.style.visibility = "hidden"; // 先隐,免得 resetZoom 把旧图瞬移回中心
    resetZoom(); // 换图不继承上一张的缩放(连带清 vSwipeX)
    await loadViewerImage(img, url);
    if (my !== viewerSeq) return;
    img.alt = t("images.imageN", { n: m.seq }); // 读屏语义与角标同源
    // 多图时角标兼作「还有几张」的读数(手机上没有左右箭头,这是唯一的组内位置提示)。
    $("viewer-cap").textContent =
      viewerGroup.length > 1
        ? t("viewer.badgeOfN", { n: m.seq, i: i + 1, total: viewerGroup.length })
        : t("images.imageN", { n: m.seq });
    if (dir !== 0) {
      vSwipeX = dir * window.innerWidth; // 瞬移到另一侧屏外(同一帧里连同亮相一起提交)
      applyTransform(false);
      img.style.visibility = "";
      requestAnimationFrame(() => {
        if (my !== viewerSeq) return;
        vSwipeX = 0;
        applyTransform(true); // 滑入
      });
    }
    if ($("viewer").hidden) {
      $("viewer").hidden = false;
      deps.pushLayer();
    }
  } catch (err) {
    if (my !== viewerSeq) return;
    abortSlide();
    showError(String(err));
  } finally {
    flipping = false;
  }
}

export function closeViewerNow() {
  viewerSeq++; // 在途的打开请求作废
  viewerImgId = null;
  viewerGroup = [];
  viewerIdx = 0;
  hideConfirmBar(); // 关图即弃挂着的删图确认(旧确认不许作用到下一张/下个语境)
  window.clearTimeout(closeTimer); // 返回键/删图这些路子关层时,可能还挂着一枚待关
  setClosing(false); // 必须摘:留着的话下次开图整层还是 opacity:0(图在、看不见)
  $("viewer").hidden = true;
  ($("viewer-img") as HTMLImageElement).src = ""; // 释放大图
  resetZoom();
}

// -- 查看器手势(143):transform = translate(t) scale(s),原点为 img 布局中心。
// 页面级缩放已在 viewport 锁死,这里自己接管指针;基座矩形在每轮手势起点量(244,见 measureBase)。
// 捏合公式:中点下的图像点保持在中点下。
const viewerImgEl = $("viewer-img") as HTMLImageElement;
let vScale = 1;
let vTx = 0;
let vTy = 0;
let vBase = { cx: 0, cy: 0, w: 0, h: 0 };
// 翻页横移(227):与 vTx 分家——vTx 是放大后的平移(要过 clampView 钳位),vSwipeX 是
// 翻页手势与过场动画的横向位移,不受钳位、也不算进 identity(跟手拖动中不该把角标淡掉)。
let vSwipeX = 0;
let suppressClick = false; // 手势(捏合/拖拽)收尾时 WebView 可能补发 click:吞掉
let closeTimer: number | undefined;
// 轻点关的延迟(246)。**别再往下砍**:真机实测砍到 200ms 后,两次按下间隔 226ms 的双击第一击
// 就把图关了、第二击落在空处(想放大却关了图);系统标准的双击窗口就是 300ms,老实覆盖它。
// 「点了没反应」的手感问题由 setClosing 的即时淡出解决,不靠缩短这个数。
const CLOSE_DELAY = 300;
/** 关闭中的淡出开关:点下去立刻淡、第二击一按下就摘掉(transition 平滑拉回)。 */
function setClosing(on: boolean): void {
  $("viewer").classList.toggle("closing", on);
}
let lastTap = { t: 0, x: 0, y: 0 };

function applyTransform(anim = false) {
  // identity 按「肉眼等同」判,不按严格零(226):双击复位把三个量清零后还要过 clampView,
  // 而 clampView 对小于视口的图恒把位置钉到几何中点——vBase 的中心与视口中心差个零点几像素
  // 就留下 vTy≈-0.6 的余量,严格 `=== 0` 于是判不出复位。后果不止「图N」角标不回来:
  // `.zoomed` 还给删除按钮挂着 `opacity:0; pointer-events:none`(index.html),
  // 也就是放大再复位后那张图**删不掉了**,要关掉重开才恢复。
  const identity = Math.abs(vScale - 1) < 0.005 && Math.abs(vTx) < 1 && Math.abs(vTy) < 1;
  viewerImgEl.style.transition = anim ? "transform 0.18s ease-out" : "";
  viewerImgEl.style.transform =
    identity && vSwipeX === 0 ? "" : `translate(${vTx + vSwipeX}px, ${vTy}px) scale(${vScale})`;
  // 放大/拖动中「图N」角标是噪音,且 transform 不改布局、放大后必与图重合:淡出,复位再现。
  $("viewer").classList.toggle("zoomed", !identity);
}

function resetZoom() {
  vScale = 1;
  vTx = 0;
  vTy = 0;
  vSwipeX = 0;
  viewerImgEl.style.transition = "";
  viewerImgEl.style.transform = "";
  $("viewer").classList.remove("zoomed");
}

/** 量「基座矩形」= 图片**未变换时**的布局盒(clampView 的钳位框与捏合的原点),在每轮
 *  手势起点量。
 *  244:原先在 img 的 load 里量,而首开那一刻查看器还 hidden(showViewerAt 要等图解码完
 *  才 unhide,225/226 起如此),`[hidden]{display:none!important}` 的元素量出来是零盒;
 *  于是一捏合/双击,clampView 见 w=h=0 就走「比视口小的轴回中」把图钉到
 *  (innerWidth/2, innerHeight/2)——用户看到的「一放大就飞到右下角、复位也回不来」。
 *  **两道闸都问渲染态,不问 JS 变量**(244 二轮:只问 JS 变量会从另外两扇门漏回同一个患):
 *  ① computed transform 必须是 none——翻页滑入/没划够的弹回都挂着 0.18s 过场,那段时间
 *     vScale/vTx/vTy/vSwipeX 早已归零、图却还在半路上,rect 量的是动画中途的盒(滑入那下
 *     最多偏整个屏宽);「有没有在飞的变换」只有 computed 值答得准。
 *  ② 零盒一律不收——换图时 src 刚换、图没解码完,`#viewer img` 没有显式宽高会塌成 0×0
 *     (`flipping` 闸只拦单指 pointermove,拦不住 pointerdown),那正是 244 的病根形状。
 *     宁可留着上一轮的量值,等下一轮手势重量,也绝不把零盒记进钳位框。 */
function measureBase(): void {
  if (getComputedStyle(viewerImgEl).transform !== "none") return; // 图上挂着变换/过场在飞
  const r = viewerImgEl.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return; // 没解码 / 没显出来:这不是布局盒
  vBase = { cx: r.x + r.width / 2, cy: r.y + r.height / 2, w: r.width, h: r.height };
}

/** 出界钳位:图比视口大时不许拖出黑边,比视口小的轴回中。 */
function clampView() {
  vScale = Math.min(8, Math.max(1, vScale));
  const hw = (vBase.w * vScale) / 2;
  const hh = (vBase.h * vScale) / 2;
  const cl = (lo: number, hi: number, v: number) =>
    lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v));
  vTx = cl(window.innerWidth - vBase.cx - hw, hw - vBase.cx, vTx);
  vTy = cl(window.innerHeight - vBase.cy - hh, hh - vBase.cy, vTy);
}

const vPtrs = new Map<number, { x: number; y: number }>();
let gest: { s: number; tx: number; ty: number; d0: number; mx: number; my: number } | null = null;

function beginGesture() {
  measureBase(); // 手势起点量基座(渲染态干净才收;首开时 load 那一刻查看器还没显出来,量不得)
  const ps = [...vPtrs.values()];
  const mx = ps.reduce((a, p) => a + p.x, 0) / ps.length;
  const my = ps.reduce((a, p) => a + p.y, 0) / ps.length;
  const d0 = ps.length >= 2 ? Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y) : 0;
  gest = { s: vScale, tx: vTx, ty: vTy, d0, mx, my };
}

// 横滑翻页(225 引入,227 改跟手):拖动中图就跟着手指走,**松手才判翻不翻**——原先是
// 「越过阈值瞬间换图」,手指还在屏上、屏幕先跳一下,用户报「死板、没有过渡」。
// 定性只做一次(swipeAxis 闩住):走够 8px 时看横竖谁占优,横向压过竖向 1.2 倍才接管,
// 之后整轮手势不再改判(免得斜划到一半突然从跟手变不跟手)。
// 阈值随屏宽走(至少 48px / 至多屏宽 18%):跟手之后有了视觉反馈,阈值可以比「盲翻」时更实。
const swipeThreshold = (): number => Math.max(48, window.innerWidth * 0.18);
let swipeAxis: "" | "x" | "no" = "";

/** 松手结算:过阈值就翻页(走过场动画),否则弹回原位。 */
function settleSwipe() {
  const dx = vSwipeX;
  swipeAxis = "";
  const n = viewerGroup.length;
  if (n > 1 && Math.abs(dx) > swipeThreshold()) {
    const dir = dx < 0 ? 1 : -1; // 左滑 = 下一张
    void showViewerAt((viewerIdx + dir + n) % n, dir);
    return;
  }
  vSwipeX = 0; // 没划够:弹回来(有回弹本身就是「我收到了你的手势」的回执)
  applyTransform(true);
}

const viewerPtrEnd = (e: PointerEvent, cancelled = false) => {
  vPtrs.delete(e.pointerId);
  if (vPtrs.size) {
    beginGesture(); // 双指抬一指:剩下的手指重新起基准,不跳变
    return;
  }
  gest = null;
  if (swipeAxis !== "x") return;
  if (cancelled) {
    // 系统收走了手势(来电/通知栏下拉等):不当成翻页意图,弹回原位。
    swipeAxis = "";
    vSwipeX = 0;
    applyTransform(true);
    return;
  }
  settleSwipe();
};

/** 查看器开着没有——返回键处理器(main.ts)的判据,此前直查 $("viewer").hidden。 */
export function isViewerOpen(): boolean {
  return !$("viewer").hidden;
}

export function initViewer(d: Deps): void {
  deps = d;
  viewerImgEl.addEventListener("load", () => {
    resetZoom(); // 新图不继承上一张的缩放(基座矩形改在手势起点量,见 measureBase)
  });
  // 转屏(或任何视口尺寸变化)后,旧基座与新视口不是一个坐标系:把图复位回未变换态,基座
  // 交给下一轮手势重量。不复位的话,放大态下转屏 clampView 会拿旧基座算出个偏位,**双击也
  // 回不来**,applyTransform 的 identity 判据恒假连带 `.zoomed` 摘不掉——那条规则会把「删除」
  // 按钮永久 pointer-events:none,这张图就删不掉了(226 判例的后果从另一条门回来)。
  // 本机 WebView 弹键盘时 innerHeight 不缩、不发 resize(见 240),故不会误伤捕获层。
  window.addEventListener("resize", () => {
    if (!$("viewer").hidden) resetZoom();
  });
  $("viewer").addEventListener("pointerdown", (e) => {
    // 一按下就取消上一击挂着的「待关」+ 把淡出拉回来(照桌面 item-images.ts 的同名兜底)。
    // 注意这条**买到的余量很小**(只有「第二次按下 → 第二次 click」那十几毫秒),别拿它当
    // 缩短 CLOSE_DELAY 的依据——246 首版就是这么推理的,真机把账算清了:延迟必须自己覆盖
    // 双击窗口。它的真正用处是让第二击**更早**撤销淡出,双击时几乎看不到闪。
    window.clearTimeout(closeTimer);
    setClosing(false);
    if (vPtrs.size === 0) {
      suppressClick = false; // 新一轮手势:上一轮的抑制标志作废
      swipeAxis = "";
    }
    vPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    beginGesture();
  });
  $("viewer").addEventListener("pointermove", (e) => {
    if (!vPtrs.has(e.pointerId) || !gest) return;
    vPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const ps = [...vPtrs.values()];
    const mx = ps.reduce((a, p) => a + p.x, 0) / ps.length;
    const my = ps.reduce((a, p) => a + p.y, 0) / ps.length;
    if (ps.length >= 2) {
      const d = Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y);
      const ns = Math.min(8, Math.max(1, (gest.s * d) / (gest.d0 || d)));
      const vx = (gest.mx - vBase.cx - gest.tx) / gest.s;
      const vy = (gest.my - vBase.cy - gest.ty) / gest.s;
      vScale = ns;
      vTx = mx - vBase.cx - ns * vx;
      vTy = my - vBase.cy - ns * vy;
      suppressClick = true;
      if (vSwipeX !== 0 || swipeAxis === "x") {
        // 单指划到一半又落了第二根手指:这是要捏合,放弃这轮翻页并把图弹回原位。
        swipeAxis = "no";
        vSwipeX = 0;
      }
    } else if (vScale > 1.01) {
      vTx = gest.tx + (mx - gest.mx);
      vTy = gest.ty + (my - gest.my);
      if (Math.hypot(mx - gest.mx, my - gest.my) > 8) suppressClick = true;
    } else {
      // 未放大的单指拖拽:这条通道原本空着(既不平移也不缩放),拿来翻同条目的图——
      // **图跟着手指走**,松手才由 settleSwipe 判翻不翻。放大态仍归平移,那是看细节的手。
      if (viewerGroup.length < 2) return;
      if (flipping) {
        swipeAxis = "no"; // 过场跑着呢:这一轮手势整轮作废(别和动画抢 vSwipeX)
        return;
      }
      const dx = mx - gest.mx;
      const dy = my - gest.my;
      if (swipeAxis === "") {
        if (Math.hypot(dx, dy) < 8) return; // 还没走够,先不定性(轻点仍是「关图」)
        suppressClick = true; // 划过就不算点击(免翻完又把图关了)
        swipeAxis = Math.abs(dx) > Math.abs(dy) * 1.2 ? "x" : "no";
      }
      if (swipeAxis !== "x") return; // 这轮判成竖划:整轮都不接管,别中途改判
      vSwipeX = dx;
      applyTransform();
      return;
    }
    clampView();
    applyTransform();
  });
  $("viewer").addEventListener("pointerup", (e) => viewerPtrEnd(e));
  $("viewer").addEventListener("pointercancel", (e) => viewerPtrEnd(e, true));
  $("viewer").addEventListener("click", (e) => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    const now = Date.now();
    const dbl = now - lastTap.t < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40;
    if (dbl) {
      window.clearTimeout(closeTimer);
      setClosing(false); // 双击撤销待关:淡到一半的层平滑回来
      lastTap.t = 0;
      if (vScale > 1.01) {
        vScale = 1;
        vTx = 0;
        vTy = 0;
      } else {
        const vx = (e.clientX - vBase.cx - vTx) / vScale;
        const vy = (e.clientY - vBase.cy - vTy) / vScale;
        vScale = 2.5;
        vTx = e.clientX - vBase.cx - vScale * vx;
        vTy = e.clientY - vBase.cy - vScale * vy;
      }
      clampView();
      applyTransform(true);
      return;
    }
    lastTap = { t: now, x: e.clientX, y: e.clientY };
    if (vScale > 1.01) return; // 放大态单击不关(误触保护):双击复位或返回键关
    setClosing(true); // 立刻开始淡出 = 立刻有回执(246);延迟这段不再是静止的白等
    closeTimer = window.setTimeout(() => {
      closeViewerNow();
      deps.settleHistory();
    }, CLOSE_DELAY);
  });
  // 删图(196):看大图时删这张。永久销毁(图无回收站、编号退役不复用),两拍确认——
  // 确认条 z(17)在查看器(15)之上能盖住。stopPropagation 挡掉查看器自身的单击关/双击缩放。
  // onYes 复核「还在看这张、空间没换」(期间换图/关闭/切空间一律作废);删成关查看器 +
  // settleHistory(平掉开图压的历史层)+ 刷新轴(缩略图随之消失)。
  $("viewer-del").addEventListener("click", (e) => {
    e.stopPropagation();
    const id = viewerImgId;
    if (!id) return;
    const space = getCurrentSpace();
    confirmBar(t("viewer.deleteQ"), t("viewer.deleteYes"), () => {
      if (viewerImgId !== id || getCurrentSpace() !== space) return;
      void (async () => {
        try {
          await deleteItemImage(space, id);
          closeViewerNow();
          deps.settleHistory();
          await deps.refresh();
          showBar(t("viewer.deleted"), true);
        } catch (err) {
          showError(String(err));
        }
      })();
    });
  });
}

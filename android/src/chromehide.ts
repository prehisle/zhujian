// 手机横放时顶栏 + 筛选条随滚动收起 / 露出(890 立;用户在 889 装机试用后提「横屏高度不够,朱简行和标签行能不能隐藏、
// 需要时再显示」,选择题拍「往下划自动收,往上划露出」—— 同手机浏览器的地址栏)。
//
// 只在**矮屏**(宽屏 ∧ 不是高屏 = 手机横放,视口 360–412 高:顶栏 + 筛选条吃掉约 110)的时间轴上(随记 / 看板两面)做;
// 平板、手机竖放、开着面板时一律不收。判据挂在 body 的 `widescreen` / `tallscreen` / `pane-open` 三枚类上(main.ts 打的),
// ⛔ 别在这儿再判宽高。
//
// 收 / 露的判据:任一个滚动盒(整页 —— 随记;看板上某一列 —— 889 起列自己滚)往下滚累计过 HIDE_AFTER、且已离顶 MIN_Y = 收;
// 往上滚累计过 SHOW_AFTER、或滚回了顶 = 露。⚠ 一帧里跳过大半屏的那种不是手在划(切面还原位置、重画摆回列的位置、
// 「去看看」那类程序滚动)⇒ 只更新基线、不算数 —— 否则点完底栏「随记」,还原位置那一下就把刚点过的导航收走了。
// 看板横滚(#timeline 自己的 scrollLeft)不算。
//
// 收起时怎么腾地方(index.html「顶栏收起」那段):顶栏与筛选条按 `--chrome-shift`(收的那一刻量的:两样里靠下那条的下沿)
// 往上平移出屏;看板借一个负的上外边距长到状态栏下 8;随记是整页滚,平移就够了(内容本来就从它们底下过)。
// 筛着的时候屏顶留一条细条,写着筛的是什么(复用 #filter-sum 那句),点它露出 —— 别让「看着少了几张」变成猜谜。
//
// ⚠ 光靠 scroll 事件不够(892 用户真机:空列上往上划,顶栏不收):空列、短列、已经滚到头的列 / 整页**根本不发 scroll**。
// ⇒ 再挂一路手势兜底(时间轴上的触摸):竖着划过 GESTURE_PX、竖向占优,而手下那个滚动盒**在手指那个方向已经滚不动了**,
// 就按手指方向判 —— 往上推 = 收、往下拉 = 露;还滚得动的交给上面那条 scroll 路,两路不重复判。

const HIDE_AFTER = 24;
const SHOW_AFTER = 16;
const MIN_Y = 48;
const GESTURE_PX = 28;

let hidden = false;
/** 被叫回来之后这一小段时间不判收(见 showChrome)。 */
let quietUntil = 0;
let down = 0;
let up = 0;
const last = new WeakMap<object, number>();

/** 此刻允不允许收:手机横放的时间轴上(没开面板)。 */
export function canHide(): boolean {
  const b = document.body.classList;
  return (
    b.contains("widescreen") &&
    !b.contains("tallscreen") &&
    !b.contains("pane-open")
  );
}

export const chromeHidden = (): boolean => hidden;

/** 量要挪多远 → `--chrome-shift`:顶栏与筛选条里靠下那条**没挪时**的下沿(视口坐标;随记划到中段时筛选条吸在顶栏下,
 *  看板上它在原位)。⚠ 用 offsetTop / offsetHeight(布局位置,含吸顶偏移、不含 transform),⛔ 别用 getBoundingClientRect:
 *  收 / 露的 0.2 s 过渡里它读到的是半路的位置,再加回位移就挪成两倍(890 读数实撞:收起后顶栏在 −194 而不是 −97)。
 *  整数取上:差一像素就从屏顶漏一线。 */
function measureShift(): void {
  const bottom = (el: HTMLElement): number =>
    el.offsetTop + el.offsetHeight - window.scrollY;
  const head = bottom(document.querySelector<HTMLElement>("body > header")!);
  const bar = document.getElementById("filterbar")!;
  const fb = bar.hidden ? 0 : bottom(bar);
  document.documentElement.style.setProperty(
    "--chrome-shift",
    `${Math.ceil(Math.max(head, fb))}px`,
  );
}

function set(on: boolean): void {
  if (on === hidden) return;
  if (on) measureShift();
  hidden = on;
  // 收 / 露都会改看板的高 ⇒ 列的可滚范围跟着变,浏览器把越界的 scrollTop 夹回去也发 scroll —— 那不是手在划。
  // 不挡的话:列只比看板高出一点时,收 → 列变高、滚不动了、被夹回顶 →「滚回顶 = 露」→ 列变矮、惯性又往下 → 再收,
  // 来回抖(890 探针实撞,筛完只剩几张的那一列)。⇒ 过渡那 0.2 s 加一点余量,只更新基线、不判。
  quietUntil = Math.max(quietUntil, performance.now() + 350);
  document.body.classList.toggle("chrome-hidden", on);
  syncPeek();
}

/** 露出来并清掉累计(开面板、切面、换空间、转屏离开矮屏时调)。 */
export function showChrome(): void {
  down = 0;
  up = 0;
  // 叫回来的那几处(切面 / 关面 / 换空间 / 点细条)紧跟着都有程序还原滚动位置:切回随记还原到 132 那一下没过「大半屏」的阈值,
  // 照样被当成手在往下划、把刚点过的导航又收走(890 探针实撞)⇒ 之后 400ms 只更新基线、不判。
  quietUntil = performance.now() + 400;
  set(false);
}

/** 屏顶那条细条:收着、且(筛着 —— #filter-sum 露着 —— 或有看板切换排)才露。字 = 当前看板名(切换排在时;mbopt M11:
 *  收起后看不出眼前是哪块看板)· 那句筛选摘要(筛着时)。筛选 / 看板变了(main.ts::paintFilterSum,每次投影都调)也调一次。 */
export function syncPeek(): void {
  // 收着时筛选也会变(点卡上的标签胶囊就筛):筛选条多出 / 少了「筛出 N 条」那一行,高度变了,收起那一刻量的位移就不够,
  // 它的底边会从屏顶漏下来(890 截图实撞)⇒ 每次筛选变了重量一次。
  if (hidden) measureShift();
  const peek = document.getElementById("chrome-peek")!;
  const sum = document.getElementById("filter-sum")!;
  // 切换排只在任务面 ∧ 有 ≥ 2 块看板(或收容区有卡)时才画(main.ts renderBoardPills)⇒ 读得到当前那枚就是「该说看板名」。
  const board = document.querySelector<HTMLElement>("#filter-boards .fpill.active")?.dataset.label ?? "";
  const filtered = !sum.hidden && sum.textContent !== "" ? sum.textContent! : "";
  const text = [board, filtered].filter((x) => x !== "").join(" · ");
  const on = hidden && text !== "";
  peek.hidden = !on;
  if (on) peek.textContent = text;
  document.body.classList.toggle("chrome-peek-on", on); // 看板与节头给它让 28(index.html「顶栏收起」那段)
}

/** 收了之后它还滚得动吗:看板上收起会让列长高(约等于看板现在离屏顶那一截),只比看板高出一点的列一收就滚不动了 ——
 *  那种列本来就不缺这点高,不收(否则见 set 里那段振荡)。随记是整页滚、收起只平移不改高,恒答是。 */
function roomAfterHide(target: object): boolean {
  if (!(target instanceof HTMLElement)) return true;
  const gain =
    document.getElementById("timeline")!.getBoundingClientRect().top - 8;
  return target.scrollHeight - target.clientHeight - gain > MIN_Y;
}

function onScroll(target: object, y: number): void {
  if (!canHide()) {
    if (hidden) showChrome();
    last.set(target, y);
    return;
  }
  const prev = last.get(target);
  last.set(target, y);
  if (prev === undefined) return;
  const d = y - prev;
  if (performance.now() < quietUntil) return;
  if (Math.abs(d) > window.innerHeight * 0.6) return; // 程序跳转,不是手在划(见头注)
  if (d > 0) {
    down += d;
    up = 0;
    if (!hidden && down > HIDE_AFTER && y > MIN_Y && roomAfterHide(target))
      set(true);
  } else if (d < 0) {
    up -= d;
    down = 0;
    if (hidden && (up > SHOW_AFTER || y <= 0)) set(false);
  }
}

/** 手指下那个竖向滚动盒:看板上是它那一列(889 起列自己滚),落在列间空白 / 别处 = 无;随记是整页。 */
function scrollerAt(el: Element): HTMLElement | null {
  if (document.body.classList.contains("board"))
    return el.closest<HTMLElement>("#timeline > .tl-group");
  return document.scrollingElement as HTMLElement;
}

/** 手势兜底(见头注)。一次触摸只判一回。 */
function initGesture(tl: HTMLElement): void {
  let g: {
    x: number;
    y: number;
    box: HTMLElement | null;
    done: boolean;
  } | null = null;
  tl.addEventListener(
    "touchstart",
    (e) => {
      g =
        e.touches.length === 1 && canHide()
          ? {
              x: e.touches[0].clientX,
              y: e.touches[0].clientY,
              box: scrollerAt(e.target as Element),
              done: false,
            }
          : null;
    },
    { passive: true },
  );
  tl.addEventListener(
    "touchmove",
    (e) => {
      if (!g || g.done || e.touches.length !== 1) return;
      // 长按拿起了一张卡:那是拖卡,不是在翻(carddrag 拿起时打这枚类)。
      if (document.body.classList.contains("card-dragging")) {
        g = null;
        return;
      }
      const dx = e.touches[0].clientX - g.x;
      const dy = e.touches[0].clientY - g.y;
      if (Math.abs(dy) < GESTURE_PX || Math.abs(dy) < Math.abs(dx) * 1.5)
        return; // 横划(看板横滚 / 卡上改状态)不管
      g.done = true;
      if (performance.now() < quietUntil || !canHide()) return;
      const pushUp = dy < 0; // 手指往上推 = 想看下面的
      const b = g.box;
      const canScroll =
        b !== null &&
        (pushUp
          ? b.scrollTop < b.scrollHeight - b.clientHeight - 1
          : b.scrollTop > 0);
      if (canScroll) return; // 滚得动:scroll 那条路会判
      down = 0;
      up = 0;
      set(pushUp);
    },
    { passive: true },
  );
}

export function initChromeHide(): void {
  // 看板上整页不滚(889 定高),真来了的整页 scroll 只会是布局变化的副作用(892 实撞:收起那一下把整页拉回 0,被读成往上划)⇒ 不听。
  window.addEventListener(
    "scroll",
    () => {
      if (!document.body.classList.contains("board"))
        onScroll(window, window.scrollY);
    },
    { passive: true },
  );
  const tl = document.getElementById("timeline")!;
  // 看板上滚的是列(元素的 scroll 不冒泡 ⇒ 捕获阶段收);#timeline 自己那是横滚,不算。
  tl.addEventListener(
    "scroll",
    (e) => {
      const el = e.target as HTMLElement;
      if (el !== tl && el.parentElement === tl) onScroll(el, el.scrollTop);
    },
    { capture: true, passive: true },
  );
  // 转屏 / 分屏拖到不是矮屏了:露出来(CSS 那几条也挂在矮屏上,不露也看不见,但状态得清,转回来别一上来就是收着的)。
  // ⚠ 等一帧再判:widescreen / tallscreen 两枚类是 main.ts 在同一个 resize 里翻的,先后不定。
  window.addEventListener("resize", () =>
    requestAnimationFrame(() => {
      if (hidden && !canHide()) showChrome();
    }),
  );
  document.getElementById("chrome-peek")!.addEventListener("click", showChrome);
  initGesture(tl);
}

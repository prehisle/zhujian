// 贴键盘上沿的底部层(232/240 在捕获层上栽出来的形;314 第③笔起捕获层与留言层共用)。
//
// 本机 WebView 键盘弹起时**布局视口不缩**(innerHeight 恒 800)、只有 visualViewport 缩。
// 此前纯 `bottom:0` 交给浏览器抬层,浏览器是靠「滚文档露出聚焦输入」来抬的——那下滚动
// 正是「弹键盘背景乱滚」的元凶,且拦滚动就等于拦抬升。这里改由 JS 自己用 transform 抬层
// (place 跟随 vv),并在 focus 前用缓存的键盘高度**抢先抬**上去,让输入框始终留在可见区
// 内 → 浏览器再没有滚文档的动机 → 背景一格不动(不靠遮罩兜底)。
//
// ⚠ 这里每一处延时/阈值都是真机量出来的(550/450/600ms、80px、lastKbH 初值 280),别凭
// 直觉调;要动先在真机上量。
//
// 两层的差别只由选项表达,行为主体一份:
//  - 捕获层:不限高、开层即抢先抬、聚焦输入即开层;
//  - 留言层:限高(留一条背景告诉人这是一层)、开层先读不弹键盘、不由 focus 开层。

export type KbSheet = {
  isOpen(): boolean;
  /** 显层(不 focus——要不要弹键盘由调用方决定)。 */
  open(): void;
  /** 收层:回到 CSS 默认的滑出态,清 inline 几何并 blur 输入。幂等。 */
  close(): void;
  /** focus 之前抢先抬到(上次)键盘上方。 */
  raise(): void;
  /** 按当前可见区重贴一次(层高变化等)。 */
  place(): void;
};

export type KbSheetOpts = {
  sheet: HTMLElement;
  scrim: HTMLElement;
  /** 层内主输入:键盘由起转落时 blur 它(下次点它才会再发 focus 事件)。 */
  input: HTMLElement;
  /** 限高:最大高度 = 可见区高 − 这个数。不传 = 不限高(捕获层那种小层)。 */
  reserveTop?: number;
  /** 输入获得焦点而层还没开 → 开层(捕获层的「一步回捕获」/系统分享走这条)。 */
  openOnFocus?: boolean;
  /** 开层即抢先抬(捕获层开层就是要写字);留言层开层是先读,故不抬。 */
  raiseOnOpen?: boolean;
  onOpen?: () => void;
  onClose?: () => void;
  /** 点遮罩:默认 close();留言层要顺带平掉返回键守门条目,故可接管。 */
  onDismiss?: () => void;
};

/** 限高层的下限:再挤也留这么高,免得键盘高的机器上层被压成一条缝。 */
const MIN_SHEET_H = 240;

/** 「键盘算不算起来了」的阈值:innerH − vvH 超过它才当键盘在。 */
const KB_MIN_H = 80;

// ---- 这台设备到底会不会弹软键盘(模块级 —— 是设备属性,不是某一层的属性)---------
//
// 模拟器 / 接了物理键盘的平板上软键盘**永不出现**,而 `raise()` 的抢先抬是**为键盘让位**:
// 抬上去没有对象,只能干等 600ms 兜底把层落回来 —— 屏上就是「层跳到半空停一下再回底部」。
// (用户 2026-08-26 在 MuMu 上报的正是这个;真机 vivo 上键盘 151ms 就起来,看不出来。)
//
// ⚠ 判据刻意**保守**:默认照旧抢先抬,只有连着 ABSENT_LIMIT 次开层都没见到键盘才停。
// 两边的代价不对称 —— 错判「没有键盘」会让 232/240 那个「弹键盘背景乱滚」的老患回来一次,
// 而多抬一次只是难看一下。见到键盘立即清零(平板拔掉物理键盘即自愈)。
// 纯设备本地、**不进同步**(与语言 / 明暗 / 字号同一条规矩:这是这块屏幕的属性)。
const KB_ABSENT_KEY = "zhujian.kb-absent";
const ABSENT_LIMIT = 2;
let kbAbsent = Number(localStorage.getItem(KB_ABSENT_KEY) ?? "0") || 0;

/** 判定这台设备不会弹软键盘 ⇒ 抢先抬无意义。 */
function kbNeverShows(): boolean {
  return kbAbsent >= ABSENT_LIMIT;
}
function noteKbAbsent(): void {
  if (kbAbsent >= ABSENT_LIMIT) return;
  kbAbsent += 1;
  localStorage.setItem(KB_ABSENT_KEY, String(kbAbsent));
}
function noteKbPresent(): void {
  if (kbAbsent === 0) return;
  kbAbsent = 0;
  localStorage.setItem(KB_ABSENT_KEY, "0");
}

export function createKbSheet(o: KbSheetOpts): KbSheet {
  const { sheet, scrim, input } = o;
  const vv = window.visualViewport;
  let opened = false;
  let lastKbH = 280; // 最近一次软键盘高度(innerH − vvH);初值给个常见值,首次也能抢先抬
  let raiseUntil = 0; // 抢先抬后的保护窗口(键盘上升动画期):此刻前不许 place 把层落回屏底
  let wasKbUp = false; // 上次 place 时键盘是否在起——用于识别「起→落」的收起动作
  let suppressScrimUntil = 0; // 抢先抬会把层瞬移上去,紧随的 click 漏到遮罩上——这段时间内不当关层

  // 对 bottom:0 的层施上移量 = 键盘遮住的高度((vvH+vvTop)−innerH,≤0)。副作用即目的:
  // 输入框恒在可见区内,免浏览器滚文档。
  function kbOffset(): number {
    if (!vv) return 0;
    return vv.height + vv.offsetTop - window.innerHeight;
  }
  // 瞬移到位(transition:none + 强制回流):抢先抬与键盘跟随都必须「即时」——真机实测,
  // 只要 0.22s 过场让输入框在 focus 那刻还留在键盘区一瞬,浏览器就会滚文档/滚视口去露它。
  // 收层的滑落另走 CSS 过场(close 清 inline transform 时 transition 已恢复)。
  function setTransform(y: number): void {
    sheet.style.transition = "none";
    sheet.style.transform = `translateY(${y}px)`;
    void sheet.offsetHeight; // 强制回流,让这次「无过场」定位即时落地
    sheet.style.transition = "";
  }
  /** 键盘此刻在不在(单一判据,place 与 raise 的兜底共用)。 */
  function kbIsUp(): boolean {
    return !!vv && window.innerHeight - vv.height > KB_MIN_H;
  }

  /** 几何单一落点:限高层顺带按同一份「可见区高」定 max-height——抢先抬期间键盘还没起、
   *  vv 还是满屏高,不一起夹的话层顶会被顶出屏外(高层特有,捕获层那种小层碰不到)。 */
  function apply(y: number, visible: number): void {
    if (o.reserveTop !== undefined) {
      sheet.style.maxHeight = `${Math.max(MIN_SHEET_H, visible - o.reserveTop)}px`;
    }
    // 没有软键盘的设备、且层就该待在屏底:把 transform **交回 CSS**,层于是走
    // `.open` 那条 0.22s 过场从屏下滑上来(用户要的那个观感)。
    // ⛔ 这一路**只在没有键盘时才安全** —— 有键盘时任何过场都会让输入框在 focus 那刻
    // 还留在键盘区一瞬,浏览器就去滚文档露它,那正是 240 反复栽的「背景乱滚」。
    // ⚠ 容差不是洁癖:vv.height 带小数(MuMu 实测 1138.22),`y === 0` 恒不成立。
    if (Math.abs(y) < 1 && kbNeverShows()) {
      sheet.style.transition = "";
      sheet.style.transform = "";
      return;
    }
    setTransform(y);
  }

  function place(): void {
    if (!opened) return;
    const kbH = vv ? window.innerHeight - vv.height : 0;
    const kbUp = kbH > KB_MIN_H;
    if (kbUp) {
      lastKbH = kbH;
      noteKbPresent(); // 这台真会弹键盘:把「没有键盘」的计数清掉
    }
    // 键盘由起转落(用户按了收起键、且已过抢先抬窗口)→ 主动 blur:层「停屏底待着」不变,
    // 但下次点输入框能重新触发 focus 事件——据此再抢先抬,躲开二次露出滚动(点已聚焦的
    // 输入框不发 focus)。
    if (wasKbUp && !kbUp && Date.now() >= raiseUntil) input.blur();
    wasKbUp = kbUp;
    // 保护窗口内取「更高者」:键盘半升时 kbOffset 还接近 0,照用会把层掉回屏底触发露出
    // 滚动;取 min 让层稳在键盘上方等键盘升满,到 kbOffset≤−lastKbH 时自然接手,平滑不回弹。
    // 窗口外(用户收起键盘)kbOffset=0 → 回屏底(符合「收起就在底部」)。
    let y = kbOffset();
    let visible = vv ? vv.height : window.innerHeight;
    if (Date.now() < raiseUntil) {
      y = Math.min(y, -lastKbH);
      visible = Math.min(visible, window.innerHeight - lastKbH);
    }
    apply(y, visible);
  }

  // 在键盘真正弹起「之前」把层抬到(上次)键盘上方,让输入框一开始就落在可见区内 →
  // 浏览器没有「滚文档露出它」的动机(这是弹键盘背景不滚的关键)。窗口过后兜底重贴一次:
  // 键盘真起了按实测贴上沿、没起就落回屏底,故绝不会卡在半空。
  function raise(): void {
    if (!opened) return;
    // 判定这台设备不弹软键盘:抢先抬没有对象,抬了只会跳到半空再落回来。直接按当前可见区
    // 贴(= 屏底),由 apply 交回 CSS 走滑入过场。键盘哪天真起了,vv 的 resize 会接管。
    if (kbNeverShows()) {
      place();
      return;
    }
    // 同一轮开层里本函数会被调**两次**(open() 一次、随后 input.focus() 又一次):保护窗口
    // 还没过就说明是同一轮,直接走人。抬升本身是幂等的,但**记账不是** —— 不去重的话一次
    // 开层会把「没见到键盘」记成两笔,ABSENT_LIMIT 当场被腰斩(2026-08-27 真机实测逮到)。
    if (Date.now() < raiseUntil) return;
    raiseUntil = Date.now() + 550;
    suppressScrimUntil = Date.now() + 450;
    apply(-lastKbH, window.innerHeight - lastKbH);
    window.setTimeout(() => {
      // 兜底重贴;顺带记一笔「抬上去 600ms 键盘还没露面」,连着几次就判这台没有软键盘。
      // ⚠ 只在层**还开着**时记:用户开层随手又关掉,不能算作「这台没有键盘」的证据。
      if (opened && !kbIsUp()) noteKbAbsent();
      place();
    }, 600);
  }

  function open(): void {
    if (opened) return;
    opened = true;
    scrim.hidden = false;
    sheet.classList.add("open");
    o.onOpen?.();
    if (o.raiseOnOpen) raise();
    else place();
  }

  // 幂等且**不设 opened 闸**:收层就是把 inline 几何交回 CSS,重复调无副作用;调用方
  // (捕获层的「记下」成功路)不必先问层还开不开。
  function close(): void {
    opened = false;
    raiseUntil = 0;
    wasKbUp = false;
    scrim.hidden = true;
    sheet.classList.remove("open");
    sheet.style.transition = ""; // 收层走 CSS 过场,别被上一次 setTransform 的 none 卡住
    sheet.style.transform = ""; // 交回 CSS:默认 translateY(110%) 滑出屏下
    if (o.reserveTop !== undefined) sheet.style.maxHeight = "";
    input.blur();
    o.onClose?.();
  }

  // 焦点入口(单一抬升点):抬升放在 focus 里(而非 pointerdown)——focus 落定后再抬,不会
  // 把输入框从手指底下挪走导致点空;又是同步早于键盘几何变化,故仍赶在露出滚动之前。
  input.addEventListener("focus", () => {
    if (!opened) {
      if (o.openOnFocus) open();
      return;
    }
    raise();
  });
  // 点遮罩 = 收层。用 click(整个 tap 完成再收)而非 pointerdown:pointerdown 收早了,后半程
  // tap 会漏到下方卡片上误开面板。抬升(focus 里)诱发的漏点 click 落在遮罩上,由
  // suppressScrimUntil 压掉——两个反向的坑在此汇合,click + 抑制窗口是同时躲开两者的解。
  scrim.addEventListener("click", () => {
    if (Date.now() < suppressScrimUntil) return;
    if (o.onDismiss) o.onDismiss();
    else close();
  });
  // 键盘起落:visualViewport 缩放/滚动时把层重新贴到可见区底沿。
  if (vv) {
    vv.addEventListener("resize", place);
    vv.addEventListener("scroll", place);
  }
  // 层高变化(打字自增高/加图缩略条/留言列表长出来)时,底沿保持贴合可见区底。
  new ResizeObserver(() => place()).observe(sheet);

  return { isOpen: () => opened, open, close, raise, place };
}

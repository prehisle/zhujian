// 贴屏底的底部层(232/240 在捕获层上栽出来的形;314 第③笔起捕获层与留言层共用)。
//
// ⭐ 2026-08-28 大幅瘦身。此前这里有一整套「猜键盘多高」的机器:抢先抬 280px(一个猜的初值)、
// 550/450/600ms 三个手调窗口、外加「这台设备到底会不会弹软键盘」的持久计数(`kb-absent`)。
// 它们全部长在同一个前提上 —— **WebView 的视口在键盘起落时不会变**,层只能靠 JS 自己
// transform 上去。那个前提在 `MainActivity.applyImeInsets()`(那边有全部由头与官方版本表)
// 接上 ime inset 之后**不再成立**:视图真的缩了 ⇒ `position:fixed; bottom:0` 就是键盘上沿。
//
// 于是这里只剩三件事:开合(走 CSS 那条 0.22s 过场)、限高层按可见区夹 max-height、
// 开层瞬间那记漏点的抑制。
//
// ⛔ **别把猜键盘那套加回来**。键盘几何只有一个真相源 = 原生侧的 ime inset;JS 这边只该看到
// 「视口就这么大」。真机上如果又出现「层贴到键盘底下」,先回去查那个 listener 还在不在
// (2026-08-28 判例:WebView 138 上页面里 innerHeight / visualViewport / scrollY 一个数都不动,
// 前端怎么写都够不着),⛔ 别在这里补第二套几何。
//
// 两层的差别只由选项表达,行为主体一份:
//  - 捕获层:不限高、聚焦输入即开层;
//  - 留言层:限高(留一条背景告诉人这是一层)、不由 focus 开层。

export type KbSheet = {
  /** 显层(不 focus——要不要弹键盘由调用方决定)。 */
  open(): void;
  /** 收层:回到 CSS 默认的滑出态,清 inline 几何并 blur 输入。幂等。 */
  close(): void;
};

export type KbSheetOpts = {
  sheet: HTMLElement;
  scrim: HTMLElement;
  /** 层内主输入:收层时 blur 它(键盘随之落下)。 */
  input: HTMLElement;
  /** 限高:最大高度 = 可见区高 − 这个数。不传 = 不限高(捕获层那种小层)。 */
  reserveTop?: number;
  /** 输入获得焦点而层还没开 → 开层(捕获层的「一步回捕获」/系统分享走这条)。 */
  openOnFocus?: boolean;
  onOpen?: () => void;
  onClose?: () => void;
  /** 点遮罩:默认 close();留言层要顺带平掉返回键守门条目,故可接管。 */
  onDismiss?: () => void;
};

/** 限高层的下限:再挤也留这么高,免得键盘高的机器上层被压成一条缝。 */
const MIN_SHEET_H = 240;

/** 开层瞬间遮罩才出现,同一记 tap 的 click 会漏到它身上 —— 这段时间内不当「点遮罩关层」。 */
const SCRIM_GRACE_MS = 450;

// 开层期间锁住背景滚动(`html.kb-locked { overflow: hidden }`)。
//
// ⚠ **这条是 2026-08-28 实测逼出来的,别当洁癖删掉**:视口改成「键盘一起就真缩」之后,240 那个
// 「弹键盘背景乱滚」的老患换了个形回来 —— 键盘一起,Chromium 会滚文档去露出焦点输入框,而层是
// fixed 的、滚了也露不出什么,受害的只有背后的时间轴。A/B 各 5 次真机实测:**不锁 5/5 背景滚
// +277px,锁上 5/5 一动不动**(⚠ 库里条目要够多、文档真能滚,才看得见这件事)。
// 语义上也正当:层开着时背景被遮罩盖住,本来就不该动。
//
// 计数而非布尔:两层理论上可叠,后收的那层不许把还开着的那层的锁提前解掉。
let lockCount = 0;

export function createKbSheet(o: KbSheetOpts): KbSheet {
  const { sheet, scrim, input } = o;
  const vv = window.visualViewport;
  let opened = false;
  let suppressScrimUntil = 0;
  let holdsLock = false;

  /** 本层对背景滚动锁的持有态。幂等:close() 允许在没开的时候被调,不许因此扣别人的锁。 */
  function setLock(on: boolean): void {
    if (on === holdsLock) return;
    holdsLock = on;
    lockCount += on ? 1 : -1;
    document.documentElement.classList.toggle("kb-locked", lockCount > 0);
  }

  // 限高层:按**当前可见区**夹 max-height。键盘一起,视口就缩(原生侧把 ime inset 变成了
  // 内容视图的 padding),这里跟着矮下去,层顶不会被顶出屏外。捕获层不传 reserveTop = 不夹。
  function fit(): void {
    if (o.reserveTop === undefined || !opened) return;
    const visible = vv ? vv.height : window.innerHeight;
    sheet.style.maxHeight = `${Math.max(MIN_SHEET_H, visible - o.reserveTop)}px`;
  }

  function open(): void {
    if (opened) return;
    opened = true;
    suppressScrimUntil = Date.now() + SCRIM_GRACE_MS;
    setLock(true);
    scrim.hidden = false;
    sheet.classList.add("open");
    fit();
    o.onOpen?.();
  }

  // 幂等且**不设 opened 闸**:收层就是把类与 inline 几何摘掉,重复调无副作用;调用方
  // (捕获层的「记下」成功路)不必先问层还开不开。
  function close(): void {
    opened = false;
    setLock(false);
    scrim.hidden = true;
    sheet.classList.remove("open");
    if (o.reserveTop !== undefined) sheet.style.maxHeight = "";
    input.blur();
    o.onClose?.();
  }

  // 任何路径聚焦到输入都进入开层态(顶栏「一步回捕获」/系统分享追加)。
  input.addEventListener("focus", () => {
    if (!opened && o.openOnFocus) open();
  });
  // 点遮罩 = 收层。用 click(整个 tap 完成再收)而非 pointerdown:pointerdown 收早了,后半程
  // tap 会漏到下方卡片上误开面板。而开层那一记 tap 的 click 又可能漏到刚出现的遮罩上,
  // 由 SCRIM_GRACE_MS 压掉 —— 两个反向的坑在此汇合。
  scrim.addEventListener("click", () => {
    if (Date.now() < suppressScrimUntil) return;
    if (o.onDismiss) o.onDismiss();
    else close();
  });
  // 键盘起落 = 可见区变化:限高层重新夹一次(不限高的层什么都不用做,CSS 的 bottom:0 就够)。
  if (vv) vv.addEventListener("resize", fit);

  return { open, close };
}

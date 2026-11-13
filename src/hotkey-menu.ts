import "./hotkey-menu.css";
import { t } from "./i18n";
import { NATIVE_MENU_KEEP } from "./context-menu";
import { el, holdKeyboard, type KeyboardHold } from "./dom";
import { toastAction, toastError } from "./toast";
import { copyFailed } from "./clipboard";

// 悬停即选中 + ⋯ 速查菜单 + 单键直达 —— 抽自 inbox 的原型,做成视图无关的公共件,
// 让「同一个键 = 同一个概念」跨视图(灵感 / 任务看板 / …)一致,肌肉记忆才能迁移。
//
// One declared action = one dropdown row + one single-key shortcut. The SAME list
// drives the hover ⋯ menu (the visible cheat-sheet) and the keydown dispatch, so a
// key shown in the menu can never do something else (single source of truth).

/** portal 到 body 的「卫星浮层」白名单——落点在这些层里不算「点别处」,不触发
 *  编辑态的默认保存 / 确认态的收起。此前这串选择器以字面量抄在三处(board / inbox 的
 *  onDown 与这里的 armDismiss,顺序还不一致),新增留言层(.cm-overlay)三处都没登记;
 *  收成唯一登记点:**新增 portal 层改这里一处**。
 *  ⚠ `.cm-panel` 不是 portal 层:随记那侧的留言就地长在卡片里(见 item-comments 的
 *  PanelMode)。登记它是为了另一件事——那张卡上若同时开着标签/截止选择器,点留言框
 *  不该把选择器收掉。浮层那一形里它是 `.cm-overlay` 的孩子,登记两次无害。 */
export const SATELLITE_LAYERS = ".hk-menu, .img-lightbox, .cm-overlay, .cm-panel";

export type Act = {
  /** 菜单行左侧文案。 */
  label: string;
  /** 单键,按它被匹配的形态存:字母用大写("E"),其它可打印键用原样("]"、"[")。 */
  key: string;
  /** 危险操作(删除类),菜单行染成朱砂。 */
  danger?: boolean;
  /** 此刻做不了的原因(R2 那族「事前灰」:随记「转待办」在默认看板放不进卡时)。给了 = 菜单行淡着(aria-disabled,
   *  title 写原因),点它 / 按它的键只说这句、⛔ 不跑 run。⛔ 别拿它藏动作:做不了也照列,人才知道为什么。 */
  blocked?: string;
  /** 不进 ⋯ 菜单,只当单键快捷键用。0040 卡片配色的 1-7 / 0 八枚数字键走这条:它们是
   *  「悬停即按」的快速通道,全摊进菜单会把 14 行撑到 22 行。⚠ 发现性由菜单里那项
   *  「颜色」兑现 —— 色板上每个色点标着自己的数字键。⛔ 别拿它藏危险动作:右键菜单与
   *  单键读的是同一份 actions,藏起来的项**照样按得出来**,只是菜单里看不见。 */
  hidden?: boolean;
  /** 普通动作:先关菜单,再执行。run / feedback 二选一。 */
  run?: () => void;
  /** 子菜单(158 G3 / Q2:看板「移到 ▸」列出所有列)。点这一行 = 菜单原地换成子项(顶上一行「‹ 返回」),
   *  ⛔ 不另开一层浮层(同一时刻至多一枚菜单的规矩不破)。子项与它自己都不进单键派发:`key` 给空串
   *  (菜单行右侧那格画「▸」/ 留空);要单键直达的另立 `hidden` 项(看板的 `]` `[`)。 */
  sub?: () => Act[];
  /** 留开动作(如复制):执行后在自己的菜单行里闪一下返回的文案,而非关闭菜单。
   *  从键盘触发(菜单没开)时改用底部回执说同一句(158)。返回值即要闪的文案。
   *  今天全是「复制」一族:**失败就让它 reject**(⛔ 别自己 catch 成文案 —— 那样原因就丢了),这里统一报
   *  「复制失败:{原因}」(902 F3):菜单行里闪短的 + 屏底一条全句,键盘触发的直接出全句。 */
  feedback?: () => Promise<string>;
};

/** 没改过的卡按「历史」那枚键(随记 H、看板 / 归档 V)的那一项(165 / W5 A45):此前一声不吭,像键坏了。
 *  `hidden` —— 菜单里照旧只有改过的卡才列「历史」(指南「改过的才有」);按了说一句这张还没改过。 */
export function noHistoryAct(key: string): Act {
  return { label: t("inbox.noHistory"), key, hidden: true, run: () => toastAction(t("inbox.noHistory")) };
}

/** 一张卡片接入后拿到的句柄。 */
export type CardHandle = {
  /** 给这张卡片新造一个 ⋯ 按钮 + 懒展开的下拉。放到卡片视图态里任意位置;每次卡片重渲
   *  视图态都要重新调一次(旧节点在父级 replaceChildren 后就失效了)。 */
  menu(): HTMLElement;
  /** 把焦点还给这张卡(它此刻那枚 ⋯)并选中它 —— 卡上就地展开的东西(编辑 / 标签 / 确认 / 留言…)
   *  收起时调,别让焦点掉到页面上(W5 A4 / Q2「关完焦点还给打开它的那枚」)。不滚动。 */
  focus(): void;
};

/** `register` 的第四个参数。 */
export type RegisterOpts = {
  /** 这张卡是哪一条(条目 id)。整列重画之后按它把「选中」与焦点接回同一张;那张不在了就落到原位后一张
   *  (W5 A3 / A4 / A12)。不给 = 重画后不接(老样子)。 */
  id?: string;
  /** 鼠标离开也不清选中(长文阅读页:整页就这一张,页头印着的键要恒作用于它 —— W5 A13)。 */
  sticky?: boolean;
};

export type HotkeyController = {
  /** 把「悬停选中 + 单键」接到 `card` 上。`actions` 每次开菜单 / 按键时现读,所以可用动作
   *  随状态变(看板:撤回仅待办、列间移动看是否到头)的卡片永远反映当前真相。
   *  `suspended()` 为真 = 此刻键盘归卡片自己(行内编辑 / 确认中),全局单键让位。 */
  register(card: HTMLElement, actions: () => Act[], suspended?: () => boolean, opts?: RegisterOpts): CardHandle;
  /** 重渲前调一次:关掉残留菜单、清掉已失效的选中目标(否则会指向已脱离 DOM 的旧卡片)。
   *  选中的那张(与焦点在不在它身上)记下来,下一批 `register` 进来时按 id 接回(见 RegisterOpts.id)。 */
  reset(): void;
  /** 一张卡要离场了(删 / 转走 / 还原 / 彻底删…,整列不一定重画):把它从轨道上摘掉;它正被选中的话,
   *  选中(连同焦点,焦点本在它身上时)落到原位后一张(最后一张就往前一张)。W5 A3 / A12:此前离场走
   *  `reset()`,整条轨道一起清空 —— 回收站里还原一条不重画,↑ ↓ 从此再也选不中任何一张。 */
  leave(card: HTMLElement): void;
  /** 下一次重画后选中这一条;`focus` = 焦点也给它(的 ⋯)。跳转落点(W5 Q11)、撤销回来的那张用。 */
  want(id: string, focus: boolean): void;
  /** 卸载视图时调:摘掉 document 上的 keydown 与任何打开的菜单。 */
  destroy(): void;
};

/** 控制器的选项。`lane` = 卡所在的那一条泳道(看板的列);给了,← → 就是换道:选中跳到隔壁那一道
 *  最上面那张(空道跳过)—— W5 Q10。不给 = ← → 不管(随记 / 长文是一条时间轴)。 */
export type HotkeyOpts = { lane?: (card: HTMLElement) => HTMLElement | null };

/** 焦点落在卡里哪一枚控件上(⋯ 以外的):重画后按「同标签同类名的第几枚」找回来。 */
type FocusMark = { tag: string; cls: string; idx: number } | "btn";

/** 卡里此刻能停焦点的控件(⛔ 不走 dom.ts 的 `focusables`:那只要 offsetParent,而 ⋯ 平时 opacity 0 照样可停)。 */
function stops(card: HTMLElement): HTMLElement[] {
  return [...card.querySelectorAll<HTMLElement>("button, input, textarea, select, a[href], [tabindex]:not([tabindex='-1'])")].filter(
    (n) => !(n as HTMLButtonElement).disabled,
  );
}

// ---- small DOM helper (same shape as the views) ----------------------------
export function createHotkeyController(hopts: HotkeyOpts = {}): HotkeyController {
  // The hovered (or menu-locked) card is the shortcut target; its action list is read
  // live, so the menu and the keyboard can never disagree. `openMenuCloser` keeps at
  // most one menu open across the whole view.
  //
  // ⭐ W5(A2 / A6 / A7)起「选中」与「焦点」是一回事的两面,规矩三条:
  //   ① 焦点进了一张卡(Tab 到它的 ⋯ / 标签 ✕ / 方框…)= 选中这张 —— 单键作用于焦点框所在的那张;
  //   ② ↑ ↓(看板还有 ← →)挪选中时,焦点跟着挪到新那张的 ⋯ —— 黑框与浅红框不再分在屏幕两头;
  //   ③ 键盘焦点(:focus-visible)在一张卡里时,鼠标路过别的卡不抢选中(滚动时引擎补发的悬停也不抢)。
  //   鼠标那条路照旧:悬停即选中、离开即清(焦点还在卡里时不清)。
  type Row = {
    card: HTMLElement;
    actions: () => Act[];
    suspended: () => boolean;
    openMenu: () => void;
    id: string | null;
    sticky: boolean;
    /** 这张卡此刻那枚 ⋯(每次 menu() 重造)。 */
    btn: HTMLButtonElement | null;
    /** 这张卡的菜单开着时:收掉它(关菜单不还焦点 —— 收它的人自己定焦点去哪)。 */
    shut: (() => void) | null;
  };
  let activeRow: Row | null = null;
  let openMenuCloser: (() => void) | null = null;
  // 注册序 ≠ 视觉序(随记回收站的「已删配图」一节先注册、却画在页底 —— W5 A12 第一下 ↓ 就选到页底);
  // ⇒ 轨道一律按**文档序**现排(navOrder)。每次重渲 reset() 清空、register 重排。
  let rows: Row[] = [];
  // 重画接力(W5 A3 / A4):reset() 记下「选中的是谁、它后面 / 前面依次是谁、焦点在不在它身上」,
  // 下一批 register 之后(同一任务末尾的微任务)按 id 接回。
  // `wanted` = 调用方点名要的(want():跳转落点 / 撤销回来的那张),下一次 reset() 不许拿「此刻选中的」盖掉它。
  let keep: { id: string; after: string[]; before: string[]; focus: FocusMark | null; wanted: boolean } | null = null;
  let resolveQueued = false;
  // 焦点最后一次落在哪张卡里(id)。被选中的卡里那枚聚焦的控件随重画 / 收起被换掉时,焦点会掉到 body;
  // 这一格让 reset() 认得出「焦点刚才在它身上」,画完还回去(W5 A4)。点卡外别处 = 清。
  let lastFocusId: string | null = null;

  const rowOf = (n: Node | null): Row | null => (n ? (rows.find((r) => r.card.contains(n)) ?? null) : null);

  /** 活着的卡,按文档序(= 视觉序:时间轴从上到下,看板列内从上到下、列间从左到右)。 */
  function navOrder(): Row[] {
    const alive = rows.filter((r) => r.card.isConnected && !r.card.classList.contains("removing"));
    alive.sort((a, b) => (a.card.compareDocumentPosition(b.card) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    return alive;
  }

  function setActiveRow(r: Row | null): void {
    if (activeRow === r) {
      r?.card.classList.add("is-active");
      return;
    }
    activeRow?.card.classList.remove("is-active");
    activeRow = r;
    r?.card.classList.add("is-active");
  }

  /** 焦点给这张卡:它的 ⋯(在的话),否则卡里第一枚能停的。⛔ 不滚(调用方自己定滚不滚)。 */
  function focusRow(r: Row, mark: FocusMark | null = "btn"): void {
    let target: HTMLElement | null = null;
    if (mark !== null && mark !== "btn") {
      target = stops(r.card).filter((n) => n.tagName === mark.tag && n.className === mark.cls)[mark.idx] ?? null;
    }
    if (target === null) target = r.btn && r.btn.isConnected && r.card.contains(r.btn) ? r.btn : (stops(r.card)[0] ?? null);
    target?.focus({ preventScroll: true });
    lastFocusId = r.id;
  }

  /** 焦点此刻算不算「在这张卡上」:在卡里,或刚从卡里掉到 body(聚焦的那枚被换掉了)、或在它开着的菜单里。 */
  function focusOn(r: Row): FocusMark | null {
    const a = document.activeElement;
    if (a instanceof HTMLElement && r.card.contains(a)) {
      if (a === r.btn) return "btn";
      // 只有卡面上常驻、重画后还认得回来的那几样(方框 / 标签 ✕ / 展开钮)按「第几枚」接回;
      // 编辑框、选择器、确认块里的钮重画后就不在了 —— 还给 ⋯(别按类名撞上别处一枚同名钮)。
      if (!a.matches(".ckbox, .tag-x, .chip-x, .fold-toggle")) return "btn";
      const same = stops(r.card).filter((n) => n.tagName === a.tagName && n.className === a.className);
      const idx = same.indexOf(a);
      return idx < 0 ? "btn" : { tag: a.tagName, cls: a.className, idx };
    }
    if (a instanceof HTMLElement && a.closest(".hk-menu") && openMenuCloser !== null && activeRow === r) return "btn";
    if ((a === null || a === document.body) && lastFocusId !== null && lastFocusId === r.id) return "btn";
    return null;
  }

  // 执行一个动作。feedback 型:跑完把返回文案交给 flash(菜单开着才闪)。run 型:直接跑。
  function runAct(act: Act, flash: ((text: string) => void) | null): void {
    if (act.blocked !== undefined) {
      toastError(act.blocked);
      return;
    }
    if (act.feedback) {
      // 键盘路径(菜单没开)此前静默执行 —— `/` C 复制了却屏上什么也没变(158 G2 / A17,WD-21)。
      // 没有菜单行可闪,就用底部那条回执说同一句。
      void act.feedback().then(
        (text) => (flash ? flash(text) : toastAction(text)),
        (e) => {
          const short = copyFailed(e); // 屏底全句(带原因)
          flash?.(short);
        },
      );
    } else {
      act.run?.();
    }
  }

  /** 挪选中:↑ ↓(看板另有 ← →)。焦点跟过去(规矩 ②)。 */
  function move(key: string): boolean {
    const alive = navOrder();
    if (alive.length === 0) return false;
    const at = activeRow ? alive.indexOf(activeRow) : -1;
    let next: Row | undefined;
    if (key === "ArrowDown") next = alive[at < 0 ? 0 : Math.min(at + 1, alive.length - 1)];
    else if (key === "ArrowUp") next = alive[at < 0 ? alive.length - 1 : Math.max(at - 1, 0)];
    else {
      const laneOf = hopts.lane;
      if (!laneOf) return false;
      if (at < 0) next = alive[0];
      else {
        // 道按文档序排、空道不进表 ⇒ 隔壁没卡的道自动跳过(W5 Q10)。
        const lanes: HTMLElement[] = [];
        for (const r of alive) {
          const l = laneOf(r.card);
          if (l && !lanes.includes(l)) lanes.push(l);
        }
        const cur = laneOf(alive[at].card);
        const j = (cur ? lanes.indexOf(cur) : -1) + (key === "ArrowRight" ? 1 : -1);
        if (j < 0 || j >= lanes.length) return true; // 到头了:吞掉这一下,选中不动
        next = alive.find((r) => laneOf(r.card) === lanes[j]);
      }
    }
    if (!next) return false;
    setActiveRow(next);
    focusRow(next);
    next.card.scrollIntoView({ block: "nearest", inline: "nearest" });
    return true;
  }

  function onKey(e: KeyboardEvent): void {
    // Modifiers stay with the system/global shortcuts (Ctrl+Alt+N, Ctrl+C, …).
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Never steal a keystroke from a field — typing 'e' must type 'e'.
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    // ↑/↓ 键盘选卡:和悬停同一个「选中」概念(选中后单键 / `/` 照常),不碰鼠标也能
    // 挑卡。没有选中时 ↓ 从头、↑ 从尾进入;菜单开着时不动(菜单是自己的键盘域)。
    // 跳过已脱离 DOM 的陈尸行(离场动画中的卡)。
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
      if (openMenuCloser) return;
      // 正在卡里改东西 / 确认中、焦点也在那张卡里:方向键归那张表单(别把选中挪走、把确认晾在原地)。
      if (activeRow && activeRow.suspended() && activeRow.card.contains(document.activeElement)) return;
      if (move(e.key)) e.preventDefault();
      return;
    }
    if (!activeRow) return;
    // A card mid inline-edit / mid-confirm owns the keyboard (its own Enter/Esc).
    if (activeRow.suspended()) return;
    if (e.key.length !== 1) return;
    const want = e.key.toUpperCase();
    // `/` 弹出当前卡片的 ⋯ 速查菜单(忘了哪个键时翻一眼);其余单键直接派发动作。
    if (want === "/") {
      e.preventDefault();
      activeRow.openMenu();
      return;
    }
    const act = activeRow.actions().find((a) => a.key === want);
    if (!act) return;
    e.preventDefault();
    openMenuCloser?.(); // acting from the keyboard shuts any open menu first
    runAct(act, null); // menu is closed → feedback text goes to the bottom toast instead (158)
  }
  document.addEventListener("keydown", onKey);

  // 规矩 ①:焦点进卡 = 选中这张(Tab 到 ⋯ 上按 E / `/` 此前没反应,↓ 却从第一张数起 —— W5 A7)。
  function onFocusIn(e: FocusEvent): void {
    const r = rowOf(e.target as Node);
    if (!r) {
      const n = e.target as HTMLElement | null;
      if (!n?.closest?.(".hk-menu")) lastFocusId = null; // 焦点去了卡以外的地方(侧栏 / 过滤框…)
      return;
    }
    lastFocusId = r.id;
    if (openMenuCloser && activeRow !== r) return; // 别的卡的菜单开着:它锁着选中
    setActiveRow(r);
  }
  // 点卡外别处:「焦点刚才在哪张卡上」作废(点空白处焦点会掉到 body,那不是「被换掉」)。
  function onDownAnywhere(e: MouseEvent): void {
    const n = e.target as HTMLElement | null;
    if (!rowOf(n) && !n?.closest?.(".hk-menu")) lastFocusId = null; // 点菜单项不算走开(那是在这张卡上做事)
  }
  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("mousedown", onDownAnywhere, true);

  /** 键盘焦点此刻在**另一张**卡里(规矩 ③)。⚠ 只认 :focus-visible —— 鼠标点过 ⋯ 之后焦点也停在
   *  那枚钮上,那时悬停照旧该换选中。 */
  function keyboardElsewhere(r: Row): boolean {
    const a = document.activeElement;
    if (!(a instanceof HTMLElement) || a === document.body) return false;
    const owner = rowOf(a);
    if (owner === null || owner === r) return false;
    try {
      return a.matches(":focus-visible");
    } catch {
      return false;
    }
  }

  /** reset() 之后第一批 register 落定(同一任务末尾):按 id 把选中与焦点接回去。 */
  function queueResolve(): void {
    if (resolveQueued || keep === null) return;
    resolveQueued = true;
    queueMicrotask(() => resolve(true));
  }
  function resolve(retry: boolean): void {
    resolveQueued = false;
    const k = keep;
    if (k === null) return;
    const byId = (id: string): Row | null => rows.find((r) => r.id === id && r.card.isConnected) ?? null;
    let target = byId(k.id);
    if (target === null && rows.some((r) => !r.card.isConnected) && retry) {
      // 卡已造好、还没挂进文档(异步画的那几处):等一帧再接
      resolveQueued = true;
      requestAnimationFrame(() => resolve(false));
      return;
    }
    keep = null;
    if (target === null) {
      for (const id of k.after) if ((target = byId(id))) break;
    }
    if (target === null) {
      for (const id of k.before) if ((target = byId(id))) break;
    }
    if (target === null) return;
    setActiveRow(target);
    // 焦点:只在它本来就在那张卡上(或掉到了 body),且此刻没人接手(没落进别的框 / 别处)时还回去。
    const a = document.activeElement;
    if (k.focus !== null && (a === null || a === document.body || !a.isConnected)) {
      focusRow(target, k.focus);
      target.card.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  function register(
    card: HTMLElement,
    getActions: () => Act[],
    suspended: () => boolean = () => false,
    ropts: RegisterOpts = {},
  ): CardHandle {
    card.classList.add("hk-host");
    // Per-card menu state — persists across menu() rebuilds (each view re-render makes a
    // fresh ⋯ wrap but reuses these so an open menu / pending timer is never orphaned).
    let hovering = false;
    let menuOpenFlag = false;
    let menuEl: HTMLElement | null = null;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    // Reassigned by menu() each render so the row-level cleanup always tears down
    // whatever menu is currently shown, and the keyboard (`/`) can pop the latest one.
    let closeMenu: (restoreFocus?: boolean) => void = () => {};
    // `at` = 光标位置(右键那条路);不带 = 老路,按 ⋯ 图标的 rect 定位。
    let openMenuRef: (at?: { x: number; y: number }) => void = () => {};

    const api: Row = {
      card,
      actions: getActions,
      suspended,
      openMenu: () => openMenuRef(),
      id: ropts.id ?? null,
      sticky: ropts.sticky === true,
      btn: null,
      shut: null,
    };
    rows.push(api);
    queueResolve();

    // Hover sets the active card (the shortcut target) and reveals the icon (CSS).
    // While a menu is open the card stays active even if the pointer drifts off, so a
    // shortcut can never fire on the wrong card.
    card.addEventListener("mouseenter", () => {
      hovering = true;
      // While another card's menu is open it stays the locked target — a stray hover
      // (e.g. reaching toward that menu) must not steal it.
      if (openMenuCloser && openMenuCloser !== api.shut) return;
      if (keyboardElsewhere(api)) return; // 规矩 ③
      setActive();
    });
    card.addEventListener("mouseleave", () => {
      hovering = false;
      if (!menuOpenFlag && !api.sticky && !card.contains(document.activeElement)) clearActiveIfMine();
    });
    // 右键 = 开同一枚 ⋯ 菜单。菜单与单键本来就读同一份 actions,右键因此不可能比 ⋯ 少
    // 一项或多一项(单一真相源不动);它给的只是「不必先找到那枚只在悬停时才显形的图标」
    // 这个入口。⛔ 三条让位判据一条都别省 —— 在这些地方右键本来就有更该做的事,抢过来
    // 就是负优化:
    //   ① 输入框 / 可编辑区:编辑态右键要粘贴(配图那条路正是粘贴);
    //   ② 链接与图片:各自已有右键约定(item-images 的「右键复制链接」);
    //   ③ 本卡内有非空选区:用户正想右键复制选中的那段字。
    // 另外 suspended()(行内编辑 / 确认中)整个让位 —— 那时键盘也是让位的,同一条规矩。
    // ⭐ 505 起 ①② 那两项的选择器住 `context-menu.ts`(`NATIVE_MENU_KEEP`)—— 文档级那条路
    // 要读同一份,抄两份必漂移。⚠ ③ 刻意仍是**卡片内**的选区(`card.contains`),与文档级
    // 那条「点在选区上」不是同一个判据:这里让位的理由是「这张卡上有选区」。
    card.addEventListener("contextmenu", (e) => {
      const target = e.target as HTMLElement | null;
      if (!target || target.closest(NATIVE_MENU_KEEP)) return;
      if (suspended()) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.rangeCount > 0 && card.contains(sel.getRangeAt(0).commonAncestorContainer))
        return;
      e.preventDefault();
      // 已经开着的先收:别的卡片那枚(保持「全视图至多一枚」),或本卡那枚(⋯ 点开的 /
      // 上一次右键的)——后者要收掉才能挪到新的光标位置,openMenu 见 menuEl 非空会直接返回。
      if (openMenuCloser && openMenuCloser !== api.shut) openMenuCloser();
      if (menuEl) closeMenu(false);
      setActive();
      openMenuRef({ x: e.clientX, y: e.clientY });
    });
    function setActive(): void {
      setActiveRow(api);
    }
    function clearActiveIfMine(): void {
      if (activeRow === api) activeRow = null;
      card.classList.remove("is-active");
    }

    // Built fresh each render. The ⋯ icon shows on card hover, but the menu opens only on a
    // CLICK of the icon — hover-to-open was too twitchy (a stray sweep over the corner popped
    // it). The single-key shortcuts still fire on plain card hover, so the menu is purely a
    // click-to-open cheat-sheet; close it via outside-click / Esc / picking an item.
    function menu(): HTMLElement {
      // ⚠ draggable:false 在这些件上**不是**保护:Blink 找拖源沿祖先往上走,子元素的 draggable=false
      // 只让它自己不成拖源、挡不住可拖拽宿主(看板卡)起拖 —— 671 补在真 WebView2 上量的(按住 ⋯
      // 拖照样起卡片拖)。真挡住它的是宿主自己 mousedown 看落点(board.ts 的 CARD_CONTROLS 含
      // .hk-menu-wrap / button);这里留着只是标注意图,对不可拖拽宿主(灵感)无关。
      const wrap = el("div", { className: "hk-menu-wrap", draggable: false });
      const iconBtn = el("button", {
        className: "hk-btn",
        textContent: "⋯",
        title: t("hotkeyMenu.actionsTitle"),
        draggable: false,
      });
      iconBtn.setAttribute("aria-haspopup", "menu");
      iconBtn.setAttribute("aria-expanded", "false");
      api.btn = iconBtn;
      iconBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (menuEl) closeMenu(true); // click again toggles it shut
        else openMenu();
      });
      wrap.append(iconBtn);

      // 菜单接管键盘那一只(Q2 / A2:打开焦点就进菜单、Tab 圈在里面、Esc 关、关完焦点还给 ⋯)。
      let hold: KeyboardHold | null = null;

      function onDocClick(e: MouseEvent): void {
        // The menu is portaled to <body> (not inside wrap), so exempt it too — otherwise
        // this capture-phase handler would tear it down before the item's own click runs.
        // 点别处收起:⛔ 不还焦点 —— 那一点本来就把焦点给了被点的东西(过滤框 / 别的钮),还回 ⋯ 是抢。
        const t = e.target as Node;
        if (!wrap.contains(t) && !(menuEl && menuEl.contains(t))) closeMenu(false);
      }
      function onMenuKey(e: KeyboardEvent): void {
        if (e.key === "Escape") {
          e.preventDefault();
          closeMenu(true);
        }
      }
      /** 菜单里的键(焦点在菜单项上时):↑ ↓ Home End 走项、→ 进「移到 ▸」这类子层、← 退回、
       *  字母 = 直接做那一项(同菜单没开时的单键,W5 A2:此前 ↓ 滚的是整页)。 */
      function onMenuNav(e: KeyboardEvent): void {
        if (!menuEl || e.ctrlKey || e.metaKey || e.altKey) return;
        const items = [...menuEl.querySelectorAll<HTMLButtonElement>(".hk-item")];
        const at = items.indexOf(document.activeElement as HTMLButtonElement);
        const go = (i: number): void => {
          e.preventDefault();
          items[(i + items.length) % items.length]?.focus({ preventScroll: false });
        };
        switch (e.key) {
          case "ArrowDown":
            return go(at < 0 ? 0 : at + 1);
          case "ArrowUp":
            return go(at < 0 ? items.length - 1 : at - 1);
          case "Home":
            return go(0);
          case "End":
            return go(items.length - 1);
          case "ArrowRight":
            if (at >= 0 && items[at].classList.contains("hk-has-sub")) {
              e.preventDefault();
              items[at].click();
            }
            return;
          case "ArrowLeft": {
            const back = menuEl.querySelector<HTMLButtonElement>(".hk-back");
            if (back) {
              e.preventDefault();
              back.click();
            }
            return;
          }
        }
        if (e.key.length !== 1) return;
        const want = e.key.toUpperCase();
        if (want === "/") {
          e.preventDefault();
          closeMenu(true);
          return;
        }
        if (want === " ") return; // 空格 = 点焦点那一项(钮自己的默认动作)
        const act = getActions().find((a) => a.key === want);
        if (!act) return;
        e.preventDefault();
        closeMenu(true); // 先把焦点还给 ⋯,动作自己要拿焦点的(编辑框 / 选择器)随后接走
        runAct(act, null);
      }
      // Position in the viewport from the icon's rect, then CLAMP so the whole menu (every
      // row, incl. the last) stays on-screen — the icon may sit low in a full, scrolling
      // column, so a naive drop-down would push the bottom rows off-screen (→ not
      // interactable). Prefer below the icon; if it won't fit, go above; else pin to the
      // bottom margin, never above the top margin. 进出子菜单(高度变了)时再调一次。
      // W5 Q15(WD-36):上沿钳在**页头下沿**,不再铺到窗口最上沿 —— 此前看卡在哪一列,菜单盖住窗口
      // 最小化 / 最大化、页头的钮或页标题;放不下的那截在菜单里自己滚(max-height 跟着钳)。
      function place(at?: { x: number; y: number }): void {
        if (!menuEl) return;
        const M = 6;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const head = document.querySelector<HTMLElement>("#view header");
        const minTop = Math.max(M, head ? Math.round(head.getBoundingClientRect().bottom) + 2 : M);
        menuEl.style.maxHeight = `${Math.max(120, vh - M - minTop)}px`;
        const mh = menuEl.offsetHeight; // measured now that it is in the DOM
        let top: number;
        if (at) {
          // 右键那条路:左上角贴着光标(常规右键菜单的形)。⭐ 横向也要钳 —— ⋯ 那条是
          // 右对齐图标、天然不会出右边界,这条会(靠视口右缘右键时菜单整个跑出去)。
          menuEl.style.right = "auto";
          menuEl.style.left = `${Math.max(M, Math.min(at.x, vw - M - menuEl.offsetWidth))}px`;
          top = at.y;
        } else {
          const r = iconBtn.getBoundingClientRect();
          menuEl.style.left = "auto";
          menuEl.style.right = `${Math.max(M, vw - r.right)}px`;
          top = r.bottom + 4;
          if (top + mh > vh - M) top = r.top - 4 - mh; // won't fit below → flip above the icon
        }
        // Hard clamp so the WHOLE menu (every row, incl. the last) is on-screen even when the
        // icon sits low in / below the fold of a full scrolling column.
        top = Math.max(minTop, Math.min(top, vh - M - mh));
        menuEl.style.top = `${top}px`;
      }
      function openMenu(at?: { x: number; y: number }): void {
        clearTimeout(closeTimer);
        if (menuEl) return;
        openMenuCloser?.(); // at most one menu open across the view
        // 一行菜单项。`sub` 那种点了不收菜单,原地换成子项(Q2);子项里的普通项照常「先关再跑」。
        const rowFor = (a: Act): HTMLElement => {
          const item = el("button", {
            className: a.danger ? "hk-item danger" : a.sub ? "hk-item hk-has-sub" : "hk-item",
            draggable: false,
          });
          item.setAttribute("role", "menuitem");
          if (a.blocked !== undefined) {
            item.classList.add("blocked");
            item.setAttribute("aria-disabled", "true");
            item.title = a.blocked;
          }
          item.dataset.key = a.key;
          const label = el("span", { className: "hk-label", textContent: a.label });
          item.append(label);
          if (a.sub) item.append(el("span", { className: "hk-key hk-sub", textContent: "▸" }));
          else if (a.key !== "") item.append(el("kbd", { className: "hk-key", textContent: a.key }));
          item.addEventListener("click", (e) => {
            e.stopPropagation();
            if (a.sub) {
              drill(a);
            } else if (a.blocked !== undefined) {
              closeMenu(true);
              runAct(a, null); // 只说原因
            } else if (a.feedback) {
              // keep the menu up to flash the result in this row
              runAct(a, (text) => {
                label.textContent = text;
                clearTimeout(closeTimer);
                closeTimer = setTimeout(() => closeMenu(true), 900);
              });
            } else {
              closeMenu(true);
              a.run?.();
            }
          });
          return item;
        };
        const rowsFor = (acts: Act[]): HTMLElement[] => acts.filter((a) => !a.hidden).map(rowFor);
        menuEl = el("div", { className: "hk-menu", draggable: false }, rowsFor(getActions()));
        menuEl.setAttribute("role", "menu");
        // Portal to <body>, NOT into wrap: a menu nested in the card is trapped inside the
        // card's stacking context and clipped by the column body's overflow:auto — WebView2
        // then mis-hit-tests its rows (a sibling card's chip "receives" the click). At body
        // root with position:fixed + z-index it sits above everything and hit-tests cleanly.
        document.body.appendChild(menuEl);
        place(at);
        // 进子菜单:同一枚浮层换内容,高度变了就按同一套规矩重新钳位。顶上「‹ 返回」回到主菜单。
        function drill(parent: Act): void {
          if (!menuEl || !parent.sub) return;
          const back = el("button", { className: "hk-item hk-back", draggable: false }, [
            el("span", { className: "hk-label", textContent: `‹ ${parent.label}` }),
          ]);
          back.setAttribute("role", "menuitem");
          back.addEventListener("click", (e) => {
            e.stopPropagation();
            menuEl?.replaceChildren(...rowsFor(getActions()));
            place(at);
            // 退回来焦点落在刚才进去的那一项(W5 A2:← 退回)
            [...(menuEl?.querySelectorAll<HTMLButtonElement>(".hk-has-sub") ?? [])]
              .find((b) => b.querySelector(".hk-label")?.textContent === parent.label)
              ?.focus({ preventScroll: true });
          });
          menuEl.replaceChildren(back, ...rowsFor(parent.sub()));
          place(at);
          menuEl.querySelector<HTMLButtonElement>(".hk-item:not(.hk-back)")?.focus({ preventScroll: true });
        }
        menuOpenFlag = true;
        setActive();
        openMenuCloser = api.shut;
        iconBtn.setAttribute("aria-expanded", "true");
        document.addEventListener("click", onDocClick, true);
        document.addEventListener("keydown", onMenuKey, true);
        menuEl.addEventListener("keydown", onMenuNav); // ⚠ 先于 holdKeyboard 那只挂(同一元素按注册序跑)
        hold = holdKeyboard(menuEl, menuEl, {
          onEscape: () => closeMenu(true),
          focus: menuEl.querySelector<HTMLButtonElement>(".hk-item"),
        });
      }
      closeMenu = (restoreFocus = false) => {
        clearTimeout(closeTimer);
        const wasOpen = menuEl !== null;
        if (menuEl) {
          menuEl.remove();
          menuEl = null;
        }
        menuOpenFlag = false;
        if (openMenuCloser === api.shut) openMenuCloser = null;
        iconBtn.setAttribute("aria-expanded", "false");
        document.removeEventListener("click", onDocClick, true);
        document.removeEventListener("keydown", onMenuKey, true);
        const h = hold;
        hold = null;
        // 还焦点:还给打开它的那枚(⋯ / 右键时焦点所在);那枚已被重画换掉 = 还给这张卡此刻的 ⋯。
        h?.release(restoreFocus);
        if (wasOpen && restoreFocus) {
          const a = document.activeElement;
          if ((a === null || a === document.body || !card.contains(a)) && card.isConnected) focusRow(api);
        }
        if (!hovering && !card.contains(document.activeElement)) clearActiveIfMine();
      };
      api.shut = () => closeMenu(false);
      openMenuRef = openMenu; // let the keyboard (`/`) open this render's menu
      return wrap;
    }

    return {
      menu,
      focus: () => {
        if (!card.isConnected) return;
        setActive();
        focusRow(api);
      },
    };
  }

  function reset(): void {
    // 接力(见 keep):选中的那张有 id 才记。⛔ 别记没 id 的 —— 那种卡重画后认不回来。
    const alive = navOrder();
    if (keep?.wanted) {
      // 点名要的那张还没接上:留着它。焦点此刻在被选中那张上的话,这份「焦点要回去」也并进去。
      if (keep.focus === null && activeRow && focusOn(activeRow) !== null) keep.focus = "btn";
    } else if (activeRow && activeRow.id !== null) {
      const i = alive.indexOf(activeRow);
      const ids = (rs: Row[]): string[] => rs.map((r) => r.id).filter((x): x is string => x !== null);
      keep = {
        id: activeRow.id,
        after: i < 0 ? [] : ids(alive.slice(i + 1)),
        before: i < 0 ? [] : ids(alive.slice(0, i).reverse()),
        focus: focusOn(activeRow),
        wanted: false,
      };
    } else {
      keep = null;
    }
    openMenuCloser?.();
    activeRow = null;
    rows = [];
  }

  function leave(card: HTMLElement): void {
    const r = rows.find((x) => x.card === card);
    if (!r) return;
    const alive = navOrder();
    const i = alive.indexOf(r);
    const focus = focusOn(r);
    if (openMenuCloser === r.shut) openMenuCloser?.();
    rows = rows.filter((x) => x !== r);
    card.classList.remove("is-active");
    if (activeRow !== r) return;
    activeRow = null;
    // 原位后一张(最后一张就往前一张)—— W5 A3:此前选中整个清掉,再按 ↓ 从第一张数起
    const next = i < 0 ? null : (alive[i + 1] ?? alive[i - 1] ?? null);
    if (!next) return;
    setActiveRow(next);
    if (focus !== null) {
      focusRow(next);
      next.card.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  function want(id: string, focus: boolean): void {
    // 同一张本来就记着「焦点在它身上」(重画前焦点就在它那儿)的,别因为这次不要焦点就丢了那一半
    const f: FocusMark | null = focus ? "btn" : keep !== null && keep.id === id ? keep.focus : null;
    keep = { id, after: [], before: [], focus: f, wanted: true };
    // ⛔ 不当场接:调用方都是「点名之后紧跟一次重画」(撤销 / 收起放大编辑 / 落点那一发),当场接的话会在
    // 重画**之前**就把这份点名用掉(那时焦点还在要被拆掉的浮层里,接不上),重画后反而什么也不剩。
    // 等下一批 register(同一次重画里已经注册过的,register 时已经排了接力)。
  }

  function destroy(): void {
    openMenuCloser?.();
    rows = [];
    keep = null;
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("mousedown", onDownAnywhere, true);
  }

  return { register, reset, leave, want, destroy };
}

// ---- 视图级全局单键 --------------------------------------------------------
// header 上的全局动作(新建任务 / 回收站 / 新建标签 …)没有「悬停的卡片」可挂,但同样
// 该能不碰鼠标就触发——尤其全屏时鼠标要跑很远。这里给「整个视图」注册单键:不悬停任何
// 卡片也生效;焦点在输入框、或带修饰键(让给系统级 Ctrl+Alt+N/M)时让位。
//
// 选键务必和该视图的卡片单键(hotkey 菜单里的 E/C/L/S/P/B/D/]/[ …)错开,否则悬停一张
// 卡片时同一个键会两义。返回卸载函数,视图 unmount 时调一次。
export type ViewKey = { key: string; run: () => void };

// ---- 内联选择器的「Esc / 点别处 收起」手势 ---------------------------------
// 卡片上就地展开的选择器(标签 L / 截止 S / 优先级 P …)不该再挂「取消」按钮——和 ⋯ 菜单
// 同一套约定:Esc 或点选择器以外任意处即收起。抽出来让三个选择器一致(单一真相源)。
//
// `root` = 选择器容器(点它内部不算离开);`close` = 收起(通常重渲回展示态)。返回 teardown:
// 选中某项走 mutate+重渲的路径必须先手动调它,否则 document 监听泄漏。放行 ⋯ 菜单浮层
// (portal 到 body)与看大图遮罩——那是卫星 UI,不该误触发收起。
// `opts.escape`:Esc 走另一条路(158 G2 / A2 截止框:点别处 = 存、Esc = 不存);不给则 Esc 与点别处同为 `close`。
export function armDismiss(root: HTMLElement, close: () => void, opts: { escape?: () => void } = {}): () => void {
  function teardown(): void {
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("mousedown", onDown, true);
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    e.preventDefault();
    teardown();
    (opts.escape ?? close)();
  }
  function onDown(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    if (root.contains(t)) return;
    if (t.closest(SATELLITE_LAYERS)) return;
    teardown();
    close();
  }
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("mousedown", onDown, true);
  return teardown;
}

export function registerViewKeys(keys: ViewKey[]): () => void {
  function onKey(e: KeyboardEvent): void {
    // 卡片单键先接(W3 159 / Q12):悬停 / 选中的卡把这个键派发掉了(`createHotkeyController` 的 onKey 会
    // preventDefault),视图键就让位 —— 看板回收站里悬停卡按 R = 还原这张,而不是同时把回收站收起。
    // ⚠ 依赖注册顺序:各视图都先 `createHotkeyController()`(mount 开头)、后 `registerViewKeys`(mount 末尾),
    // 同一 document 的同相监听按注册序触发 ⇒ 卡片那只先跑。⛔ 别把视图键挪到卡片控制器之前注册。
    if (e.defaultPrevented) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.key.length !== 1) return;
    const want = e.key.toUpperCase();
    const k = keys.find((x) => x.key === want);
    if (!k) return;
    e.preventDefault();
    k.run();
  }
  document.addEventListener("keydown", onKey);
  return () => document.removeEventListener("keydown", onKey);
}

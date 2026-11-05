// 「移到别的空间」那块面板 —— 随记 / 看板 / 长文三处共用一份(W3 159 / Q4 + A2 + A10 + A12)。
//
// 此前三处各长各的(WD-38):随记是卡右一行小灰字 + 描边胶囊、看板是卡内朱红实心钮、长文是卡下描边框;
// 两处说「编辑历史」一处说「历史版本」;点了目标空间就走,后果只是一行小灰字(WD-16);回执是约 2 秒的
// 跟随小黑条、没有「去看看」;挪不动时随记那处把成文的话又过了一遍 errText,「已删除」三个字被认成
// 「要改的那一条已经不在了」(WD-01);看板卡按 M 后两枚钮全长在列的可视区外、焦点留在侧栏(WD-12);
// 进行中的任务落到对方「待办」最上,前后都没说(WD-09)。
//
// 现在照手机的形(cardpanel 的 move 子面):
//   · 先说后果:那边新生一条、这边不留;**编辑历史会随移动永久删除,不迁入目标空间**(cross-space-move
//     §2.4 / §4:告知必须在提交之前)—— 这是规矩不是毛病,只把话说在前头;
//   · 选目标空间(按 space_id,重名靠 distinctSpaceLabels 的尾注分清)→ 下面另起一行问「移到「X」?」
//     + 「确认移动」一拍。执行钮出现在**另一行**,不落在刚点的那枚目标钮上(§3.2 第 2 条),双击目标钮
//     只是选了两次;
//   · 任务另说一句列不随迁(core `move_item::target_stage_for`:任务一律落目标空间的落点列、列首):
//     问句与回执都点名「会落在那边「待办」最上,原来在「进行中」」—— 落点列的名字现读**目标空间**的列表
//     (列可以改名,拿本空间的名字会说错);
//   · 回执走通用提示条(toast.ts::toastGo,同一条通道、≥2.2 s),带「去看看」= 切到目标空间并定位新那条;
//   · 挪不动(两条预检拒)的话**原样**写在面板里(那是 moveOutcomeText 成文的一句,⛔ 别再过 errText);
//     抛错(目标什么都没建)才过 errText;
//   · 部分成功(目标已建、源还在 / 未知)**先落登记**再更新面板(独立于 DOM,取消 / 重画 / 切空间都冲不掉,
//     codex 实现审二轮那条),面板只留原话与「知道了(刷新)」—— ⛔ 绝不提供重跑整个移动;
//   · 打开即滚进视野、焦点落在第一枚目标钮上,Tab 在面板里转圈不出去;Esc / 点面板以外 = 取消。
import "./move-space.css";
import {
  type MoveResult,
  type SpaceInfo,
  distinctSpaceLabels,
  invokeInSpace,
  moveItemToSpace,
  moveOutcomeText,
  movePartialMark,
  spaceLabel,
} from "./space";
import { armDismiss } from "./hotkey-menu";
import { toastGo } from "./toast";
import { errText } from "./err";
import { t } from "./i18n";
import { el } from "./dom";
import { type BoardColumn, LANDING_COLUMN, columnName } from "./board-columns";

export type MovePanelOpts = {
  itemId: string;
  /** 发起那一刻的源空间(登记键;宿主 mount 时捕获的那个)。 */
  sourceSpace: string;
  /** 可移入的其他空间(活着、不是源)。宿主保证非空(空 = 不给「移动」入口)。 */
  targets: SpaceInfo[];
  /** 任务卡现在那一列的名字(看板给);随记 / 长文给 null。落点列名由本件现读目标空间。 */
  fromColumn: { id: string; name: string } | null;
  /** 取消 / Esc / 点别处:宿主把卡画回原样。 */
  onClose: () => void;
  /** 移走了:宿主让卡离场 / 重拉。回执由本件发。 */
  onMoved: () => void;
  /** 部分成功、用户点了「知道了(刷新)」(或面板已不在场):宿主重画,让常驻提示冒出来。 */
  onPartial: () => void;
  /** 回执上的「去看看」:切到目标空间并定位新那一条(notebook 的 ViewCtx.openItem)。 */
  goSee: (space: string, itemId: string) => void;
  /** 宿主 mount 级的确认 teardown 槽(同 trash-purge):给 off = 登记,给 null = 已自拆。 */
  claimConfirm: (off: (() => void) | null) => void;
  /** 宿主要的额外类名(长文那边的选择器 / Esc 判据认 `.doc-move`)。 */
  extraClass?: string;
};

/** 建面板。宿主负责把它挂进卡里,**挂上之后**调返回的 `reveal()`(滚进视野 + 给焦点;对游离节点是空操作)。 */
export function movePanel(opts: MovePanelOpts): { panel: HTMLElement; reveal: () => void } {
  const labels = distinctSpaceLabels(opts.targets);
  const labelOf = (id: string): string => labels.get(id) ?? spaceLabel(opts.targets.find((s) => s.id === id) ?? { id, name: null });

  const warn = el("p", { className: "move-warn" }, [
    t("space.moveWarnPre"),
    el("b", { textContent: t("space.moveWarnBold") }),
    t("space.moveWarnPost"),
  ]);
  const kids: Node[] = [warn];
  if (opts.fromColumn) kids.push(el("p", { className: "move-col", textContent: t("space.moveColNote") }));

  let picked: string | null = null;
  let moving = false;
  // 落点列的名字(任务才要):按目标空间现读,选中哪个读哪个;读回来时已改选别的 = 作废。
  let landing: string | null = null;
  let pickSeq = 0;

  const targetBtns = opts.targets.map((s) => {
    const b = el("button", { className: "move-target", type: "button", textContent: labelOf(s.id) });
    b.setAttribute("aria-pressed", "false");
    b.addEventListener("click", () => void pick(s.id));
    return b;
  });
  const targetRow = el("div", { className: "move-targets" }, [el("span", { className: "move-to", textContent: t("space.moveTo") }), ...targetBtns]);
  const question = el("p", { className: "move-q", hidden: true });
  const err = el("p", { className: "move-err", hidden: true });
  const yes = el("button", { className: "move-yes", type: "button", textContent: t("space.moveYes"), hidden: true });
  const no = el("button", { className: "move-no", type: "button", textContent: t("space.moveCancel") });
  const actions = el("div", { className: "move-actions" }, [yes, no]);
  kids.push(targetRow, question, err, actions);

  const panel = el("div", { className: `move-panel${opts.extraClass ? ` ${opts.extraClass}` : ""}` }, kids);
  panel.setAttribute("role", "group");
  panel.setAttribute("aria-label", t("space.moveTitle"));

  // ---- 收场 ----------------------------------------------------------------
  let off: (() => void) | null = null;
  let closed = false;
  // 宿主那枚槽位此刻还是不是我们的:宿主先收了我们(重画 / 开了别的确认)之后,⛔ 别再去把槽位置空 ——
  // 那时登记着的已经是别人的确认,置空 = 它的文档级监听没人收(移动在飞时宿主重画,结果回来才收场,正是这一格)。
  let owned = true;
  /** 拆监听 + 交还宿主槽位(不画)。 */
  const disarm = (): void => {
    const f = off;
    off = null;
    f?.();
    if (owned) {
      owned = false;
      opts.claimConfirm(null);
    }
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    disarm();
    opts.onClose();
  };
  const arm = (): void => {
    off = armDismiss(panel, () => {
      off = null; // armDismiss 已自拆
      // 在飞:结果回来自有去处,点别处 / Esc 不把面板收掉(收了就看不到部分成功那句);接着守着。
      if (moving) arm();
      else close();
    });
  };
  arm();
  // 宿主重画 / 开别的确认时先收这一块:只拆监听,不再回调宿主重画(那一发重画正是宿主自己在做)。
  opts.claimConfirm(() => {
    owned = false;
    closed = true;
    const f = off;
    off = null;
    f?.();
  });
  no.addEventListener("click", () => {
    if (!moving) close();
  });

  // Tab 在面板里转圈(A10:此前焦点在侧栏,Tab 一下到侧栏「标签」,进不了移动区)。
  panel.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const f = [...panel.querySelectorAll<HTMLButtonElement>("button")].filter((b) => !b.hidden && !b.disabled);
    if (f.length === 0) return;
    const i = f.indexOf(document.activeElement as HTMLButtonElement);
    if (e.shiftKey && i <= 0) {
      e.preventDefault();
      f[f.length - 1].focus();
    } else if (!e.shiftKey && (i === -1 || i === f.length - 1)) {
      e.preventDefault();
      f[0].focus();
    }
  });
  // 面板里的键归面板(卡片单键 / 视图单键别接 —— 焦点在钮上时 R / N 之类会被视图键当成开关)。
  panel.addEventListener("keydown", (e) => {
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) e.stopPropagation();
  });

  // ---- 选目标 → 问一句 -------------------------------------------------------
  function paintQuestion(): void {
    if (picked === null) return;
    const name = labelOf(picked);
    const from = opts.fromColumn;
    question.textContent =
      from === null || landing === null
        ? t("space.moveQ", { name })
        : from.id === LANDING_COLUMN
          ? t("space.moveQTask", { name, col: landing })
          : t("space.moveQTaskFrom", { name, col: landing, from: from.name });
  }
  async function pick(id: string): Promise<void> {
    if (moving) return;
    picked = id;
    landing = null;
    for (const b of targetBtns) b.setAttribute("aria-pressed", String(b === targetBtns[opts.targets.findIndex((s) => s.id === id)]));
    err.hidden = true;
    question.hidden = false;
    yes.hidden = false;
    paintQuestion();
    yes.focus({ preventScroll: true });
    actions.scrollIntoView({ block: "nearest" });
    if (opts.fromColumn === null) return;
    const mine = ++pickSeq;
    try {
      const cols = await invokeInSpace<BoardColumn[]>(id, "list_board_columns");
      const col = cols.find((c) => c.id === LANDING_COLUMN);
      if (mine !== pickSeq || col === undefined) return;
      landing = columnName(col);
      paintQuestion();
      // 问句长了一截(多出列名那半句),把「确认移动」顶到了列的可视区外 —— 再滚一次(真实例截图逮到的)。
      if (panel.isConnected) actions.scrollIntoView({ block: "nearest" });
    } catch {
      // 读不到对方的列名:问句照旧只问空间(列不随迁那句已在面板上),不编一个列名出来。
    }
  }

  // ---- 确认 → 移 -------------------------------------------------------------
  const setBusy = (b: boolean): void => {
    moving = b;
    for (const x of [...targetBtns, yes]) x.disabled = b;
    no.disabled = b;
  };
  function showErr(text: string): void {
    err.textContent = text;
    err.hidden = false;
  }
  /** 部分成功的终点:目标已建,提交按钮永久撤走,只留原话与「知道了(刷新)」。 */
  function stopForPartial(msg: string): void {
    targetRow.remove();
    question.remove();
    showErr(msg);
    const got = el("button", { className: "move-no", type: "button", textContent: t("space.moveGotIt") });
    got.addEventListener("click", () => {
      closed = true;
      disarm();
      opts.onPartial();
    });
    actions.replaceChildren(got);
    got.focus({ preventScroll: true });
  }

  yes.addEventListener("click", () => void confirm());
  async function confirm(): Promise<void> {
    if (moving || picked === null) return;
    const target = picked;
    const name = labelOf(target);
    const colInfo = opts.fromColumn && landing !== null ? { landing, from: opts.fromColumn.id === LANDING_COLUMN ? null : opts.fromColumn.name } : null;
    setBusy(true);
    let r: MoveResult;
    try {
      r = await moveItemToSpace(opts.sourceSpace, target, opts.itemId);
    } catch (e) {
      // 抛错 = 目标什么都没建(目标 commit 之后的失败一律走结构化结果),可重试;认不出的才带「出错:」。
      setBusy(false);
      showErr(errText(e));
      return;
    }
    const text = moveOutcomeText(r, name, colInfo);
    switch (r.outcome) {
      case "moved": {
        const newId = r.new_id;
        closed = true;
        disarm();
        toastGo(text, t("inbox.goSee"), () => opts.goSee(target, newId));
        opts.onMoved();
        return;
      }
      case "copied_but_source_kept":
      case "copied_but_source_unconfirmed":
        // 先落登记(独立于 DOM),再更新眼前的面板;面板已不在场就直接让宿主重画。
        movePartialMark(opts.sourceSpace, opts.itemId, text);
        moving = false;
        if (panel.isConnected) stopForPartial(text);
        else {
          closed = true;
          disarm();
          opts.onPartial();
        }
        return;
      case "images_pending":
      case "dangling_refs":
        // 成文的一句,原样写(A2:此前随记那处过了 errText,「已删除」被认成「那一条已经不在了」)。
        setBusy(false);
        showErr(text);
        return;
      default: {
        const exhaustive: never = r;
        return exhaustive;
      }
    }
  }

  const reveal = (): void => {
    if (!panel.isConnected) return;
    panel.scrollIntoView({ block: "nearest" });
    targetBtns[0]?.focus({ preventScroll: true });
  };
  return { panel, reveal };
}

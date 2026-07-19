import {
  type MoveResult,
  type SpaceInfo,
  currentSpaceId,
  distinctSpaceLabels,
  invoke,
  invokeInSpace,
  listSpaces,
  moveItemToSpace,
  movePartialClear,
  movePartialMark,
  movePartialNote,
  spaceLabel,
} from "./space";
import { autoGrow } from "./autogrow";
import { copyText } from "./clipboard";
import {
  type FilterState,
  applyFilter,
  reconcileTopicFilter,
  renderFilterPills,
  wireFilterInput,
} from "./filter-bar";
import { type Act, armDismiss, createHotkeyController, registerViewKeys } from "./hotkey-menu";
import {
  type ImageMeta,
  imageStrip,
  listImages,
  pendingImages,
  renderContent,
  wirePasteToAttach,
} from "./item-images";
import type { View, ViewCtx } from "./notebook";
import { applyTagColor } from "./tag-color";
import { dayKey, dayLabel, startOfWeek, when } from "./tasktime";
import "./inbox.css";

// Mirrors of the Rust contracts (lib.rs) — the fields this view consumes. 想法 = a live
// idea (未归类 + 已归类 merged); a tag is just metadata it may or may not carry, so one
// shape covers both. (The wire also carries `stage`; 73 起删除=进回收站 for every idea,
// so the frontend no longer routes on it and stopped declaring it.)
// A tag on an idea: id + title + optional chip color (`#RRGGBB` or null = 无色),同看板。
type IdeaTag = { id: string; title: string; color: string | null };
type IdeaItem = {
  id: string;
  content: string;
  created_at: string;
  topics: IdeaTag[];
};
type RevisionItem = { content: string; archived_at: string };
type TopicItem = { id: string; title: string; color: string | null };
// 灵感流转统计(lib.rs idea_stats):纯派生、只算不存。born_inbox=0(还没有出生态
// 已知的灵感,0018 前的老数据不算)时不显比例——数字从补列那天起诚实积累。
type IdeaStats = { captured_week: number; born_inbox: number; converted: number };

// The 想法/回收站 tabs share one card renderer; this is the union it accepts —
// both route through row(). (146 摘掉只读的「去向」第三 tab后,Tab 收回 Mode。)
type Mode = "ideas" | "archived";
type Tab = Mode;

// Which tab (想法 / 回收站) is showing. Module scope so it survives a view switch:
// navigate() unmounts+remounts on every switch, and a mount-scope default would snap
// back to 想法 each time you leave and return. (Same rationale as topics.ts `expanded`
// and board.ts `topicFilter`.) Only one inbox view is mounted at a time.
let active: Tab = "ideas";
// 跨视图「跳到这条灵感」通道(ui-audit P1 #8:搜索命中灵感/回收站 → 定位那张卡)。
// search.ts 先 focusInboxItem(id, tab) 再 navigate("inbox");refresh 在 seq 守卫之后
// 消费(同 board.ts focusId 纪律):切 tab、清筛选让目标必然可见、设 pulseId 脉冲并
// 滚到视野中央。目标已离场(转待办/彻底删的窄窗)= 静态落 tab,不残留。用完即清。
let pendingFocus: { id: string; tab: Mode; space: string } | null = null;
export function focusInboxItem(id: string, tab: Mode): void {
  // 携带发起那刻的空间(codex P1 二审 M):落地前若切了空间,请求自弃——A 的跳转
  // 不许在 B 的列表上清筛选/切 tab。
  pendingFocus = { id, tab, space: currentSpaceId() };
}
// 「记下灵感」的草稿与暂存图不随视图/tab 切换蒸发(ui-audit P1 #9d):文字过桥走模块态
// (unmount / 切去无 compose 的 tab 时存,composeBar 重建时消费灌回);暂存图直接把
// pendingImages 提到模块级——root 节点由每个新 bar append 搬家,预览/字节原地存活
// (原先仅 mount 级=跨 refresh 存活,跨视图仍丢)。save 成功先清空输入框与暂存图,
// 不会把已保存的内容再灌回来。
// **按空间分桶**(codex P1 审 H1):草稿随 mount 时的空间打标,空间对不上=丢弃——
// A 空间的草稿/暂存图绝不灌进 B 空间(切空间时 notebook 先翻 current 再 unmount,
// 标记必须取 mount 时捕获的空间)。
let composeDraftSaved = "";
let composeDraftSpace: string | null = null;

/** 空间两来路 H1(notebook.ts 草稿探针的模块态半边):compose 文字存底或暂存图
 *  还攥在模块态里 = 有未保存内容(DOM 里的 textarea 由探针另一半覆盖)。 */
export function inboxHasStashedDraft(): boolean {
  return composeDraftSaved.trim().length > 0 || pendImgs.count() > 0;
}
// 挂图失败/保存失败的提示过桥(codex 三审 M 升模块级):save 后 refresh 会重建
// composeBar,旧 bar 的 err 会被冲掉——由同空间的新 bar 领走显示一次;本 mount 已死
// 时同理过桥给下一个 mount,失败不许因为切了个视图就无声。
let composeNotice = "";
let composeNoticeSpace: string | null = null;
// 活 mount 的重读通道(codex 四审 M):旧 mount 的保存链在 unmount 后才落账时,同空间
// 的新 mount 得马上重读(顺带经 composeBar 领走模块 notice)——否则「正文被清了、
// 卡片没出现」要等到下次 refocus。navigate 恒先 unmount 旧再 mount 新,单值不互踩。
let liveRefresh: (() => void) | null = null;
const pendImgs = pendingImages();
// in-flight 闸提模块级(codex P1 审 H2):保存往返期间切走再回来,新 mount 的闸必须
// 还是同一把——否则同一草稿能被重提两次。
let composeSaving = false;
// 想法 tab 的两维筛选(标签 pills + 文本过滤词):行为与看板同源(共享件
// filter-bar.ts),模块态理由同 `active`。只作用于想法 tab;回收站不筛(同看板的
// 回收站/归档不筛)。文本只匹配当前正文——连历史的找回忆是全局「搜索」视图的事。
const filter: FilterState = { topic: "all", text: "" };
// Scroll offset of the list, captured on unmount and restored on the next mount so a
// view switch returns you to where you were reading (not snapped back to the top).
// Belongs to the tab in `active` above — since that tab is preserved too, the offset
// always lands on the same list it was taken from.
let savedScroll = 0;

type CardItem = {
  id: string;
  content: string;
  created_at: string;
  topics?: IdeaTag[];
};

// ---- small DOM helper ------------------------------------------------------
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) node.append(c);
  return node;
}

// In the 想法 timeline the day is already the group heading, so each card only needs
// its time-of-day; 回收站 cards (a flat list) keep the full date+time via the shared
// when() (tasktime.ts — adds the year across a year boundary).
const hm = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });

// ---- timeline grouping (想法 tab) ------------------------------------------
// dayKey/dayLabel 已提为共享件(tasktime.ts):看板归档视图的时间轴同源复用。

const TABS: Tab[] = ["ideas", "archived"];

const SKELETON = `
  <header data-tauri-drag-region>
    <h1>灵感</h1>
    <span class="idea-stats" id="idea-stats"></span>
  </header>
  <nav class="tabs">
    <button class="tab active" id="tab-ideas" data-tab="ideas">灵感<span class="tab-n" id="n-ideas"></span></button>
    <button class="tab" id="tab-archived" data-tab="archived">回收站<span class="tab-n" id="n-archived"></span></button>
  </nav>
  <div class="filter-row" id="filter-row" hidden>
    <div class="topic-filter" id="idea-topic-filter"></div>
    <input class="filter-text" id="idea-filter" type="search" placeholder="过滤灵感…" autocomplete="off" spellcheck="false" />
  </div>
  <main id="list"></main>
`;

export function mount(root: HTMLElement, _ctx: ViewCtx): View {
  // 本 mount 归属的空间(codex P1 审 H1):切空间时 notebook 先翻 current 再 unmount,
  // unmount 时现取会把 A 空间的草稿标成 B 的——在这里捕获。空间对不上的存底整体丢弃。
  const mountSpace = currentSpaceId();
  if (composeDraftSpace !== null && composeDraftSpace !== mountSpace) {
    composeDraftSaved = "";
    composeDraftSpace = null;
    pendImgs.clear();
  }
  const view = el("div", { className: "v-inbox" });
  view.innerHTML = SKELETON;
  root.replaceChildren(view);

  const list = view.querySelector("#list") as HTMLElement;
  const statsEl = view.querySelector("#idea-stats") as HTMLElement;
  const filterRow = view.querySelector("#filter-row") as HTMLElement;
  const filterBar = view.querySelector("#idea-topic-filter") as HTMLElement;
  const filterInput = view.querySelector("#idea-filter") as HTMLInputElement;
  const tabEls: Record<Tab, HTMLButtonElement> = {
    ideas: view.querySelector("#tab-ideas") as HTMLButtonElement,
    archived: view.querySelector("#tab-archived") as HTMLButtonElement,
  };
  const countEls: Record<Tab, HTMLElement> = {
    ideas: view.querySelector("#n-ideas") as HTMLElement,
    archived: view.querySelector("#n-archived") as HTMLElement,
  };

  // 悬停选中 + ⋯ 速查菜单 + 单键派发,统一走共享控制器(单一真相源跨视图一致)。
  const hk = createHotkeyController();

  // 单一编辑态(全局只允许一张卡进编辑)。开一张前先关掉上一张:closeActiveEdit 既拆掉编辑态
  // 的文档级按键监听、又把上一张卡 showView 回视图态。Esc/Enter 因此永远只对当前编辑态生效。
  let closeActiveEdit: (() => void) | null = null;
  // (ui-audit P1 #9a)unmount 专用:只拆监听不 commit——unmount 可能因切空间而来,此刻
  // invoke 已注入新空间 id,绝不能把旧条目的编辑写进新空间;残留监听更不许在新视图上
  // 对旧 id 发 commit(此前 unmount 根本不摘,点新视图任意处就误提交)。
  let teardownActiveEdit: (() => void) | null = null;
  // 破坏性确认的文档级监听(P1 #12)也是 mount 级单值(codex P1 审 M3):重画/切 tab/
  // unmount 统一收走,残留监听不许吞掉新视图的第一记 Esc。同时至多一个确认在场。
  let confirmOff: (() => void) | null = null;
  function disarmConfirm(): void {
    const f = confirmOff;
    confirmOff = null;
    if (f) f();
  }

  // 可移入的其他空间(cross-space-move v1):挂载时取一次——空间集变化必经 notebook
  // 空间菜单(切换/新建)→ 当前视图重挂,重挂即重取,不会陈旧。空列表 = 单空间,
  // 「移动」动作整个不出现(≥2 空间才有入口,§4)。
  let otherSpaces: SpaceInfo[] = [];
  void listSpaces()
    .then((all) => {
      otherSpaces = all.filter((s) => s.alive && s.id !== currentSpaceId());
    })
    .catch(() => {});

  // A centered big/detail block as a node (so it can sit below the compose bar).
  function centerNode(big: string, detail: string): HTMLElement {
    return el("div", { className: "center" }, [
      el("div", { className: "big", textContent: big }),
      el("div", { textContent: detail }),
    ]);
  }

  function renderCenter(big: string, detail: string): void {
    list.replaceChildren(centerNode(big, detail));
  }

  // 新建入口的暂存配图/文字草稿/失败提示:见模块级 pendImgs / composeDraftSaved /
  // composeNotice(P1 #9d + codex 三审 M)。
  // 刚在本视图记下的灵感:下一次渲染给它一记朱砂脉冲(.just-born),用完即清——
  // 只有「此刻新生」的卡片有入场感,存量列表安安静静。
  let pulseId: string | null = null;
  // in-flight 闸(ui-audit P0 #2)在模块级 composeSaving:refresh 会重建 bar 并把草稿
  // 回灌进新框,新 bar 的 Enter 也必须被同一把闸挡住;闸跨 mount 才挡得住「保存中切走
  // 再回来」(codex P1 审 H2)。

  // The 想法 compose bar: type a new inspiration, Enter (or 记下) captures it.
  // Reuses `capture_note` — the same path as the Ctrl+Alt+N floating window.
  function composeBar(): HTMLElement {
    const input = el("textarea", { className: "compose-input", rows: 1 }) as HTMLTextAreaElement;
    input.placeholder = "记下一个灵感… (Enter 保存,Shift+Enter 换行)";
    if (composeDraftSaved !== "" && composeDraftSpace === mountSpace) {
      input.value = composeDraftSaved; // 上个 mount/别的 tab 留下的草稿:同空间才灌回(P1 #9d)
      composeDraftSaved = "";
    }
    const err = el("p", { className: "form-err", hidden: true });
    if (composeNotice && composeNoticeSpace === mountSpace) {
      err.textContent = composeNotice;
      err.hidden = false;
      composeNotice = "";
      composeNoticeSpace = null;
    }
    pendImgs.wire(input); // Ctrl+V 图片 → 暂存预览,随灵感一起存(纯图不写字也能存,同捕获浮窗)
    const save = async () => {
      if (composeSaving) return;
      composeSaving = true;
      try {
        await doSave();
      } finally {
        composeSaving = false;
      }
    };
    const doSave = async () => {
      const submitted = input.value;
      if (!submitted.trim() && pendImgs.count() === 0) return;
      // 「保存那刻」冻结整份载荷(codex P1 二审 H2):图批同步带走,IPC 等待期间新粘贴
      // 的归下一条。整条链走 invokeInSpace(mountSpace)——必落账写不许走「跨空间迟到
      // 永不决议」的统一包装,否则模块级 in-flight 闸的 finally 永不执行、保存锁死(H1)。
      const batch = pendImgs.takeBatch();
      let id: string;
      try {
        id = await invokeInSpace<string>(mountSpace, "capture_note", { content: submitted });
      } catch (e) {
        // 没建成:同空间才把图退回预览区(可重试);空间已切走的批 revoke 即弃——绝不
        // 追加进别的空间的预览区随人家的条目保存(codex 三审 H)。错误找活的输入区显示
        // (旧 bar 已脱离 DOM 就 document 级找同空间的新 bar),都不在场就走模块态过桥
        // ——失败不许无声(复查 L1 + codex 三审 M)。
        if (currentSpaceId() === mountSpace) pendImgs.putBack(batch);
        else pendImgs.disposeBatch(batch);
        const liveErr = err.isConnected
          ? err
          : currentSpaceId() === mountSpace
            ? document.querySelector<HTMLElement>(".v-inbox .compose .form-err")
            : null;
        if (liveErr !== null) {
          liveErr.textContent = String(e);
          liveErr.hidden = false;
        } else if (currentSpaceId() === mountSpace) {
          composeNotice = String(e);
          composeNoticeSpace = mountSpace;
          if (!unmounted) void refresh();
        }
        return;
      }
      // 等 capture_note 的空档里,过滤 refresh/视图切换可能已重建 compose 并把草稿灌进
      // 新框——清「当前在场」的输入框而非闭包里的旧节点(document 级找,新 mount 的框
      // 也归它管;codex P1 二审 H1 余波)。同空间且值仍等于刚提交的正文才清:等待期间
      // 用户接着打的字不能吞(极端并发下宁多留不误删)。
      const current = document.querySelector<HTMLTextAreaElement>(".v-inbox .compose-input");
      if (current !== null && currentSpaceId() === mountSpace && current.value === submitted) {
        current.value = "";
        autoGrow(current); // back to one row (same as the board compose reset)
      }
      // 保存中切走时 unmount 会把提交前的输入框内容存进模块态:成功即作废同内容的
      // 存底,回来不再灌回已保存的正文(codex P1 审 H2)。
      if (composeDraftSaved === submitted) composeDraftSaved = "";
      const notices: string[] = [];
      // 筛着具体标签记灵感 → 新灵感自动挂上该标签(同看板「筛着标签建卡」),否则
      // 新卡会被当前筛选当场滤到隐身;「无标签」筛选下新卡本就无标签、天然可见。
      // 挂失败不吞掉:灵感已在,提示一句(切「所有」能找到)。
      if (filter.topic !== "all" && filter.topic !== "none") {
        try {
          await invokeInSpace(mountSpace, "file_note_to_topic", { id, topicId: filter.topic, newTitle: null });
        } catch {
          notices.push("灵感已保存,但标签未能挂上(切到「所有」可见)");
        }
      }
      // 灵感已入库,再挂暂存图(同一保存的一部分,恒决议);挂失败不吞掉(fail-fast)。
      const failed = await pendImgs.attachBatch(id, batch, mountSpace);
      if (failed > 0) notices.push(`灵感已保存,但 ${failed} 张图未能附加(可在卡片编辑态重新粘贴)`);
      if (notices.length > 0) {
        composeNotice = notices.join(";");
        composeNoticeSpace = mountSpace;
      }
      if (unmounted) {
        // 本 mount 已死但落账已完成(codex 四审 M):通知同空间活 mount 马上重读——
        // 新卡上列表,模块 notice 也随 composeBar 重建当场亮出来。
        if (currentSpaceId() === mountSpace) liveRefresh?.();
        return;
      }
      // 文本过滤下记灵感:新卡多半不含过滤词,会被当场滤到隐身——清掉过滤让它可见
      // (同看板;标签筛选不清,新卡刚挂上该标签、本来就在视野里)。
      if (filter.text !== "") {
        filter.text = "";
        filterInput.value = "";
      }
      pulseId = id;
      void refresh();
    };
    input.addEventListener("input", () => autoGrow(input)); // grows to fit, CSS-capped at 160
    input.addEventListener("keydown", (e) => {
      if (e.isComposing) return; // IME 组合期的 Enter 是上屏,不是保存(ui-audit P0 #1)
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void save();
      }
    });
    const addBtn = el("button", { className: "compose-add", textContent: "记下", onclick: () => void save() });
    // 暂存图条换行独占一行(.compose 本就 flex-wrap);root 是常驻节点,从上一个 bar 搬过来。
    return el("div", { className: "compose" }, [input, addBtn, pendImgs.root, err]);
  }

  // 只给「读取失败」(refresh 整批拉取挂了)用;卡级操作失败走卡上的就地错误行。
  // 带「重试」——错误页把列表整个替换掉了,总得给一条不切视图的回头路(ui-audit P0 #6)。
  function renderError(message: string): void {
    list.replaceChildren(
      el("div", { className: "center" }, [
        el("div", { className: "big", textContent: "读取失败" }),
        el("div", { className: "err-box", textContent: message }),
        el("button", { className: "no", textContent: "重试", onclick: () => void refresh() }),
      ]),
    );
  }

  // ---- tab state -----------------------------------------------------------
  // `active` is module-scope (survives view switches, see its declaration).
  const counts: Record<Tab, number> = { ideas: 0, archived: 0 };

  // Fingerprint of the last rendered state. refresh() runs on every window refocus
  // (alt-tab back) but skips the DOM rebuild when this matches — refresh without flicker
  // (and a half-typed compose / open inline editor survives an idle refocus).
  let lastSig = "";
  // refresh() 代次(codex 二审 M3):指纹只挡「同签名的 refocus 重画」,挡不住普通 refresh
  // 的旧响应乱序覆盖——补一道 generation,await 回来已非最新那一发就不落 DOM。
  let refreshSeq = 0;
  // mount 已死的硬闸(codex P1 审 M1):unmount 后仍在途的 save 链不许重启 refresh——
  // 那会拿新 seq 通过守卫、在脱离 DOM 的旧列表上渲染、抢食模块级 pendingFocus。
  let unmounted = false;

  // Restore the saved scroll offset once, after the first mount render. Only true until
  // that render lands, so tab switches (which also rebuild the list) don't wrongly
  // reapply a stale offset — they start at the top.
  let restorePending = true;

  function updateTabs(): void {
    for (const m of TABS) {
      countEls[m].textContent = counts[m] > 0 ? String(counts[m]) : "";
      tabEls[m].classList.toggle("active", active === m);
    }
  }

  function renderEmpty(mode: Tab): void {
    if (mode === "ideas") {
      renderCenter("还没有灵感", "在上方输入,或按 Ctrl+Alt+N 随手记一个念头。");
    } else {
      renderCenter("回收站是空的", "删掉的灵感会先来这里,可还原或彻底删除。");
    }
  }

  // A card has left its current tab. Animate it out, then reconcile counts: it
  // moved from `from` to `to` (null = gone for good). Show the empty state when
  // the active tab's last card leaves.
  function leaveCard(note: HTMLElement, from: Mode, to: Mode | null): void {
    note.classList.add("removing");
    // A leaving card must not stay the shortcut target (it's about to detach) — the
    // action that removes it always fires from this card, so dropping active state is safe.
    hk.reset();
    // Remove when the fade-out transition ends — but transitionend is NOT guaranteed to
    // fire (an interrupted transition, a backgrounded/headless WebView, or reduced-motion
    // with a 0s transition can all skip it), which would strand the card mid-fade with the
    // backend already updated. So also remove after the known max transition window; the
    // `done` latch makes whichever path fires first idempotent.
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      note.remove();
      counts[from] -= 1;
      if (to) counts[to] += 1;
      updateTabs();
      // 想法 tab 顶着常驻筛选条:pills 计数(所有/无标签/各标签)必须跟上离场的卡,
      // 筛空时还得亮「筛空」空态而不是留白——离场动画完成后走整列重渲对齐一切。
      // 回收站没有筛选条,保留原轻路径(动画离场即完)。
      if (from === "ideas") {
        void refresh();
        return;
      }
      if (active === from && counts[from] === 0) renderEmpty(from);
    };
    note.addEventListener("transitionend", finish, { once: true });
    setTimeout(finish, 260); // ≥ the .note transition (≤0.22s); a missed event never strands the card
  }

  // One note card, rendered for the active tab's `mode`:
  //   ideas    — 编辑/待办/标签/删除; 转待办→离开灵感(去看板),打标签→留下长新 chip。
  //              删除=软删进回收站(73 起未归类也不例外,可还原故零确认);销毁只在
  //              回收站的「彻底删除」里发生。
  //   archived — 还原/彻底删除;冻结,不可编辑/转待办/归纳。
  function row(item: CardItem, mode: Mode): HTMLElement {
    const note = el("article", { className: mode === "archived" ? "note archived" : "note" });
    if (item.id === pulseId) {
      pulseId = null;
      note.classList.add("just-born");
      // 只在脉冲(born-pulse)结束时摘 class——卡片自己的入场 rise 也会冒泡 animationend,
      // 见 end 就摘会把 0.9s 的脉冲截在 rise 的 0.3s 上。
      const onEnd = (e: AnimationEvent) => {
        if (e.animationName !== "born-pulse") return;
        note.classList.remove("just-born");
        note.removeEventListener("animationend", onEnd);
      };
      note.addEventListener("animationend", onEnd);
    }
    let currentContent = item.content;
    const topics = item.topics ?? [];
    const tagged = topics.length > 0;

    const textP = el("p", { className: "note-text", textContent: currentContent });
    // 想法 sits in a per-day timeline → time-of-day only; 回收站 is flat → full stamp.
    const stamp = mode === "ideas" ? hm.format(new Date(item.created_at)) : when(item.created_at);
    const timeT = el("time", { className: "note-time", textContent: stamp });
    const body = el("div", { className: "note-body" });

    // Tag chips — a 想法 may carry tags (just metadata); show them whenever present.
    // Single-entity model: a task is the same subject at a board stage, so it lives on the
    // board — never here — hence no "待办" flag.
    let tagsEl: HTMLElement | null = null;
    if (tagged) {
      tagsEl = el(
        "div",
        { className: "tags" },
        topics.map((t) => {
          const chip = el("span", { className: "tag", textContent: t.title });
          applyTagColor(chip, t.color); // 有色标签着色(左色点 + 淡底),同看板 chip
          return chip;
        }),
      );
    }

    const errLine = () => el("p", { className: "form-err", hidden: true });
    const showErr = (node: HTMLElement, e: unknown) => {
      node.textContent = String(e);
      node.hidden = false;
    };
    // 卡级操作(转待办/删除/还原/彻底删除)失败的就地错误行(ui-audit P0 #6):错误
    // 写在这张卡上,绝不再把整版列表换成错误页(renderError 只留给读取失败)。惰性
    // 建行、复用同一条——连续失败不累积多条相同错误;showView 重渲后自动重建。
    let opErr: HTMLElement | null = null;
    const showOpErr = (e: unknown): void => {
      if (opErr === null || !opErr.isConnected) {
        opErr = errLine();
        note.append(opErr);
      }
      showErr(opErr, e);
    };

    // 转待办 succeeded: the subject is now a board task (a task stage), so it leaves
    // 灵感 entirely — animate it out, with no destination tab (it's on the board now).
    // This is the single-entity de-dup.
    const afterPromote = () => leaveCard(note, "ideas", null);
    // 打标签 succeeded: the idea stays in the 想法 list (tags are metadata, no split) —
    // reload so the fresh chip shows and 删除 switches to the soft (回收站) path.
    const afterFile = () => void refresh();

    // ---- 配图 (item images) ----
    // The card's images, cached so the 正文 can linkify 「图N」 references and the strip can
    // render without each render refetching. Loaded once on first view, refreshed after an
    // attach/delete. A 图N with no matching image stays plain text (renderContent's rule).
    let imgs: ImageMeta[] = [];
    function paintContent(): void {
      textP.replaceChildren(renderContent(currentContent, imgs));
    }
    async function loadImages(): Promise<void> {
      try {
        imgs = await listImages(item.id);
      } catch {
        imgs = [];
      }
      paintContent();
    }

    // ---- view (default) ----
    function showView(): void {
      note.classList.remove("editing", "confirming");
      const strip = imageStrip(item.id, { editable: false });
      const kids: Node[] = [textP, timeT, ...(tagsEl ? [tagsEl] : []), strip.root];
      // 部分成功登记(cross-space-move):目标已建、源还在——提示常驻卡面、随重渲
      // /重启存续(localStorage),「移动」入口同时被 actionsFor 藏起;处理完(手动
      // 删掉一边)后点解除恢复。
      const partialMsg = mode === "ideas" ? movePartialNote(item.id) : null;
      if (partialMsg) {
        kids.push(
          el("div", { className: "move-partial" }, [
            el("p", { className: "form-err", textContent: partialMsg }),
            el("button", {
              className: "no",
              textContent: "我已处理,解除",
              onclick: () => {
                movePartialClear(item.id);
                void refresh();
              },
            }),
          ]),
        );
      }
      body.replaceChildren(...kids);
      void loadImages(); // linkify 「图N」 once the metas arrive (text shows immediately meanwhile)
      // Operations no longer sit in a permanent button row — they live behind the
      // ⋯ corner menu (hover it for the shortcut cheat-sheet) and on the single-key
      // shortcuts when this card is active. The menu is rebuilt each render so it
      // always closes fresh.
      note.replaceChildren(body, handle.menu());
    }

    // ---- 编辑 (with append-only history) ----
    async function openEdit(): Promise<void> {
      // 单一编辑态:先关掉任何已打开的另一张卡的编辑(回视图 + 拆它的按键监听)。
      if (closeActiveEdit) closeActiveEdit();
      note.classList.add("editing");
      const area = el("textarea", { className: "edit-area", value: currentContent });
      area.addEventListener("input", () => autoGrow(area)); // no CSS cap — full text stays visible, like the view state
      const hist = el("div", { className: "history" });

      // 配图编辑器:粘贴截图(Ctrl+V)→ 挂为下一张「图N」;每张缩略图可删(编号不复用)。
      // ＋图 选文件入口已删——配图统一靠粘贴(Ctrl+V)。
      const imgEditor = el("div", { className: "img-editor" });
      const imgErr = el("p", { className: "img-err", hidden: true });
      const strip = imageStrip(item.id, { editable: true, onChange: () => void loadImages() });
      const afterAttach = () => {
        imgErr.hidden = true;
        void strip.reload();
        void loadImages();
      };
      const onImgErr = (e: unknown) => {
        imgErr.textContent = String(e);
        imgErr.hidden = false;
      };
      wirePasteToAttach(area, item.id, afterAttach, onImgErr);
      imgEditor.append(strip.root, imgErr);

      // 编辑态显示该灵感的标签(纯展示、复用读态 .tags 样式):编辑原文时一眼看到挂了哪些标签。
      // 打/去标签仍走 ⋯ 菜单的 标签(L)(和看板一致);无标签则整行收起(nodes 为空)。
      const tagView = el(
        "div",
        { className: "tags" },
        (item.topics ?? []).map((t) => {
          const chip = el("span", { className: "tag", textContent: t.title });
          applyTagColor(chip, t.color);
          return chip;
        }),
      );
      // 编辑态:输入框 + 标签 + 配图条 + 历史。Enter/点别处 保存、Esc 取消、Ctrl+V 配图 都是隐式
      // 手势,不再常驻一行说明书(用户拍板:学一次就够,常驻提示是纯噪音)。
      body.replaceChildren(area, tagView, imgEditor, hist);

      // 离开编辑态的唯一出口:拆掉文档级按键/点击监听、清掉单一编辑态登记、回视图。save 成功后也走它。
      // `closed` 幂等锁:点别处保存(异步)与随后的重渲/切卡可能重复调用,只执行一次。
      let closed = false;
      function leaveEdit(): void {
        if (closed) return;
        closed = true;
        document.removeEventListener("keydown", onKey);
        document.removeEventListener("mousedown", onDown);
        if (closeActiveEdit === commit) closeActiveEdit = null;
        if (teardownActiveEdit === leaveEdit) teardownActiveEdit = null;
        // 列表整体重渲染时这张卡已离开 DOM,无需(也不该)再 showView——只拆监听即可。
        if (note.isConnected) showView();
      }

      const err = errLine();
      let saving = false; // 幂等:点别处/回车/切卡可能并发触发,保存中再触发直接让位
      const save = async () => {
        if (saving) return;
        saving = true;
        try {
          await invoke("edit_note", { id: item.id, content: area.value });
        } catch (e) {
          showErr(err, e);
          saving = false;
          return;
        }
        currentContent = area.value;
        textP.textContent = currentContent;
        leaveEdit();
      };

      // 提交编辑:空内容(后端拒空)或没改动(edit_note 对 no-op 会 fail-fast)都当「取消」——
      // 直接回视图、不打后端;真有改动才 save。Enter、点别处、切到别的卡都走这一条路。
      const commit = (): void => {
        if (area.value.trim() === "" || area.value === currentContent) {
          leaveEdit();
          return;
        }
        void save();
      };

      // Esc 取消 / Enter 提交 监听在文档级,而非输入框上 —— 焦点离开框(点了缩略图 /
      // 卡片空白)时也生效。Shift+Enter 仍在框内换行。别的输入框(如 compose 记灵感)保留自己的键。
      const onKey = (e: KeyboardEvent) => {
        if (e.isComposing) return; // IME 组合期的 Enter/Esc 属于输入法,不是提交/取消(ui-audit P0 #1)
        const t = e.target;
        if ((t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) && t !== area) return;
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          leaveEdit();
        }
      };
      // 点这张卡以外的任何地方 = 默认保存(需求:点别处即提交)。落点在本卡内(文本框 /
      // 缩略图 / 历史 / 提示行)不算离开;落在看大图遮罩、别卡的 ⋯ 菜单浮层(portal 到 body)
      // 也放行——那是编辑态的卫星 UI,不该误触发保存。
      const onDown = (e: MouseEvent): void => {
        const t = e.target as HTMLElement;
        if (note.contains(t)) return;
        if (t.closest(".img-lightbox, .hk-menu")) return;
        commit();
      };
      document.addEventListener("keydown", onKey);
      document.addEventListener("mousedown", onDown);
      // 单一编辑态:开别的卡前先 commit 本卡(保存已改动 / 无改动即收回),而非丢弃。
      closeActiveEdit = commit;
      teardownActiveEdit = leaveEdit;

      note.replaceChildren(body, err);
      autoGrow(area); // size to the text only now that it's connected (a detached node measures 0)
      area.focus();

      // History loads lazily; only show the disclosure if there are past versions.
      try {
        const revs = await invoke<RevisionItem[]>("list_note_history", { id: item.id });
        if (revs.length === 0) return;
        const panel = el(
          "div",
          { className: "hist-panel", hidden: true },
          revs.map((r) =>
            el("div", { className: "hist-item" }, [
              el("p", { className: "hist-text", textContent: r.content }),
              el("time", { className: "hist-time", textContent: `于 ${when(r.archived_at)} 改` }),
            ]),
          ),
        );
        const toggle = el("button", {
          className: "hist-toggle",
          textContent: `历史 ${revs.length} 版`,
          onclick: () => {
            panel.hidden = !panel.hidden;
          },
        });
        hist.replaceChildren(toggle, panel);
      } catch {
        // History is a nicety; if it fails to load, editing still works.
      }
    }

    // ---- 转待办 (manual todo) ----
    // 转待办 = 翻 stage 到 todo,零副本、一步到位:按当前原文直转,不弹确认/编辑框。
    // 想改标题就先按 E 编辑、或转过去后在看板改(改标题会照常进历史)。
    async function doPromote(): Promise<void> {
      try {
        await invoke("promote_note_to_task", { id: item.id, title: currentContent });
      } catch (e) {
        // 直转失败时把错误显示在卡上(而非静默),复用共享错误行(不累积)。
        showOpErr(e);
        return;
      }
      afterPromote();
    }

    // ---- 归纳主题 (manual file into an existing/new topic) ----
    async function openTopic(): Promise<void> {
      note.classList.add("editing");
      const err = errLine();
      const fileInto = async (topicId: string | null, newTitle: string | null) => {
        try {
          await invoke("file_note_to_topic", { id: item.id, topicId, newTitle });
        } catch (e) {
          showErr(err, e);
          return;
        }
        afterFile();
      };

      const newInput = el("input", { className: "field" });
      (newInput as HTMLInputElement).placeholder = "新建标签名…";
      const newBtn = el("button", {
        className: "do",
        textContent: "新建并归入",
        onclick: () => fileInto(null, newInput.value),
      });
      newInput.addEventListener("keydown", (e) => {
        if (e.isComposing) return; // IME 组合期不劫持(ui-audit P0 #1)
        if (e.key === "Enter") {
          e.preventDefault();
          newBtn.click();
        } else if (e.key === "Escape") {
          e.preventDefault();
          showView();
        }
      });

      const form = el("div", { className: "inline-form" }, [
        el("label", { className: "form-label", textContent: "打标签" }),
      ]);

      try {
        const topics = await invoke<TopicItem[]>("list_topics");
        if (topics.length > 0) {
          form.append(
            el(
              "div",
              { className: "chips" },
              topics.map((t) =>
                el("button", {
                  className: "chip",
                  textContent: t.title,
                  onclick: () => fileInto(t.id, null),
                }),
              ),
            ),
          );
        } else {
          form.append(el("p", { className: "hint", textContent: "还没有标签,新建一个:" }));
        }
      } catch (e) {
        showErr(err, e);
      }

      form.append(
        el("div", { className: "new-topic" }, [newInput, newBtn]),
        err,
        el("div", { className: "form-actions" }, [
          el("button", { className: "no", textContent: "取消", onclick: showView }),
        ]),
      );
      note.replaceChildren(body, form);
      newInput.focus();
    }

    // ---- 删除 (soft delete → 回收站, recoverable so no confirm) ----
    async function doArchive(): Promise<void> {
      try {
        await invoke("archive_note", { id: item.id });
      } catch (err) {
        showOpErr(err); // 卡级失败就地报错,不换掉整版列表(ui-audit P0 #6)
        return;
      }
      leaveCard(note, "ideas", "archived");
    }

    // ---- 还原 (回收站 → 想法) ----
    async function doRestore(): Promise<void> {
      try {
        await invoke("restore_note", { id: item.id });
      } catch (err) {
        showOpErr(err);
        return;
      }
      leaveCard(note, "archived", "ideas");
    }

    // ---- 彻底删除 (回收站: permanent, inline two-step confirm) ----
    // 确认态响应 Esc/点别处收起(ui-audit P1 #12,armDismiss 与 ⋯ 菜单同一套手势);
    // teardown 走 mount 级 confirmOff 单值(codex M3)。
    function openPurge(): void {
      disarmConfirm();
      note.classList.add("confirming");
      const off = armDismiss(note, () => {
        confirmOff = null; // armDismiss 已自拆:只归零,别重复拆
        showView();
      });
      confirmOff = off;
      const confirmPurge = async () => {
        disarmConfirm();
        try {
          await invoke("purge_note", { id: item.id });
        } catch (err) {
          showOpErr(err);
          return;
        }
        leaveCard(note, "archived", null);
      };
      note.replaceChildren(
        body,
        el("div", { className: "confirm" }, [
          el("button", {
            className: "no",
            textContent: "取消",
            onclick: () => {
              disarmConfirm();
              showView();
            },
          }),
          el("button", { className: "do", textContent: "彻底删除", onclick: confirmPurge }),
        ]),
      );
    }

    // ---- 移动到其他空间 (cross-space-move v1) ----
    // 内联选择器:标题里先亮「编辑历史将随移动永久删除」(告知必须在提交之前,§4),
    // 点空间名即移(重名空间带尾注辨识)。结果分道:只有 moved 离场;两个部分成功态
    // (kept / unconfirmed)**永久撤走提交按钮**、只留说明与「知道了(刷新)」——绝不
    // 提供重跑整个移动(会制造第二份);两预检拒可改再试。in-flight 闸挡双击并发。
    function openMove(): void {
      note.classList.add("confirming"); // 单键挂起(suspended 判据含 confirming)
      const err = errLine();
      const labels = distinctSpaceLabels(otherSpaces);
      let moving = false;
      const chipBtns = otherSpaces.map((s) =>
        el("button", {
          className: "chip",
          textContent: labels.get(s.id) ?? spaceLabel(s),
          onclick: () => void doMove(s.id),
        }),
      );
      const chips = el("div", { className: "chips" }, chipBtns);
      const actionsRow = el("div", { className: "form-actions" }, [
        el("button", { className: "no", textContent: "取消", onclick: showView }),
      ]);
      const form = el("div", { className: "inline-form" }, [
        el("label", { className: "form-label", textContent: "移动到…(编辑历史将随移动永久删除)" }),
        chips,
        err,
        actionsRow,
      ]);
      note.replaceChildren(body, form);

      const setBusy = (b: boolean) => chipBtns.forEach((btn) => (btn.disabled = b));
      // 部分成功的终点:目标已建,提交按钮永久移除;「知道了(刷新)」重拉列表,让
      // 源卡显出触发拒删的最新状态(S1)与常驻登记提示。
      const stopForPartial = (msg: string) => {
        showErr(err, msg);
        chips.remove();
        actionsRow.replaceChildren(
          el("button", { className: "no", textContent: "知道了(刷新)", onclick: () => void refresh() }),
        );
      };

      async function doMove(target: string): Promise<void> {
        if (moving) return;
        moving = true;
        setBusy(true);
        const sourceSpace = currentSpaceId(); // 发起那一刻的源空间(登记键)
        let r: MoveResult;
        try {
          r = await moveItemToSpace(sourceSpace, target, item.id);
        } catch (e) {
          // 抛错 = 目标什么都没建(目标 commit 之后的失败一律走结构化结果),可重试。
          showErr(err, e);
          moving = false;
          setBusy(false);
          return;
        }
        switch (r.outcome) {
          case "moved":
            // 迟到(期间取消/重渲/切空间)= 卡片已脱离 DOM:列表由现任渲染负责,
            // 只在还在源空间时补一次刷新,把已被移走的卡从陈列里收掉。
            if (note.isConnected) leaveCard(note, "ideas", null);
            else if (currentSpaceId() === sourceSpace) void refresh();
            return;
          case "copied_but_source_kept":
            settlePartial(`已复制到目标空间,但原条目删除未执行:${r.reason}。两边各有一份,确认后可手动删除本条`);
            return;
          case "copied_but_source_unconfirmed":
            settlePartial(`已复制到目标空间,但删除原条目时出错(原条目状态未知):${r.error}。请核对两边,勿重复移动`);
            return;
          case "images_pending":
            showErr(err, `有 ${r.count} 张配图的字节还没同步到齐,稍后再移`);
            moving = false;
            setBusy(false);
            return;
          case "dangling_refs":
            showErr(err, `正文引用了已删除的配图(图${r.seqs.join("、图")}),暂不支持移动`);
            moving = false;
            setBusy(false);
            return;
        }
        // 部分成功:**先落登记**(独立于 DOM,取消/重渲/切空间/重启都冲不掉,
        // 该条目的「移动」入口随之隐藏),再更新眼前的表单;表单已脱离 DOM 就
        // 触发重渲,让登记提示以卡面常驻形态冒出来。
        function settlePartial(msg: string): void {
          movePartialMark(sourceSpace, item.id, msg);
          if (form.isConnected) stopForPartial(msg);
          else if (currentSpaceId() === sourceSpace) void refresh();
        }
      }
    }

    // ---- ⋯ corner menu + single-key shortcuts (the manual triage hub) --------
    // The card's actions are declared once and reused by the menu AND the keyboard
    // via the shared hotkey controller. Operations are unchanged: 编辑/转待办/打标签 open
    // their inline forms, 删除/彻底删除 run their two-step confirm, 复制 flashes 已复制.
    const copyFeedback = async (): Promise<string> => {
      try {
        await copyText(currentContent);
        return "已复制";
      } catch {
        return "复制失败";
      }
    };
    function actionsFor(): Act[] {
      if (mode === "archived") {
        return [
          { label: "还原", key: "R", run: doRestore },
          { label: "复制", key: "C", feedback: copyFeedback },
          { label: "彻底删除", key: "D", run: openPurge, danger: true },
        ];
      }
      const list: Act[] = [
        { label: "编辑", key: "E", run: openEdit },
        { label: "待办", key: "T", run: doPromote },
        { label: "标签", key: "L", run: openTopic },
        { label: "复制", key: "C", feedback: copyFeedback },
      ];
      // 移动到其他空间(cross-space-move v1):≥2 空间才出现(单空间是纯噪音);
      // 该条目有部分成功登记(目标已建、源还在)时入口整个藏起——绝不提供重跑。
      if (otherSpaces.length > 0 && !movePartialNote(item.id)) {
        list.push({ label: "移动", key: "M", run: openMove });
      }
      // 73: 删除=进回收站,不再按 stage 分流(59 的 inbox 硬删 UI 就此退役——tombstone
      // 在同步语义里是全网抹掉、不可复活,不该是删除键的默认归宿)。软删可还原,故与
      // filed 先例一致零确认;真要销毁走回收站的「彻底删除」。
      list.push({ label: "删除", key: "D", run: doArchive, danger: true });
      return list;
    }
    // A card mid inline-edit / mid-confirm owns the keyboard (its own Enter/Esc), so
    // global shortcuts stand down then.
    const handle = hk.register(
      note,
      actionsFor,
      () => note.classList.contains("editing") || note.classList.contains("confirming"),
    );

    // 双击卡片 = 默认操作「编辑」(和单键 E 同一入口)。回收站卡片冻结、不编辑;双击在
    // ⋯ 菜单 / 按钮 / 输入框上时不劫持(让它们自己的点击生效)。
    if (mode === "ideas") {
      note.addEventListener("dblclick", (e) => {
        if (note.classList.contains("editing") || note.classList.contains("confirming")) return;
        if ((e.target as HTMLElement).closest("a, button, input, textarea, .hk-menu-wrap, .img-strip")) return;
        void openEdit();
      });
    }

    showView();
    return note;
  }

  // The 回收站 toolbar: a quiet note + 清空回收站 (inline two-step confirm).
  function trashBar(n: number): HTMLElement {
    const actions = el("div", { className: "trash-actions" });
    const err = el("p", { className: "form-err", hidden: true });
    // 确认态响应 Esc/点别处收起(ui-audit P1 #12);teardown 走 mount 级 confirmOff
    // 单值(codex M3:trashBar 每次 refresh 重建,闭包局部的 off 会随旧 bar 泄漏)。
    const showDefault = () => {
      disarmConfirm();
      actions.replaceChildren(
        el("button", { className: "no", textContent: "清空回收站", onclick: showConfirm }),
      );
    };
    function showConfirm(): void {
      const doPurge = async () => {
        disarmConfirm();
        try {
          await invoke("purge_archived");
        } catch (e) {
          // 失败就地写在工具条上并退回默认态,不再整版换错误页(ui-audit P0 #6)。
          err.textContent = String(e);
          err.hidden = false;
          showDefault();
          return;
        }
        void refresh();
      };
      err.hidden = true;
      disarmConfirm();
      const off = armDismiss(actions, () => {
        confirmOff = null; // armDismiss 已自拆:只归零
        showDefault();
      });
      confirmOff = off;
      // 执行钮在左、取消在右(ui-audit P0 #4):.trash-actions 靠右对齐,确认态出现后
      // 原「清空回收站」的落点被「取消」接住——手抖/双击的第二击落在取消上,而不是
      // 一击不可恢复的「彻底删除全部」。
      actions.replaceChildren(
        el("button", { className: "do", textContent: `彻底删除全部 ${n} 条`, onclick: doPurge }),
        el("button", { className: "no", textContent: "取消", onclick: showDefault }),
      );
    }
    showDefault();
    return el("div", { className: "trash-bar" }, [
      el("span", { className: "trash-note", textContent: "删掉的灵感会一直留在这,直到你彻底删除" }),
      err,
      actions,
    ]);
  }

  // Fetch both lists (small, single-user), sync the tab counts, render active.
  // `refocus` is set only by the window-refocus reload (alt-tab back): that path
  // skips the DOM rebuild when nothing changed, so refreshing doesn't flicker. Every
  // other caller (mutations, tab switch, first load) renders unconditionally — image
  // attach/detach refreshes via strip.reload() and isn't in list_ideas, so an explicit
  // refresh() must always repaint to relink body 图N chips.
  async function refresh(refocus = false): Promise<void> {
    if (unmounted) return; // 死 mount 不再发起任何刷新(codex M1:防抢食模块级 pendingFocus)
    const seq = ++refreshSeq;
    try {
      const [ideas, archived, stats, topics] = await Promise.all([
        invoke<IdeaItem[]>("list_ideas"),
        invoke<IdeaItem[]>("list_archived"),
        // 本地周一 00:00 换成 UTC RFC3339 给后端(后端从不算本地时间,同 due_on 的哲学)。
        invoke<IdeaStats>("idea_stats", { weekStart: startOfWeek().toISOString() }),
        // 筛选 pills 要认识全部标签(死标签回落判断 + 正被筛的零计数标签的标题)。
        invoke<TopicItem[]>("list_topics"),
      ]);
      if (seq !== refreshSeq) return; // 有更晚的 refresh 已在途:旧响应不落 DOM(乱序覆盖/计数错位)

      // 跨视图跳转(P1 #8):seq 守卫之后取走(同 board),陈旧的 refresh 不碰它;
      // 空间对不上=弃(codex 二审 M)。
      let focus = pendingFocus;
      pendingFocus = null;
      if (focus && focus.space !== mountSpace) focus = null;
      if (focus) {
        active = focus.tab;
        if (focus.tab === "ideas") {
          // 清筛选让目标必然可见(跳转即揭示,同 board focusOnBoard)。
          filter.topic = "all";
          filter.text = "";
          filterInput.value = "";
        }
        const pool = focus.tab === "ideas" ? ideas : archived;
        if (pool.some((i) => i.id === focus.id)) pulseId = focus.id;
        restorePending = false; // 跳转的滚动定位赢过「回到上次读的位置」
      }

      // 死标签回落(删除/合并后别让筛选条指着空气)——纯状态修正,先于指纹(共享件)。
      reconcileTopicFilter(filter, topics);
      const q = filter.text.trim().toLowerCase();

      // Fingerprint everything that affects the DOM; an idle refocus whose fingerprint
      // matches bails before touching the list (no flicker), and a half-typed compose /
      // open inline editor survives. `todayKey` is folded in so the day-grouped 时间轴
      // relabels 今天→昨天 if the app sits open across midnight.
      const todayKey = new Date().toDateString();
      const sig = JSON.stringify([active, filter.topic, q, todayKey, ideas, archived, stats, topics]);
      // `=== true`, not truthy: guards against a future caller wiring `refresh` as a
      // bare event handler, where a MouseEvent would otherwise count as a refocus.
      if (refocus === true && sig === lastSig) return;
      lastSig = sig;

      // 记灵感 Enter 后 refresh 会连 compose bar 一起重建,焦点随旧输入框被换掉——
      // 连记第二条就得再按 N。重建前焦点在输入框的,渲染完还给新输入框(看板 compose
      // 常驻不重建、提交后 focus() 留焦点;这里补齐同款「连续录入」手感)。
      // 半打的正文同理:过滤框每敲一字都 refresh(重建 compose),不带走草稿就等于
      // 「敲过滤词毁正文」——重建前存下 value/光标,渲染完灌回新输入框(暂存图片由
      // pendImgs.root 搬家存活,这条是文字的对称面)。save 成功已先清空旧框,存到的
      // 是空串,不会把已保存的正文再灌回去。
      const oldCompose = view.querySelector<HTMLTextAreaElement>(".compose-input");
      const hadComposeFocus = oldCompose !== null && document.activeElement === oldCompose;
      const composeDraft = oldCompose?.value ?? "";
      const composeCursor = oldCompose?.selectionStart ?? 0;

      // Cards are about to be replaced — drop any stale active/menu state first, and tear
      // down an open editor's document-level key listener (it would leak otherwise). After
      // the refocus short-circuit, so an idle refocus that keeps an open editor is untouched.
      hk.reset();
      disarmConfirm(); // 卡片将被整批替换:在场确认的文档级监听一并收走(codex M3)
      if (closeActiveEdit) closeActiveEdit();
      counts.ideas = ideas.length;
      counts.archived = archived.length;
      updateTabs();
      // 头部一行淡字统计(和标签计数同性质的纯信息)。比例=累计:生而为灵感的条目里
      // 有多少转过待办(含后来归档/进回收站的——经历是史实);分母 0(全是 0018 前的
      // 老数据)时只显捕获数,不显「—」的哑谜。
      statsEl.textContent =
        `本周捕获 ${stats.captured_week}` +
        (stats.born_inbox > 0
          ? ` · 转待办 ${Math.round((stats.converted / stats.born_inbox) * 100)}%`
          : "");
      if (active === "ideas") {
        // 筛选行:有想法才出现(同看板);pills 计数从全量想法派生(不随文本过滤
        // 收缩,两维正交——口径在共享件 filter-bar.ts,与看板同源)。
        filterRow.hidden = ideas.length === 0;
        if (ideas.length > 0) renderFilterPills(filterBar, ideas, topics, filter, () => void refresh());
        const shown = applyFilter(ideas, filter, (i) => i.content);
        // The compose bar always sits at the top of 想法, empty or not.
        const bar = composeBar();
        if (ideas.length === 0) {
          list.replaceChildren(bar, centerNode("还没有灵感", "在上方输入,或按 Ctrl+Alt+N 随手记一个念头。"));
        } else if (shown.length === 0) {
          // 筛空 ≠ 没有灵感:提示当前筛选(词优先),别让用户以为灵感全没了(同看板)。
          const qRaw = filter.text.trim();
          const label =
            filter.topic === "none" ? "无标签" : topics.find((t) => t.id === filter.topic)?.title ?? "该标签";
          list.replaceChildren(
            bar,
            qRaw !== ""
              ? centerNode(`没有匹配「${qRaw}」的灵感`, "换个词,或清空过滤框(Esc)。")
              : centerNode(`「${label}」下没有灵感`, "切到「所有」看全部灵感。"),
          );
        } else {
          // 按天分组成时间轴:同一天的灵感归到一个日期标头下(后端已按时间倒序;
          // 渲染的是过滤后的列表,筛空的天自然消失)。
          const tl = el("div", { className: "timeline" });
          let key = "";
          let group: HTMLElement | null = null;
          for (const i of shown) {
            const k = dayKey(i.created_at);
            if (k !== key) {
              key = k;
              group = el("section", { className: "tl-group" }, [
                el("div", { className: "tl-date", textContent: dayLabel(i.created_at) }),
              ]);
              tl.append(group);
            }
            group!.append(row(i, "ideas"));
          }
          list.replaceChildren(bar, tl);
        }
      } else {
        filterRow.hidden = true; // 回收站不筛(同看板的回收站/归档视图)
        if (archived.length === 0) renderEmpty("archived");
        else list.replaceChildren(trashBar(archived.length), ...archived.map((a) => row(a, "archived")));
      }
      // 跳转定位:落 DOM 后滚到脉冲卡(row() 渲染时已消费 pulseId 加上 .just-born)。
      if (focus) list.querySelector<HTMLElement>(".just-born")?.scrollIntoView({ block: "center" });
      // 回收站 tab 没有输入框:草稿过桥进模块态,切回想法 tab 由 composeBar 灌回
      // (P1 #9d;原先 querySelector 落空即静默丢稿)。
      const newCompose = view.querySelector<HTMLTextAreaElement>(".compose-input");
      if (newCompose !== null && composeDraft !== "") {
        newCompose.value = composeDraft;
        autoGrow(newCompose);
        newCompose.setSelectionRange(composeCursor, composeCursor);
      } else if (newCompose !== null && newCompose.value !== "") {
        autoGrow(newCompose); // 模块态草稿在 composeBar() 已灌回:补一记自适应高度
      } else if (newCompose === null && composeDraft !== "") {
        composeDraftSaved = composeDraft;
        composeDraftSpace = mountSpace;
      }
      if (hadComposeFocus) newCompose?.focus();
      // First render after a (re)mount: drop back to where the user was reading before
      // they switched away. scrollTop clamps itself if the list is now shorter.
      if (restorePending) {
        restorePending = false;
        list.scrollTop = savedScroll;
      }
    } catch (err) {
      if (seq !== refreshSeq) return; // 旧请求晚失败:新请求已成功渲染,别用旧错误盖掉(codex 三审 H2)
      lastSig = ""; // error path painted — let the next refresh re-render even if data matches
      disarmConfirm(); // 换错误页也是整批替换:在场确认的文档级监听一并收走(codex 二审 M)
      renderError(String(err));
    }
  }

  function switchTo(mode: Tab): void {
    if (active === mode) return;
    active = mode;
    // A deliberate tab switch starts at the top — don't reapply the other tab's offset
    // if the first mount render hasn't happened yet.
    restorePending = false;
    savedScroll = 0;
    void refresh();
  }

  // 文本过滤:输入即筛,走 refresh() 单一渲染路径(行为在共享件 filter-bar.ts)。
  wireFilterInput(filterInput, filter, () => void refresh());

  for (const m of TABS) {
    tabEls[m].addEventListener("click", () => switchTo(m));
  }

  // 视图级全局单键:N 跳到顶部「记下灵感」输入框(全屏时省得把鼠标移上去)。
  // 输入框只在「想法」tab 才有,没有时静默无操作。
  const teardownViewKeys = registerViewKeys([
    { key: "N", run: () => view.querySelector<HTMLTextAreaElement>(".compose-input")?.focus() },
  ]);

  liveRefresh = () => void refresh(); // 本 mount 即当前活灵感视图(codex 四审 M)
  void refresh();

  return {
    unmount() {
      // Remember where the user was reading so the next mount can restore it.
      savedScroll = list.scrollTop;
      liveRefresh = null; // navigate 恒先 unmount 再 mount:新 mount 会立即接管
      // (P1 #9a)编辑态:只拆监听不 commit(理由见 teardownActiveEdit 声明处)。
      if (teardownActiveEdit) teardownActiveEdit();
      disarmConfirm(); // 在场确认的文档级监听不跨 mount 存活(codex M3)
      // (P1 #9d)compose 草稿过桥进模块态;暂存图由模块级 pendImgs 自然存活
      // (此前这里 clear 掉=切个视图就丢图丢字)。
      const liveCompose = view.querySelector<HTMLTextAreaElement>(".compose-input");
      if (liveCompose !== null) {
        composeDraftSaved = liveCompose.value;
        composeDraftSpace = mountSpace; // 空间标记取 mount 时捕获值(codex H1)
      }
      unmounted = true;
      refreshSeq++; // 作废本 mount 的在途 refresh:迟到响应不许消费新 mount 的 pendingFocus(codex M1)
      teardownViewKeys();
      hk.destroy(); // tear down the document keydown + any lingering menu listeners
      root.replaceChildren();
    },
    onFocus() {
      void refresh(true);
    },
  };
}

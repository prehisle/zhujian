// 内联标签选择器的共享件 —— 灵感(inbox.ts openTopic)与任务看板(board.ts openPicker)
// 是同一套「搜既有 + 无匹配冒『创建』 + Enter 复用/新建」的选择器 UI(单一真相源,同
// hotkey-menu.ts / filter-bar.ts 的抽法)。两视图的差异全留给调用方,不进本件:
//   · 收起手势(armDismiss 的宿主)与挂载点由调用方管;
//   · 选中/新建的落库方式由回调注入(灵感 file_note_to_topic 一步、看板 add/create 两步);
//   · allTopics 由调用方给(看板用已加载的模块态,灵感开选择器时现取)。
// 本件只产出 .topic-search + .topic-choices 的 DOM 与筛选/新建/Enter 行为;类名与两视图
// 各自 scoped 的 CSS(.v-inbox / .v-board .task-topic)对齐、原样保留,故视觉不变、e2e
// 选择器不动。
import { groupPills } from "./filter-bar";
import { t } from "./i18n";
import { el } from "./dom";

// ---- small DOM helper (same shape as the views / hotkey-menu.ts) ------------
// 一个可选标签。color 本件不用(选择器不着色),但两视图的 topic 类型都带,收成同一
// 形状省得调用方再映射一层。
export type PickerTopic = { id: string; title: string; color: string | null };

export type TagPickerOpts = {
  /** 库里全部标签(含已加的 —— 全列出来,已加的点亮)。 */
  allTopics: PickerTopic[];
  /** 已在该条目上的标签 id —— 候选里点亮(`.on`),再点一次 = 摘掉(onUnpick);Enter 精确命中它时无操作。
   *  675 起与手机端同形(此前是从候选隐藏、要摘去点卡上的 ✕;用户 2026-09-12 拍板三处统一)。 */
  have: Set<string>;
  /** 选中一个既有(未挂的)标签。 */
  onPick: (topicId: string) => void | Promise<void>;
  /** 再点一次已挂的标签 = 摘掉。 */
  onUnpick: (topicId: string) => void | Promise<void>;
  /** 输入了库里没有的新名并确认 → 新建并挂上。 */
  onCreate: (title: string) => void | Promise<void>;
  /** 选/建/摘后不收起选择器,可连续改多个:回调多半是异步落库,等它落定就地重渲候选(search
   *  文本与焦点原样留存,renderChoices 读同一个活的 `have`——调用方在回调里 `have.add` /
   *  `have.delete` 后,那枚候选的点亮态跟着翻)。默认 false = 点一下即由调用方的回调自行收起(灵感)。 */
  keepOpen?: boolean;
};

// 把选择器渲进 `container`(替换其子节点)、接好输入/Enter、聚焦搜索框。
// `container` 必须已挂在文档上 —— focus() 对游离节点是空操作(看板的 wrap 就在卡内、
// 灵感须先 append(picker) 再调本函数)。收起手势(armDismiss)与挂载由调用方自理。
export function renderTagPicker(container: HTMLElement, opts: TagPickerOpts): void {
  const { allTopics, have, onPick, onUnpick, onCreate, keepOpen = false } = opts;

  // 选/建/摘的落地:keepOpen 时等回调(异步落库)落定,再就地重渲候选并把焦点还给搜索框——
  // renderChoices 读活的 `have`(调用方已 add / delete 过),于是那枚候选的点亮态翻面、search 文本
  // 留存,可接着改下一个。默认(灵感)不重渲:调用方的回调自己会收起选择器。
  function commit(run: () => void | Promise<void>): void {
    const r = run();
    if (!keepOpen) return;
    void Promise.resolve(r).then(() => {
      renderChoices();
      search.focus();
    });
  }

  // ⚠ draggable:false 在这些件上**不是**保护:子元素的 draggable=false 挡不住可拖拽宿主(看板
  // 卡片)起拖(671 补在真 WebView2 上量的);真挡住「按住选择器起卡片拖」的是宿主自己 mousedown
  // 看落点(board.ts 的 CARD_CONTROLS 含 input / button)。留着只是标注意图 —— 同 hotkey-menu.ts。
  const search = el("input", { className: "topic-search", draggable: false });
  search.placeholder = t("tagPicker.searchPlaceholder");
  search.spellcheck = false;
  const choices = el("div", { className: "topic-choices" });

  // 一枚候选。`label` 是屏上显示的字(子标签只显后缀),`full` 恒是全名 —— 挂 title 兜底,
  // 免得「发布」这种后缀离开父上下文后认不出是谁的。已挂的点亮(.on,同手机 `.p.on` /
  // 筛选条 `.tf-pill.active` 那套语汇),再点一次走 onUnpick;title 顺带说明这一点。
  function choiceBtn(tp: PickerTopic, label: string, full: string, child: boolean): HTMLElement {
    const on = have.has(tp.id);
    const b = el("button", {
      className: `choice${child ? " child" : ""}${on ? " on" : ""}`,
      textContent: label,
      title: on ? t("tagPicker.onTitle", { name: full }) : full,
      draggable: false,
      onclick: () => commit(() => (on ? onUnpick(tp.id) : onPick(tp.id))),
    });
    b.setAttribute("aria-pressed", on ? "true" : "false");
    return b;
  }

  function renderChoices(): void {
    const q = search.value.trim();
    const ql = q.toLowerCase();
    // 已挂的不再从候选滤掉 —— 全列、点亮、再点一次摘掉(见 TagPickerOpts.have)。
    const nodes: Node[] = [];
    if (q) {
      // 搜索态**平铺显全名**:搜出来的很可能只有子没有父,缩进/后缀失去参照物
      // (同 filter-bar 在类型态下不分组的取舍)。
      for (const tp of allTopics.filter((tp) => tp.title.toLowerCase().includes(ql))) {
        nodes.push(choiceBtn(tp, tp.title, tp.title, false));
      }
    } else {
      // 空搜索态按 `父/子` 分组(499)。⛔ 分组函数从 filter-bar 借,别在这儿另抄一份 ——
      // 前缀分组的复制品今天恰好三份,`check-filter-parity` 逐字压着那三份,第四份出现
      // 它不会自动发现。这里**刻意不做折叠**:候选本来就短,且上头就是搜索框。
      for (const g of groupPills(allTopics)) {
        nodes.push(choiceBtn(g.parent, g.parent.title, g.parent.title, false));
        for (const k of g.kids) nodes.push(choiceBtn(k.topic, k.label, k.topic.title, true));
      }
    }
    // 精确同名(忽略大小写)已存在就不给「创建」—— 避免造重复;它要么在上面可选、要么已在卡上。
    const exists = ql !== "" && allTopics.some((tp) => tp.title.toLowerCase() === ql);
    if (q && !exists) {
      nodes.push(
        el("button", {
          className: "choice create",
          draggable: false,
          textContent: t("tagPicker.create", { name: q }),
          onclick: () => commit(() => onCreate(q)),
        }),
      );
    }
    // 空只剩一种形:库里一个标签都没有、也没在打字 —— 有字就有「创建」,有标签就全列着。
    if (nodes.length === 0) {
      nodes.push(el("span", { className: "topic-hint", textContent: t("tagPicker.first") }));
    }
    choices.replaceChildren(...nodes);
  }

  search.addEventListener("input", renderChoices);
  search.addEventListener("keydown", (e) => {
    if (e.isComposing) return; // IME 组合期不劫持(ui-audit P0 #1)
    if (e.key !== "Enter") return; // Esc 由调用方的 armDismiss 文档级监听处理
    e.preventDefault();
    const q = search.value.trim();
    if (!q) return;
    const match = allTopics.find((tp) => tp.title.toLowerCase() === q.toLowerCase());
    if (match) {
      // 精确命中已有 → 直接加;已在卡上则无操作 —— Enter 是「加」的手势,摘要点那枚点亮的候选。
      if (!have.has(match.id)) commit(() => onPick(match.id));
    } else {
      commit(() => onCreate(q)); // 无匹配 → 新建并加
    }
  });

  container.replaceChildren(search, choices);
  renderChoices();
  search.focus();
}

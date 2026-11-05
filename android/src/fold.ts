// 长卡折叠(用户面 116,承桌面 704)—— 从 main.ts 上抬(159 / W3 A16):随记时间轴之外,回收站与搜索结果的卡
// 也照这一套折(WM-11:很长那条在那两处整段铺开、一张卡占满一屏)。⛔ 别在各面各抄一份:夹多少行、
// 什么时候豁免、钮长什么样只许住这儿。桌面那份是 `src/fold.ts`(上限住 CSS,形不同,判据同)。
//
// 卡的身份(展开态按它记):时间轴卡 `data-id`、回收站卡 `data-trash`、搜索结果卡 `data-hit` —— 三者都是条目 id
// (ULID 全局唯一),同一条在时间轴展开过,搜到它时也是展开的,那是同一张卡、同一个「读一眼」。
import { t } from "./i18n";

/** 折起来省下的高度必须**超过那枚钮自己占的高**,否则折了反而更占地方。
 *  ⭐ 与桌面 704 那条 `FOLD_SLACK_PX`(半行 ≈ 11px)是一处**知情偏离**,不是抄漏:桌面那枚钮
 *  挂 `.act`、24px 量级,而触屏这一端的触区底线是 44(§2.3)⇒ 一张 9 行的卡折起来只省一行
 *  (约 25px)、却要为钮让出 44,**净亏**。判据换成「裁掉的 > 钮占的」,边界上那几张照旧整张
 *  摊开(没夹住就当场摘夹子,与没有本功能时逐字同形)。⛔ 别把钮改矮去迁就这个数 —— 44 是
 *  触区底线不是样式偏好;⛔ 也别改回数行数:一行可能渲染成两行,谁在褶子下面只有落 DOM 后量得出。 */
const FOLD_BTN_H = 44;

/** 夹到第几行 —— 与桌面 704 的 `max-height: 12em`(8 × 行高 1.5)同一个「8 行」。
 *  ⛔⛔ **这一端的上限只能由 JS 按 px 算,没有能用的 CSS 单位**(MuMu/Chrome 110 四档实测,
 *  读数与推演写在 index.html 那条 `.content.clamped` 的注释里):`em` 不跟 textZoom 走、
 *  `lh` 跟着走但基准是 body 不是元素自己(含方框那档只夹出 5.45 行)。唯一对两档行高
 *  (散文 1.6 / 清单 2.2)与四档字号都成立的是 `getComputedStyle().lineHeight` —— 它报的是
 *  放大**后**的真值。⛔ 别为了「上限住 CSS」把它改回单位写法,除非在最老的那台上重量一遍。 */
const FOLD_LINES = 8;

/** 展开态:只活在一次 mount 里 —— 不进库、不进 localStorage、不进同步(桌面 704 拍的形)。
 *  展开是「读一眼」的手势不是模式;存起来就要给每张卡各生一份状态、跨端语义还得重新定义。
 *  ⚠ 切空间不清:id 是 ULID 全局唯一,别的空间的卡撞不上这里的残留。 */
const foldExpanded = new Set<string>();

/** 卡的身份(见文件头);不认得的卡 = undefined(那张就不折,与没有本功能时同形)。 */
function foldKey(card: HTMLElement | null): string | undefined {
  if (!card) return undefined;
  return card.dataset.id ?? card.dataset.trash ?? card.dataset.hit;
}

/** 夹线下面有没有**还没勾**的方框 —— 折叠的豁免判据(与桌面 `hasBoxBelowFold` 同形)。
 *  ⚠ 与桌面那份有一处形上的差异:那边上限住 CSS ⇒ 先夹好再读元素底边;这一端上限由 JS 算 ⇒
 *  夹线直接是「正文顶 + 上限」,不必先写 `max-height` 再读一次(省掉一次强制重排)。
 *  ⭐ 量的是**几何**,不是「这条正文里有没有框」:豁免的理由只有一个「褶子下面的框点不到」,
 *  ⇒ 框全在前 8 行的卡**该照折**(704 的截图逮到过第一版按「有没有框」豁免,把最该折的那种
 *  ——清单在开头、后面拖着十几行记录——整张放跑了)。判据取方框**自己的底边**越过夹线(不是整行):
 *  框在行首,行尾被切掉不影响它点不点得到。
 *  ⚠ 只读面(回收站 / 搜索)的方框是 disabled、本来就点不动 ⇒ 豁免的理由在那儿不成立,只数没禁用的
 *  (时间轴上的框一律可点,这一刀对它逐字无影响)。 */
function hasBoxBelowFold(body: HTMLElement, line: number): boolean {
  return [...body.querySelectorAll<HTMLElement>(".ckline:not(.on) .ckbox:not([disabled])")].some(
    (b) => b.getBoundingClientRect().bottom > line,
  );
}

/** 钮面:箭头与筛选条父子折叠那枚同一套语言(▸/▾);这里是纵向折叠,故 ▾(下面还有)/ ▴(收回去)。 */
function foldLabel(folded: boolean): string {
  return folded ? `${t("main.unfold")} ▾` : `${t("main.fold")} ▴`;
}

/** 落 DOM 之后把「谁真被夹住了」定下来:没夹到东西的摘掉夹子(与没有本功能时逐字同形),
 *  真夹到的补一枚钮;已在 `foldExpanded` 里的摊开、但**钮照留**(否则摊开过的卡再也收不回)。
 *  画卡那边一律给正文挂 `.content.clamped`,剩下的全归这里。
 *
 *  ⭐ **读写分两趟**:逐张「量一下改一下」会把一列几十张卡变成几十次强制重排;先把三个读数
 *  一次性读完(一次布局),再统一写。
 *  ⚠⚠ **列表必须看得见**(面开着 / 时间轴没被收):藏着时量出来全是 0 ⇒ 夹子会被当成「什么也没夹到」摘掉。
 *  时间轴那边因此**必须在 `cardPanel.restore()` 之前跑**(编辑态那张卡的 `.content` 被 `display:none` 盖着)。 */
export function settleFolds(box: HTMLElement): void {
  const bodies = [...box.querySelectorAll<HTMLElement>(".content.clamped")];
  const read = bodies.map((p) => {
    // 这一档下这张卡的八行有多高。⚠ 读的是 computed 的 `lineHeight` —— textZoom 放大后它报
    // 的是真值,而 `em` / `lh` 两种单位都给不出这个数(见 FOLD_LINES 那条)。
    const cap = parseFloat(getComputedStyle(p).lineHeight) * FOLD_LINES;
    return { cap, over: p.scrollHeight > cap + FOLD_BTN_H, boxCut: hasBoxBelowFold(p, p.getBoundingClientRect().top + cap) };
  });
  bodies.forEach((p, i) => {
    const id = foldKey(p.closest<HTMLElement>(".card"));
    if (!read[i].over || id === undefined) {
      p.classList.remove("clamped"); // 夹子什么也没夹到:摘掉,别在 DOM 上留一个假状态
      return;
    }
    // 褶子下面压着还没勾的框 ⇒ 摊开,且**记进 foldExpanded**:勾选是不可变性的唯一例外(0039),
    // 而勾完最后一个框的那一下(落盘后那发重画)判据会翻面 —— 不记的话这张卡会在手指底下自己合上。
    if (read[i].boxCut) foldExpanded.add(id);
    const folded = !foldExpanded.has(id);
    if (folded) p.style.maxHeight = `${read[i].cap}px`;
    else p.classList.remove("clamped");
    p.insertAdjacentHTML(
      "afterend",
      `<button class="fold-toggle" type="button" data-fold aria-expanded="${!folded}">${foldLabel(folded)}</button>`,
    );
  });
}

/** 界面字号换档之后把夹线重量一遍。上限是 `settleFolds` 当时按 px 算死的(这一端没有跟得上
 *  textZoom 的 CSS 单位,见 FOLD_LINES),**字号一变它就不对了** —— 705 在 MuMu 上走真实 UI
 *  路径实测:130 档下 8 行变成 **6.16 行**,与桌面那个 `em` 写法的漂移曲线一模一样。
 *  ⇒ 接在 `closePaneNow` 上(字号只在设置面里改得到,必经关面),同 604 那两只 ResizeObserver
 *  的由头:⛔ **只在 render 里算一次的量,会停在上一个答案上**。
 *  ⛔ 别改成重画整面:那会把时间轴滚动位甩回顶部,而换档前后用户看的是同一处。
 *  ⚠ 只重算**已经夹着**的那几张,不重判 over —— 那要连钮的增删一起管,是 settleFolds 的活,
 *  下一次重画自然会做。⚠ 诚实边界:页内直接拨 `__zhujianTextSize.set()` 绕开这条路,
 *  台架量这一格必须走真实 UI 路径(开面 → 点档 → 关面)。回收站每次开面都现画现量,不用它;搜索结果开面不重画
 *  (上次的结果留着)⇒ `panes.ts::focusSearch` 开面时拿 `#search-results` 调一次。 */
export function resettleFolds(scope: string): void {
  const bodies = [...document.querySelectorAll<HTMLElement>(`${scope} .content.clamped`)];
  const caps = bodies.map((p) => parseFloat(getComputedStyle(p).lineHeight) * FOLD_LINES);
  bodies.forEach((p, i) => (p.style.maxHeight = `${caps[i]}px`));
}

/** 点了那枚「展开 / 收起」:翻 `.clamped` 并记进 `foldExpanded` —— 记了下一发重画才不会把它又合上。
 *  返回 true = 这一下归它管(调用方就此返回;⛔ 别让它冒到「点卡 = 开合操作面」那一支,否则展开一下面板也跟着开合)。 */
export function onFoldClick(target: HTMLElement): boolean {
  const fold = target.closest<HTMLElement>(".fold-toggle[data-fold]");
  if (!fold) return false;
  const card = fold.closest<HTMLElement>(".card");
  const id = foldKey(card);
  const body = card?.querySelector<HTMLElement>(".content");
  if (id === undefined || !body) return true;
  const folded = body.classList.toggle("clamped");
  if (folded) {
    // 收回去:上限当场按**现在这一档**重算,别拿展开前那个数(期间用户可能改过界面字号)。
    body.style.maxHeight = `${parseFloat(getComputedStyle(body).lineHeight) * FOLD_LINES}px`;
    foldExpanded.delete(id);
  } else {
    body.style.maxHeight = "";
    foldExpanded.add(id);
  }
  fold.textContent = foldLabel(folded);
  fold.setAttribute("aria-expanded", String(!folded));
  return true;
}

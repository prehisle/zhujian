// board「新建任务」与 inbox「记下灵感」保存链的共享编排件(353)。此前两侧各持一份逐字
// 近同的实现(模块态 + in-flight 闸 + doSave 骨架 + 过桥/通知),同一批 codex 轮次的修复
// 要人肉改两处;底层原语早已共享(compose-draft / item-images 的 pendingImages / autogrow /
// space 的 invokeInSpace),这里收拢的是最后一层:编排与并发。**纯编排层**——DOM 构建、
// 事件接线、灌回/开合时机全留在各视图;两侧的真实分歧(命令与载荷 / 空输入策略 / 标签
// 挂载 / 生命周期 / 错误落点 / unmount 形)由 SaveWiring 参数化保留,不做行为统一。
// 形同 pendingImages 的「工厂 + wire」两层(item-images.ts):createComposeController
// 每视图模块级一份(跨 mount 存活的并发态各视图各一份),bindSave 每个输入区接线一份
// (board compose 条常驻 = 每 mount 一次;inbox 每次重建 composeBar 一次)。
import { autoGrow } from "./autogrow";
import { clearTextDraft, loadTextDraft, saveTextDraft } from "./compose-draft";
import { pendingImages } from "./item-images";
import { currentSpaceId, invokeInSpace } from "./space";

type PendingImagesCtl = ReturnType<typeof pendingImages>;

/** 每个输入区一份的保存链接线(bindSave 的注入点)。视图间分歧全在这里参数化;
 *  骨架里的并发关键点(闸/冻结载荷/必落账/在场守卫)不外泄给视图。 */
export type SaveWiring = {
  /** mount 顶部捕获的空间(codex P1 审 H1):切空间时 notebook 先翻 current 再 unmount,
   *  链上一切空间判断都拿它对照 currentSpaceId(),绝不在 unmount 后现取。 */
  space: string;
  /** 本输入区的 textarea(提交那刻从它取快照)。 */
  input: HTMLTextAreaElement;
  /** 本输入区的就地错误落点(board 的 #compose-err / inbox bar 的 .form-err)。 */
  errEl: HTMLElement;
  /** errEl 已脱离 DOM 时找「同空间在场」错误落点的 document 级选择器
   *  (board ".v-board #compose-err" / inbox ".v-inbox .compose .form-err")。 */
  liveErrSelector: string;
  /** 清「当前在场」输入框用的 document 级选择器(board "#compose-input" /
   *  inbox ".v-inbox .compose-input")——可能已是新 mount / 新 bar 的框。 */
  liveInputSelector: string;
  /** 本 mount 已死的硬闸(codex P1 审 M1):落账后的视图收尾不许跑在死 mount 上。 */
  isUnmounted: () => boolean;
  /** 建条目的后端命令(board "create_task" / inbox "capture_note")。 */
  command: string;
  /** 空输入策略 + 载荷构造(视图分歧:board 标题必填、拒收时就地提示;inbox 允许纯图)。
   *  返回 null = 本次提交拒收——骨架在取图批**之前**退出,预览区原样不动。
   *  soleTopic = 载荷已带的单一归属标签(board 的 create_task 原子携带;inbox 的归属
   *  走 afterCreate 二次挂载,这里缺省)。 */
  prepare: (submitted: string) => { payload: Record<string, unknown>; soleTopic?: string | null } | null;
  /** 把错误写进落点(board 只写 textContent;inbox 还要掀 hidden)。 */
  showErr: (el: HTMLElement, msg: string) => void;
  /** 创建失败走模块态过桥之后的补刀(inbox:mount 还活着就 refresh 一记,让重建的
   *  bar 当场领走通知)。 */
  onBridgedError?: () => void;
  /** 建成之后、挂图之前的标签挂载(inbox 二次调 file_note_to_topic,失败 push 提示;
   *  board 不传——归属已原子随 create_task)。返回值顶替 prepare 的 soleTopic。 */
  afterCreate?: (id: string, notices: string[]) => Promise<string | null>;
  /** 挂图落定后、unmounted 判定前的通知落点(inbox:拼 notices 过桥进模块态——refresh
   *  会重建 bar,提示恒由新 bar 领走显示,活 mount 与死 mount 同一条路)。 */
  onSettled?: (notices: string[], failed: number) => void;
  /** 本 mount 已死时视图特有的部分失败落点(board:活着的看板 mount 用 op-err 横幅
   *  当场亮出来,不在场就过桥;inbox 不传——onSettled 已把提示过完桥)。 */
  onDeadMount?: (failed: number) => void;
  /** 成功且 mount 还活着的视图收尾(清过滤 / 脉冲 / 重读 / 焦点;board 还在这里写就地
   *  部分失败提示)。soleTopic = 归属标签的最终值(条件清标签筛选用)。 */
  onSaved: (id: string, soleTopic: string | null, failed: number) => void;
};

export type ComposeController = {
  /** 暂存配图控制器(模块级单例):root 随视图 mount / bar 重建搬家,预览/字节原地存活。 */
  imgs: PendingImagesCtl;
  /** 空间两来路 H1(notebook.ts 草稿探针的模块态半边):文字存底或暂存图还攥在模块态里
   *  = 有未保存内容(DOM 里的 textarea 由探针另一半覆盖)。 */
  hasStashedDraft: () => boolean;
  /** 过桥草稿正文(peek,不消费)。 */
  draftText: () => string;
  /** 过桥草稿归属空间(peek;null = 无稿)。 */
  draftSpace: () => string | null;
  /** 消费过桥草稿:取走正文并清存底(归属标记不动,与两侧原形一致)。 */
  takeDraftText: () => string;
  /** unmount / 切 tab 时把输入框内容存进模块态过桥;space 必须是 mount 顶部捕获值
   *  (codex P1 审 H1)。 */
  stashDraft: (text: string, space: string) => void;
  /** 空间对不上的存底整体丢弃(codex P1 审 H1 空间隔离):A 空间的草稿/暂存图绝不灌进
   *  B 空间;磁盘草稿与图存一并清。 */
  discardForeignDraft: (space: string) => void;
  /** 断电恢复的「输入即写」半边(198):input 事件里调,空文字自清键(compose-draft.ts)。 */
  persistText: (text: string, space: string) => void;
  /** 断电恢复:首个 mount 回填一次暂存图(填好即常驻,后续 mount 不重填)。then =
   *  回填落定后的视图钩子(board 用它把「有图而 compose 收着」的条开出来)。 */
  restoreImagesOnce: (then?: () => void) => void;
  /** 领走过桥通知(同空间才给,给完即清)——保存失败/部分失败不许因为切了个视图就无声
   *  (codex 三审 M)。 */
  takeNotice: (space: string) => string | null;
  /** 写过桥通知(视图钩子里用;space = mount 顶部捕获值)。 */
  postNotice: (msg: string, space: string) => void;
  /** 活 mount 重读通道(codex 四审 M)的登记口:mount 尾登记、unmount 置 null。
   *  navigate 恒先 unmount 旧再 mount 新,单值不会互踩。 */
  setLiveReload: (fn: (() => void) | null) => void;
  /** 造带 in-flight 闸的保存链(每个输入区接线一份;闸与模块态全视图共享)。 */
  bindSave: (w: SaveWiring) => () => Promise<void>;
};

export function createComposeController(opts: {
  /** 文字草稿的 localStorage 键(断电恢复 198;按入口分桶,见 compose-draft.ts)。 */
  draftKey: string;
  /** 暂存图草稿的 IndexedDB 分桶键(pendingImages 的 persistKey)。 */
  imagesKey: string;
}): ComposeController {
  // 草稿与暂存配图不随视图切换蒸发(ui-audit P1 #9d):文字过桥走模块态(unmount / 切走
  // 时存,mount / bar 重建时消费灌回),暂存图直接把 pendingImages 提到模块级——root
  // 节点由下一个输入区搬家,预览/字节原地存活。提交/清空后自然为空,不会把已保存的
  // 内容再灌回来。
  // **按空间分桶**(codex P1 审 H1):草稿随 mount 时的空间打标,空间对不上=丢弃——
  // A 空间的草稿/暂存图绝不灌进 B 空间(空间=账户互相隔离的铁律;切空间时 notebook
  // 先翻 current 再 unmount,故标记必须取 mount 时捕获的空间,不能在 unmount 时现取)。
  let draftSaved = "";
  let draftSpace: string | null = null;
  // 断电恢复(198 桌面侧):文字草稿走 localStorage、暂存图走 IndexedDB(imgs 的
  // persistKey)——意外断电 / 杀进程后重开,上次没记下的输入还在。载荷带空间(A 空间
  // 草稿绝不灌进 B,与 draftSpace 同律)。**纯设备本地 UI 状态,绝不进 DB / 同步**。
  // 首个 mount 时回填一次暂存图(imgs 是模块级,填好即常驻,后续 mount 不重填)。
  let imgsRestored = false;
  // 保存失败 / 部分失败的提示过桥(codex 三审 M 升模块级):本输入区已脱离 DOM(inbox
  // refresh 重建 bar / 本 mount 已死)时,由同空间的下一个输入区领走显示一次——失败
  // 不许因为切了个视图就无声。
  let notice = "";
  let noticeSpace: string | null = null;
  // 活 mount 的重读通道(codex 四审 M):旧 mount 的保存链在 unmount 后才落账时,同空间
  // 的新 mount 得马上重读——否则「正文被清了、卡片却没出现」要等到下次 refocus。
  // navigate 恒先 unmount 旧再 mount 新,单值不会互踩。
  let liveReload: (() => void) | null = null;
  const imgs = pendingImages({ persistKey: opts.imagesKey });
  // 模块加载即从磁盘灌回文字草稿(同步读):重开后首个输入区一建就能显示上次的字。
  // 空间一并恢复,交给既有的「mount 空间对不上就丢弃」逻辑把关(discardForeignDraft)。
  {
    const d = loadTextDraft(opts.draftKey);
    if (d && d.text) {
      draftSaved = d.text;
      draftSpace = d.space;
    }
  }
  // in-flight 闸提模块级(codex P1 审 H2):保存往返期间切走再回来,新 mount 的闸必须
  // 还是同一把——否则同一草稿能被重提两次。
  let saving = false;

  function bindSave(w: SaveWiring): () => Promise<void> {
    const doSave = async (): Promise<void> => {
      const submitted = w.input.value; // 提交那刻的快照:成功后用它清同内容的输入框/存底
      const prep = w.prepare(submitted);
      if (prep === null) return; // 空输入拒收(策略在视图侧):图批未取,预览区原样不动
      let soleTopic = prep.soleTopic ?? null;
      // 「保存那刻」冻结整份载荷(codex P1 二审 H2):图批同步带走,IPC 等待期间新粘贴
      // 的归下一条。整条链走 invokeInSpace(space)——必落账写不许走「跨空间迟到永不决议」
      // 的统一包装,否则模块级 in-flight 闸的 finally 永不执行、保存锁死(H1)。
      const batch = imgs.takeBatch();
      let id: string;
      try {
        id = await invokeInSpace<string>(w.space, w.command, prep.payload);
      } catch (e) {
        // 没建成:同空间才把图退回预览区(可重试);空间已切走的批 revoke 即弃——绝不
        // 追加进别的空间的预览区随人家的条目保存(codex 三审 H)。错误找活的输入区显示
        // (本输入区已脱离 DOM 就 document 级找同空间在场的那个),都不在场就走模块态
        // 过桥给同空间的下一个 mount——失败不许无声(复查 L1 + codex 三审 M)。
        if (currentSpaceId() === w.space) imgs.putBack(batch);
        else imgs.disposeBatch(batch);
        const liveErr = w.errEl.isConnected
          ? w.errEl
          : currentSpaceId() === w.space
            ? document.querySelector<HTMLElement>(w.liveErrSelector)
            : null;
        if (liveErr !== null) w.showErr(liveErr, String(e));
        else if (currentSpaceId() === w.space) {
          notice = String(e);
          noticeSpace = w.space;
          w.onBridgedError?.();
        }
        return;
      }
      // 已落账。等待空档里视图可能已重建/重灌输入框(inbox 的过滤 refresh 重建 bar、
      // 切走再回来的新 mount)——清「当前在场」的输入框而非闭包里的旧节点(document
      // 级找,新 mount 的框也归它管;codex P1 二审 H1 余波)。同空间且值仍等于刚提交
      // 的才清:等待期间用户接着打的字不吞(极端并发下宁多留不误删)。
      const live = document.querySelector<HTMLTextAreaElement>(w.liveInputSelector);
      if (live !== null && currentSpaceId() === w.space && live.value === submitted) {
        live.value = "";
        // 收回一行:board 原是裸 height="auto"、inbox 原是 autoGrow,同一件事(353 收成
        // 语义一致的 autoGrow——空框量出即一行高,顺带把 overflowY 收干净)。
        // 但 display:none 的框量出全 0,autoGrow 会钉死 height:0px(353 对抗核验 M:
        // board 等待期 Escape/✕ 收起 compose[hidden→display:none]再决议即中招,重开后
        // 输入框塌成零高直到下次 input)——量不了的退回旧 board 的裸 height="auto",
        // 重开即一行,后续 input 的 autoGrow 接管。
        if (live.getClientRects().length > 0) autoGrow(live);
        else live.style.height = "auto";
        clearTextDraft(opts.draftKey); // 输入框被清=稿了结,磁盘草稿同步清(等待期未再打字才走这)
      }
      // 保存中切走时 unmount 会把提交前的输入框内容存进模块态:成功即作废同内容的存底,
      // 回来不再灌回已保存的正文(codex P1 审 H2)。
      // **连空间一起核**(353 续遗留 M,355 修):A 空间提交悬着时切 B、在 B 输入恰好
      // 同文并离场(B 稿进模块态),A 决议不许把 B 的存底连磁盘草稿一起误清——作废
      // 条件补空间判断即可;draftSpace 兼任归属标记,这里绝不清它(它还要看住暂存图)。
      if (draftSaved === submitted && draftSpace === w.space) {
        draftSaved = "";
        clearTextDraft(opts.draftKey); // 模块存底=已保存正文:磁盘也清(切走场景,input 不在场)
      }
      const notices: string[] = [];
      if (w.afterCreate) soleTopic = await w.afterCreate(id, notices);
      // 挂图也在必落账链上(同一保存的一部分),同样恒决议;挂失败不吞掉(fail-fast)。
      const failed = await imgs.attachBatch(id, batch, w.space);
      w.onSettled?.(notices, failed);
      if (w.isUnmounted()) {
        // 本 mount 已死但落账已完成(codex 四审 M):视图特有的部分失败落点先走
        // (onDeadMount),再通知同空间活 mount 马上重读——别让「正文被清了、卡片
        // 没出现」等到下次 refocus。
        w.onDeadMount?.(failed);
        if (currentSpaceId() === w.space) liveReload?.();
        return;
      }
      w.onSaved(id, soleTopic, failed);
    };
    // in-flight 闸(ui-audit P0 #2)在模块级 saving:创建 IPC 往返窗口里第二记 Enter /
    // 点按会用同一份内容再建一条重复条目;闸跨 mount / 跨 bar 才挡得住「保存中切走再
    // 回来」(codex P1 审 H2)。
    return async (): Promise<void> => {
      if (saving) return;
      saving = true;
      try {
        await doSave();
      } finally {
        saving = false;
      }
    };
  }

  return {
    imgs,
    hasStashedDraft: () => draftSaved.trim().length > 0 || imgs.count() > 0,
    draftText: () => draftSaved,
    draftSpace: () => draftSpace,
    takeDraftText: () => {
      const t = draftSaved;
      draftSaved = "";
      return t;
    },
    stashDraft: (text, space) => {
      draftSaved = text;
      draftSpace = space;
    },
    discardForeignDraft: (space) => {
      if (draftSpace !== null && draftSpace !== space) {
        draftSaved = "";
        draftSpace = null;
        clearTextDraft(opts.draftKey); // 跨空间丢弃:磁盘草稿也清(imgs.clear() 自清图存)
        imgs.clear();
      }
    },
    persistText: (text, space) => saveTextDraft(opts.draftKey, { text, space }),
    restoreImagesOnce: (then) => {
      if (imgsRestored) return;
      imgsRestored = true;
      const p = imgs.restore();
      void (then ? p.then(then) : p);
    },
    takeNotice: (space) => {
      if (notice === "" || noticeSpace !== space) return null;
      const msg = notice;
      notice = "";
      noticeSpace = null;
      return msg;
    },
    postNotice: (msg, space) => {
      notice = msg;
      noticeSpace = space;
    },
    setLiveReload: (fn) => {
      liveReload = fn;
    },
    bindSave,
  };
}

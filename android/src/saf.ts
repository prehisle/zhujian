// SAF 那条桥的 JS 半(backup-plan §17.5)。UI 在 `backup.ts`,这里只管**怎么和 Kotlin 说话**。
//
// ⚠ 与已有两条窄桥(250 状态栏 / 251 字号)**形不同**:那两条打完就走、没有回值;
// 这条要等系统选择器或一次文件拷贝的结果 ⇒ reqId → resolver 表 + 异步应答。
//
// ⛔ **回调不是真相源,只是快路**(§17.5 那格,坑 4 的修法):
// 低内存下 Activity 会被回收重建、WebView 重载,挂着的 promise 就没了。真相源是壳侧
// SharedPreferences 里那条**在飞记录**。⇒
//   ①`pickTree` **不设超时**(选择器可以开着好几分钟);
//   ②拷贝类 5 秒不应答就**改走轮询**(1 秒一次读记录),⛔ **超时本身不判失败**;
//   ③每次轮询与每次应答都要**比对 `transferId`**——记录只有一条、会被下一趟覆盖,
//     对不上就说明**这一趟的结果已经不可知**(codex 二弹 H:否则「A 超时转轮询 → A 结束 →
//     B 覆盖了记录 → A 的轮询读到 B 的 done」会把 B 的结果兑现给 A)。
//   ④对不上那条路**必须把旧 promise 结掉**(结成 `unknown`,⛔ 不是 resolve 也不是永远悬着),
//     并在**同一刻**把它从 resolver 表里移除;迟到的回调再来查不到表就丢掉,
//     ⛔ 不许重新建一格(三弹 / 四弹 M:只改状态字不清表,泄漏与二次结算一个都没解决)。

import { t } from "./i18n";

/**
 * 应答宽限与轮询间隔。⚠ **刻意不进 `timing.ts`**:那份是 ui-guidelines §2.4 那张表的代码
 * 真身(两端逐值对齐、由 `check-timing-drift` 看着),而这两个数不是「交互时长」——
 * 它们是桥的等待策略,桌面那端根本没有对应物。往那份里加只会让门禁去比一个不存在的孪生。
 */
const REPLY_GRACE_MS = 5000;
const POLL_MS = 1000;

/** 壳侧那条在飞记录(与 Kotlin 的 `SafPure.Transfer` 同形)。 */
export type SafTransfer = {
  transferId: string;
  kind: "put" | "fetch";
  outboxName: string;
  docId: string | null;
  displayName: string | null;
  state: "running" | "done" | "failed";
  reason: string | null;
  /** ⭐ 判据是「**锚还能不能再生**」而不是「跨不跨重启」;`fetch` 那格壳侧还会**在点之前**
   *  问一次 `docId` 解不解析得开(§17.10 六弹 M)。 */
  retryable: boolean;
};

/** 启动那四步留下的事实。⛔ 两个健康位是 **UI 的输入**,不是准入的输入。 */
export type SafStartup = {
  recordUnknown: boolean;
  cleanupFailed: boolean;
  busy: boolean;
  last: SafTransfer | null;
};

export type SafTree = { configured: boolean; uri?: string; name?: string; writable?: boolean };

export type SafItem = {
  docId: string;
  name: string;
  bytes: number;
  ms: number;
  /** 在本机产出账里 —— ⛔ **这不是「它是好的」**,只是「这是我写出去的」。 */
  fromLedger: boolean;
};

export type SafList = {
  items: SafItem[];
  truncated: boolean;
  otherCount: number;
  /** `true` = 那个数是**饱和**的,UI 说「200+」⛔ 别伪造精确值。 */
  otherSaturated: boolean;
  /** 这次**看了**这个文件夹的多少个条目(工作量的上界,与展示上界是两件事)。 */
  scanned: number;
  /** `true` = 扫到上限就停了 ⇒ ⛔ **界面绝不许把这次的结果说成「你只有这些」**。 */
  scanTruncated: boolean;
  error?: string;
};

/** 一趟 transfer 的结局。⭐ `unknown` 是**终态**:结果不可知,重新问整体状态。 */
export type SafDone =
  | { ok: true; kind: "put" | "fetch"; localName: string; displayName: string | null }
  | { ok: false; error: string; canRetry: boolean }
  | { ok: false; unknown: true };

type Bridge = {
  pickTree(reqId: number): void;
  currentTree(): string;
  putFile(reqId: number, outboxName: string): string;
  listTree(reqId: number, mode: string): void;
  fetchFile(reqId: number, docId: string): string;
  expectOutbox(path: string): string;
  startupState(): string;
};

function bridge(): Bridge | null {
  return (window as unknown as { __zhujianSaf?: Bridge }).__zhujianSaf ?? null;
}

export function hasBridge(): boolean {
  return bridge() !== null;
}

// ---- reqId → resolver ------------------------------------------------------------

let nextReq = 1;
const pending = new Map<number, (payload: Record<string, unknown>) => void>();

(window as unknown as { __zhujianSafResolve?: (id: number, json: string) => void })
  .__zhujianSafResolve = (id, json) => {
  // ⛔ 先查表:查不到就丢掉(那一格已经按「不知道」结过了),⛔ 不许重新建一格。
  const fn = pending.get(id);
  if (!fn) return;
  pending.delete(id);
  try {
    fn(JSON.parse(json) as Record<string, unknown>);
  } catch {
    fn({ error: t("backup.replyUnreadable") });
  }
};

function call(fire: (reqId: number) => void): Promise<Record<string, unknown>> {
  const id = nextReq++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    fire(id);
  });
}

/** 从 resolver 表里摘掉一格(轮询接管 / 结成 unknown 时用)。 */
function drop(id: number): void {
  pending.delete(id);
}

// ---- 五个入口 --------------------------------------------------------------------

export function currentTree(): SafTree {
  const b = bridge();
  if (!b) return { configured: false };
  return JSON.parse(b.currentTree()) as SafTree;
}

export function startupState(): SafStartup {
  const b = bridge();
  if (!b) return { recordUnknown: false, cleanupFailed: false, busy: false, last: null };
  return JSON.parse(b.startupState()) as SafStartup;
}

/**
 * 把 Rust 算的 outbox 期望值交给壳**当场比对**(§17.5 那道运行时相等闸)。
 * 回空串 = 相等;回字符串 = 拒的理由 —— ⛔ 那时**一趟 transfer 都不许起**。
 */
export function expectOutbox(path: string): string {
  const b = bridge();
  if (!b) return t("backup.noBridge");
  return b.expectOutbox(path);
}

/** 挑落点。⛔ 不设超时(选择器可以开着好几分钟);进程被杀就永远不回话,那时靠重开面问状态。 */
export function pickTree(): Promise<{ ok: boolean; cancelled?: boolean; error?: string }> {
  const b = bridge();
  if (!b) return Promise.resolve({ ok: false, error: t("backup.noBridge") });
  return call((id) => b.pickTree(id)) as Promise<{ ok: boolean; cancelled?: boolean; error?: string }>;
}

export function listTree(all: boolean): Promise<SafList> {
  const b = bridge();
  if (!b) return Promise.resolve({ items: [], truncated: false, otherCount: 0, otherSaturated: false, scanned: 0, scanTruncated: false, error: t("backup.noBridge") });
  return call((id) => b.listTree(id, all ? "all" : "backups")) as Promise<SafList>;
}

export function putFile(outboxName: string): Promise<SafDone> {
  return transfer((b, id) => b.putFile(id, outboxName), "put");
}

export function fetchFile(docId: string): Promise<SafDone> {
  return transfer((b, id) => b.fetchFile(id, docId), "fetch");
}

/**
 * 拷贝类的共同形:**同步**拿 `transferId`,再等应答 —— 5 秒不应答就改走轮询。
 *
 * ⛔ 三处判据别改坏:①`transferId` 每次都比;②对不上 = `unknown`(终态)而不是失败;
 * ③摘表与结掉在**同一刻**发生。
 */
function transfer(
  fire: (b: Bridge, id: number) => string,
  kind: "put" | "fetch",
): Promise<SafDone> {
  const b = bridge();
  if (!b) return Promise.resolve({ ok: false, error: t("backup.noBridge"), canRetry: false });
  const id = nextReq++;
  let started: { transferId?: string; error?: string };
  try {
    started = JSON.parse(fire(b, id)) as { transferId?: string; error?: string };
  } catch (e) {
    return Promise.resolve({ ok: false, error: String(e), canRetry: false });
  }
  if (!started.transferId) {
    return Promise.resolve({ ok: false, error: started.error ?? t("backup.notStarted"), canRetry: false });
  }
  const mine = started.transferId;
  return new Promise<SafDone>((resolve) => {
    let settled = false;
    const finish = (r: SafDone) => {
      if (settled) return;
      settled = true;
      drop(id);
      clearTimeout(grace);
      clearInterval(poll);
      resolve(r);
    };
    pending.set(id, (payload) => {
      // 应答也要认身份:壳只会给自己那一趟回话,但记下这条判据是为了让「换个人回话」
      // 这件事永远不可能被静默接受。
      if (payload.transferId !== mine) {
        finish({ ok: false, unknown: true });
        return;
      }
      finish(fromPayload(payload, kind));
    });
    const grace = setTimeout(() => {
      // ⛔ 超时**不判失败**:判决交给「在飞记录」那个真相源。
      drop(id);
      poll = setInterval(tick, POLL_MS) as unknown as number;
      tick();
    }, REPLY_GRACE_MS) as unknown as number;
    let poll = 0 as unknown as number;
    const tick = () => {
      const st = startupState();
      const last = st.last;
      if (!last || last.transferId !== mine) {
        // ⭐ 记录已经被下一趟覆盖 ⇒ **这一趟的结果已经不可知**,⛔ 绝不兑现成成功或失败。
        finish({ ok: false, unknown: true });
        return;
      }
      if (last.state === "running") {
        // ⛔⛔ **`running + busy=false` 是一个不可能再往前走的状态**(实现审弹 2 M-1):
        // 壳侧那趟的终态 `commit()` **只要失败一次**、而回调又晚于 5 秒宽限,记录就会永远
        // 停在 `running`,可 worker 早已收工、锁也放了 ⇒ 这里若只看 `state`,就是**永久轮询**
        // (promise 永不结算、interval 永不清、按钮的 `finally` 永不到 = 界面永远转圈)。
        // ⇒ 拿壳侧的 `busy` 当**第二个观测量**:它说没有在飞,那这一趟的结果只能是「不知道」。
        // ⚠ 无限等待这个取舍本身**保留** —— 只在 `busy=true`(真有 worker)时才继续等。
        if (!st.busy) finish({ ok: false, unknown: true });
        return;
      }
      if (last.state === "done") {
        finish({ ok: true, kind: last.kind, localName: last.outboxName, displayName: last.displayName });
      } else {
        finish({ ok: false, error: last.reason ?? t("backup.notDone"), canRetry: last.retryable });
      }
    };
  });
}

function fromPayload(p: Record<string, unknown>, kind: "put" | "fetch"): SafDone {
  if (p.ok === true) {
    return {
      ok: true,
      kind,
      localName: String(p.localName ?? ""),
      displayName: (p.displayName as string | undefined) ?? null,
    };
  }
  return {
    ok: false,
    error: String(p.error ?? t("backup.notDone")),
    canRetry: p.canRetry === true,
  };
}

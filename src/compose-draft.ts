// compose 草稿断电恢复(198 桌面侧,闭环用户最初诉求;安卓侧见 android/src/{main,images}.ts)。
// 三个新建入口——捕获浮窗(main.ts)/ 灵感「记下灵感」(inbox.ts)/ 看板「新建任务」(board.ts)
// ——的未记下草稿(文字 + 暂存图)存到设备本地:意外断电 / 杀进程后重开,上次没记下的
// 输入还在。**纯设备本地 UI 状态,绝不进 DB / 同步**(与「Esc 收窗保稿」同一体感,只是把
// 「活着的进程内存」升成「掉电也不丢的磁盘」)。
//
// 文字走 localStorage(小、同步读,启动即能灌回输入框);图走 IndexedDB(存 Blob 原生,
// 不像 localStorage 会被大图撑爆——同安卓 images.ts)。捕获浮窗与笔记本是同源两窗,共享
// 同一份存储,键按入口分桶(下方常量),互不串。

// ---- 文字草稿(localStorage) ----------------------------------------------------
// 载荷带 space:灵感 / 看板草稿按空间分桶(A 空间的草稿绝不灌进 B,与模块态 composeDraftSpace
// 同律);捕获浮窗落点在按回车那刻才定,不分桶(space 恒 null)。
export type TextDraft = { text: string; space: string | null };

export function saveTextDraft(key: string, draft: TextDraft): void {
  // 空文字即清键——省得重开后灌出个空壳、或留下永不消费的脏键(图-only 草稿的 space
  // 由模块态 composeDraftSpace 在 unmount 时维护,不靠这条文字键记)。
  if (draft.text === "") {
    localStorage.removeItem(key);
    return;
  }
  try {
    localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // 持久化尽力而为(配额满等):不拦输入。
  }
}

export function loadTextDraft(key: string): TextDraft | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<TextDraft>;
    return { text: typeof v.text === "string" ? v.text : "", space: v.space ?? null };
  } catch {
    return null;
  }
}

export function clearTextDraft(key: string): void {
  localStorage.removeItem(key);
}

// ---- 暂存图草稿(IndexedDB) ----------------------------------------------------
// 单库、按入口键分桶(捕获 / 灵感 / 看板三桶,互不串)。写失败一律吞掉——持久化尽力而为,
// 绝不拦业务。
// **393 起桶内一张一个键**(安卓同族 392 先改,这份是把两端改齐):此前是「held 一变就把
// 整桶 blob 整体覆盖写一个键」,加第 N 张要重写前 N-1 张的字节(N 张累计 N(N+1)/2 次拷贝)。
// 现在每张自己一个 `<桶>::img:<id>` 键、另有 `<桶>::order` 存 id 顺序清单,写入是**收敛**:
// 同一事务里先 `getAllKeys()`(只取键不取值)、桶里没有的才写、不再持有的删掉。
// ⚠ 收敛的扫描面**必须限在本桶内**(前缀 `<桶>::`,外加 393 之前那个光秃秃的 `<桶>` 老键)——
// 三个桶共用一个 store,扫过界就是把别的入口的草稿删了。
// ⚠ 顺序由清单说了算、不是键序;重排/退回只重写几十字节的清单。
const IMG_DB = "zhujian-compose-draft";
const IMG_STORE = "images";
const ORDER_OF = (key: string): string => `${key}::order`;
const IMG_OF = (key: string, id: string): string => `${key}::img:${id}`;

/** 一张暂存图:`id` 只是本地键与「这张写过没有」的判据,不出这个模块、不进 DB/同步。 */
export type DraftImage = { id: string; blob: Blob };

// ⚠ 每一条终局都必须接上(安卓 391 真机上栽过一次):写入是串行链,链上任何一环 Promise
// 永不落地 = 之后所有草稿写入(**含「记下后清稿」那一次**)全部沉默,而库停在最后一次成功
// 的快照上 —— 下次启动就回填出一张早该没了的图。open 有 blocked、事务有 abort,漏接哪个
// 哪个就是那口井。
function openImgDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IMG_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IMG_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("draft db open blocked"));
  });
}

/** 本桶归属判定:`<桶>::…` 是新形态的键,光秃秃的 `<桶>` 是 393 之前那个整批键。 */
function inBucket(k: string, key: string): boolean {
  return k === key || k.startsWith(`${key}::`);
}

/** 把本桶收敛到 `items` 这一份:桶里没有的字节才写、不在 items 里的本桶键一律删
 *  (**顺带扫掉 393 之前那个整批键与任何孤儿**),最后写 id 顺序清单。三步同一个事务,
 *  故「清单与字节对不上」这种半态落不了地。 */
export async function saveImageDraft(key: string, items: DraftImage[]): Promise<void> {
  const db = await openImgDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IMG_STORE, "readwrite");
      const store = tx.objectStore(IMG_STORE);
      const keysReq = store.getAllKeys(); // 只取键不取值:不读一个 blob 字节
      keysReq.onsuccess = () => {
        const orderKey = ORDER_OF(key);
        const alive = new Set(items.map((it) => IMG_OF(key, it.id)));
        const onDisk = new Set<string>();
        for (const k of keysReq.result) {
          const s = String(k);
          if (!inBucket(s, key)) continue; // 别的入口的草稿,一根汗毛都不许动
          // 删要拿**原样的键**去删(String() 只用来比对)。
          if (s !== orderKey && !alive.has(s)) store.delete(k);
          else onDisk.add(s);
        }
        for (const it of items) {
          if (!onDisk.has(IMG_OF(key, it.id))) store.put(it.blob, IMG_OF(key, it.id));
        }
        store.put(
          items.map((it) => it.id),
          orderKey,
        );
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("draft persist aborted"));
    });
  } finally {
    db.close();
  }
}

/** 读回本桶:清单定顺序,逐 id 取字节(清单里有 id 却没字节的跳过)。**同一事务里顺带扫掉
 *  本桶不在清单里的键** —— 老键与孤儿的字节否则会一直占着(一个入口若再也不加图,
 *  saveImageDraft 永远不跑,没有别人替它清)。 */
export async function loadImageDraft(key: string): Promise<DraftImage[]> {
  const db = await openImgDb();
  try {
    return await new Promise<DraftImage[]>((resolve, reject) => {
      const tx = db.transaction(IMG_STORE, "readwrite"); // 要扫本桶孤儿,故非只读
      const store = tx.objectStore(IMG_STORE);
      const orderKey = ORDER_OF(key);
      const out: DraftImage[] = [];
      const orderReq = store.get(orderKey);
      orderReq.onsuccess = () => {
        const ids = (orderReq.result as string[] | undefined) ?? [];
        const alive = new Set(ids.map((id) => IMG_OF(key, id)));
        const keysReq = store.getAllKeys();
        keysReq.onsuccess = () => {
          for (const k of keysReq.result) {
            const s = String(k);
            if (inBucket(s, key) && s !== orderKey && !alive.has(s)) store.delete(k);
          }
        };
        for (const id of ids) {
          const req = store.get(IMG_OF(key, id));
          // 请求按发出顺序回调 ⇒ out 天然就是清单的顺序。
          req.onsuccess = () => {
            const b = req.result as Blob | undefined;
            if (b) out.push({ id, blob: b });
          };
        }
      };
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("draft load aborted"));
    });
  } finally {
    db.close();
  }
}

/** 暂存图的本地 id(同安卓 `images.ts::newDraftId`):会话内单调 + 启动时刻做前缀 ⇒ 与上次
 *  会话回填进来的 id 不会撞。**唯一性是 saveImageDraft「已有就不重写字节」的前提**,撞了
 *  就是拿上一张的字节冒充这一张(静默错图),故调用方还要在自己那份 held 内再挡一道。 */
let draftIdSeq = 0;
export function newDraftImageId(): string {
  draftIdSeq += 1;
  return `${Date.now().toString(36)}-${draftIdSeq.toString(36)}`;
}

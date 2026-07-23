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
// 单库、按入口键分桶存 Blob[](结构化克隆含字节,读回可当 Blob 用)。写失败一律吞掉——
// 持久化尽力而为,绝不拦业务(同安卓 images.ts::persistDraftBlobs)。
const IMG_DB = "zhujian-compose-draft";
const IMG_STORE = "images";

function openImgDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IMG_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IMG_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveImageDraft(key: string, blobs: Blob[]): Promise<void> {
  const db = await openImgDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IMG_STORE, "readwrite");
      const store = tx.objectStore(IMG_STORE);
      if (blobs.length === 0) store.delete(key);
      else store.put(blobs, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function loadImageDraft(key: string): Promise<Blob[]> {
  const db = await openImgDb();
  try {
    return await new Promise<Blob[]>((resolve, reject) => {
      const tx = db.transaction(IMG_STORE, "readonly");
      const req = tx.objectStore(IMG_STORE).get(key);
      req.onsuccess = () => resolve((req.result as Blob[] | undefined) ?? []);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

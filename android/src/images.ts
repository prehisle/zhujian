// 安卓加图共享件(195/后续)——两个加图入口(卡片操作面 cardpanel、记灵感 compose)
// 共用一套「唤起系统相册 + 字节转码 + compose 暂存」,免各写各的造能力漂移。
// 取图机制:借 WebView 的 `<input type=file accept=image/*>`,wry 0.55 安卓端接了
// onShowFileChooser,点击即弹系统相册/文件选择器,**无需任何插件**(195 真机验通)。
import { addItemImage } from "./api";

/** Blob → base64(不带 data: 前缀,过 IPC 给 add_item_image)。分块喂 btoa,
 *  免大图一次 fromCharCode(...几百万) 爆栈(与桌面 item-images.ts::toBase64 同法)。 */
export async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// 上传前降采样(194 可优化项①):相册原图动辄几 MB,全量入 E2EE 库并下行到所有设备=同步
// 体积负担。两道闸——**主闸** 长边 > UPLOAD_MAX_EDGE 按比例缩;**副闸(B)** 尺寸达标但字节
// 偏大的**照片**(JPEG 源)也重编码,补「小尺寸大体积」漏网。副闸只认 JPEG:透明 PNG 与文字
// 截图(截图多为 PNG)天然豁免,不被 JPEG 化丢透明/糊字。任一闸命中就 canvas 重绘 → JPEG
// q0.85;都不命中 / 解码不了(HEIC 等)/ 缩后反更大均放行原图(后端 MIME 闸仍是权威,该拒
// 的照拒)。pickImage 是安卓唯一的用户字节入口,在这里做即两加图入口全覆盖。
const UPLOAD_MAX_EDGE = 2560;
const UPLOAD_HEAVY_BYTES = 1_500_000; // ~1.5MB:尺寸内但比这肥的 JPEG 照片也压
async function downsampleForUpload(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("decode"));
      img.src = url;
    });
    const maxDim = Math.max(img.naturalWidth, img.naturalHeight);
    const overDim = maxDim > UPLOAD_MAX_EDGE; // 主闸
    const heavyPhoto = file.type === "image/jpeg" && file.size > UPLOAD_HEAVY_BYTES; // 副闸
    if (!overDim && !heavyPhoto) return file; // 尺寸达标且非肥照片:原样(截图/透明 PNG 天然豁免)
    const scale = Math.min(1, UPLOAD_MAX_EDGE / maxDim); // 只缩不放大;副闸场景 scale=1 仅重编码
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/jpeg", 0.85));
    if (!blob || blob.size >= file.size) return file; // 编码失败 / 缩后反更大:放行原图
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file; // 解码失败(HEIC 等):原样交后端,该拒的响亮拒,不静默转码
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 唤起系统相册选一张图,resolve 选中的文件(已按上传上限降采样);取消(没选)resolve null。
 *  选择器是系统模态,期间 app 在后台。change=选中;有些 ROM 取消不发 change,
 *  故回到前台 1s 后若仍未 settle 判为取消(picked 已 settle 则本兜底空转,绝不
 *  抢在 change 之前误判)。调用点须由用户手势触发(input.click 要手势),故本函数
 *  只在点击处理器里调。 */
export function pickImage(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.hidden = true;
    let settled = false;
    const settle = (f: File | null): void => {
      if (settled) return;
      settled = true;
      input.remove();
      // 选中即降采样后再决议(downsampleForUpload 永不 reject,失败返原文件);取消直接 null。
      if (f) void downsampleForUpload(f).then(resolve);
      else resolve(null);
    };
    input.addEventListener("change", () => settle(input.files?.[0] ?? null), { once: true });
    window.addEventListener(
      "focus",
      () => window.setTimeout(() => settle(null), 1000),
      { once: true },
    );
    document.body.appendChild(input);
    input.click();
  });
}

// ---- compose 暂存图的断电恢复(197 下一步①):图走 IndexedDB(存 Blob 原生、容量够,
// 不像 localStorage 会被大图撑爆)。单条全局草稿一份(与文字草稿同哲学,不按空间分),
// held 一变就整体覆盖写;启动回填。纯设备本地 UI 状态,绝不进 DB/同步。 ------------
const DRAFT_DB = "zhujian-compose-draft";
const DRAFT_STORE = "images";
const DRAFT_KEY = "pending";

function openDraftDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DRAFT_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DRAFT_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function persistDraftBlobs(blobs: Blob[]): Promise<void> {
  const db = await openDraftDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DRAFT_STORE, "readwrite");
      tx.objectStore(DRAFT_STORE).put(blobs, DRAFT_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function loadDraftBlobs(): Promise<Blob[]> {
  const db = await openDraftDb();
  try {
    return await new Promise<Blob[]>((resolve, reject) => {
      const tx = db.transaction(DRAFT_STORE, "readonly");
      const req = tx.objectStore(DRAFT_STORE).get(DRAFT_KEY);
      req.onsuccess = () => resolve((req.result as Blob[] | undefined) ?? []);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** compose 暂存图(记灵感时先贴、条目还没建):holder 在给定容器里渲染缩略图(带
 *  「×」移除),对外只暴露 File[] 批次。与 save() 的两缓冲对齐(桌面 pendingImages 同律):
 *  点「记下」那刻 takeBatch 冻结带走并清预览,在飞期间新贴的图属于下一条;创建成功
 *  attachBatch 逐张挂上、失败图按张计数(条目已建、图可去卡片「加图」重贴);创建失败
 *  putBack 原样退回可重试。objectURL 是纯渲染态,取批/退回时按需重建。 */
export type ComposeImages = {
  count: () => number;
  add: (file: File) => void;
  takeBatch: () => File[];
  putBack: (batch: File[]) => void;
  clear: () => void;
  /** 逐张挂到刚建好的条目;返回挂失败张数(fail-fast,调用方告诉用户)。 */
  attachBatch: (space: string, itemId: string, batch: File[]) => Promise<number>;
  /** 启动回填:从 IndexedDB 读回上次没记下的暂存图(仅当前无暂存时,不覆盖已贴的)。 */
  restore: () => Promise<void>;
};

export function composeImages(container: HTMLElement): ComposeImages {
  type Held = { file: File; url: string };
  let held: Held[] = [];

  // held 一变就整体覆盖写 IndexedDB(串行成链防并发写乱序;失败吞掉——持久化尽力而为,
  // 不拦业务)。写的是 File 快照(结构化克隆含字节),读回可当 Blob 用。
  let persistChain: Promise<void> = Promise.resolve();
  function persist(): void {
    const snapshot = held.map((h) => h.file as Blob);
    persistChain = persistChain.then(() => persistDraftBlobs(snapshot)).catch(() => {});
  }

  function render(): void {
    container.replaceChildren();
    container.hidden = held.length === 0;
    for (const h of held) {
      const img = document.createElement("img");
      img.src = h.url;
      const del = document.createElement("button");
      del.type = "button";
      del.className = "cthumb-del";
      del.textContent = "×";
      del.setAttribute("aria-label", "移除这张图");
      del.addEventListener("click", () => {
        URL.revokeObjectURL(h.url);
        held = held.filter((x) => x !== h);
        render();
        persist();
      });
      const wrap = document.createElement("div");
      wrap.className = "cthumb";
      wrap.append(img, del);
      container.append(wrap);
    }
  }
  render();

  return {
    count: () => held.length,
    add(file) {
      held.push({ file, url: URL.createObjectURL(file) });
      render();
      persist();
    },
    takeBatch() {
      const files = held.map((h) => h.file);
      for (const h of held) URL.revokeObjectURL(h.url);
      held = [];
      render();
      persist(); // 冻结带走即清持久化(记下成功=草稿了结;失败由 putBack 复写回)
      return files;
    },
    putBack(batch) {
      // 退回的旧批插在在飞期间新贴的图之前(重试时次序不变),objectURL 重建。
      const restored = batch.map((file) => ({ file, url: URL.createObjectURL(file) }));
      held = [...restored, ...held];
      render();
      persist();
    },
    clear() {
      for (const h of held) URL.revokeObjectURL(h.url);
      held = [];
      render();
      persist();
    },
    async attachBatch(space, itemId, batch) {
      let failed = 0;
      for (const file of batch) {
        try {
          await addItemImage(space, itemId, file.type, await toBase64(file));
        } catch {
          failed += 1;
        }
      }
      return failed;
    },
    async restore() {
      if (held.length) return; // 启动后用户已抢先贴图:不覆盖
      let blobs: Blob[];
      try {
        blobs = await loadDraftBlobs();
      } catch {
        return; // IndexedDB 不可用/读失败:恢复尽力而为,不拦启动
      }
      if (!blobs.length || held.length) return; // await 期间可能已被贴入:再核一次
      for (const b of blobs) held.push({ file: b as File, url: URL.createObjectURL(b) });
      render();
    },
  };
}

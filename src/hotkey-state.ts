// 两枚全局热键的此刻状态(W4 A6 / Q8 ①):键位 + 哪枚被别的程序占着、按了没反应。
//
// 读它的有三处:设置「快捷键」页(被占的那枚旁标「没生效」)、随记页顶上那条「点此改键」、
// 随记空态那句「或按 …」(那枚没生效时不说)。真相在壳里(lib.rs `HotkeyRuntime` 的
// `*_live`;`get_hotkeys` / `set_hotkey` 回的 `*_taken`),这里只是主窗这一侧的一份缓存:
// 启动时拉一次(notebook.ts 启动序,先于第一次挂视图),设置里改键成功拿到的回执直接换进来。
// ⛔ 别在别处另存一份:三处读同一份,改完键三处才会一起变。
import { invoke } from "@tauri-apps/api/core";

/** lib.rs `HotkeysDto` 的镜像。 */
export type Hotkeys = { capture: string; notebook: string; capture_taken: boolean; notebook_taken: boolean };

let state: Hotkeys | null = null;
const subs = new Set<(h: Hotkeys) => void>();

/** 从壳里拉一次(启动序调)。 */
export async function loadHotkeys(): Promise<Hotkeys> {
  setHotkeys(await invoke<Hotkeys>("get_hotkeys"));
  return state as Hotkeys;
}

/** 此刻的那份;启动序拉到之前是 `null`(调用方照「不知道」处理,⛔ 别猜成「没被占」)。 */
export function hotkeys(): Hotkeys | null {
  return state;
}

/** 换进一份新的(改键成功的回执),通知订阅者。 */
export function setHotkeys(next: Hotkeys): void {
  state = next;
  for (const f of subs) f(next);
}

/** 订阅变化;返回退订。 */
export function onHotkeysChange(f: (h: Hotkeys) => void): () => void {
  subs.add(f);
  return () => subs.delete(f);
}

/** 此刻被占着的那几枚(加速键串)。 */
export function takenKeys(h: Hotkeys): string[] {
  const out: string[] = [];
  if (h.capture_taken) out.push(h.capture);
  if (h.notebook_taken) out.push(h.notebook);
  return out;
}

// 随记页顶上那条提示用户点 × 收起之后,**这一趟**不再出(会话级,同捕获窗那条的 dismiss):
// 下次打开朱简若仍被占,照样再说一次 —— 那时它仍然是真的。
let bannerDismissed = false;
export function hotkeyBannerDismissed(): boolean {
  return bannerDismissed;
}
export function dismissHotkeyBanner(): void {
  bannerDismissed = true;
}

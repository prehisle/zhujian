// 深链接:zhujian://open?acc=<账户ULID>&item=<条目ULID>(已配同步的空间)
//        zhujian://open?space=<空间id>&item=<条目ULID>(纯本地、无账户的库)
// acc = 账户 id,跨设备通用(发给对方设备也能开——同账户在对端映射到本机的空间);
// 纯本地无账户的库只能带 space id,只本机可解、发别的设备天然解不出(诚实,不假装能开)。
// 生成在条目 ⋯ 菜单「复制链接」;消费在 notebook 壳(解析→定位空间→切换→定位条目→高亮)。
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { currentSpaceId, listSpaces } from "./space";

const SCHEME = "zhujian";

/** 取走壳暂存的待处理深链接(OS 桥 4b:on_open_url 落库,前端启动/收事件时来取)。
 *  take 语义,无则 null。app 级命令、不注 spaceId。 */
export function consumePendingDeepLink(): Promise<string | null> {
  return tauriInvoke<string | null>("consume_deep_link");
}

/** 给一条 item 生成可复制/分享的深链接。当前空间已配同步 → 用 account_id(跨设备通用);
 *  否则回退 space id(仅本机可解)。 */
export async function buildItemDeepLink(itemId: string): Promise<string> {
  const spaceId = currentSpaceId();
  const all = await listSpaces();
  const acc = all.find((s) => s.id === spaceId)?.status.account_id ?? null;
  const key = acc ? `acc=${encodeURIComponent(acc)}` : `space=${encodeURIComponent(spaceId)}`;
  return `${SCHEME}://open?${key}&item=${encodeURIComponent(itemId)}`;
}

export type ParsedDeepLink = { acc: string | null; space: string | null; item: string };

/** 解析深链接。非本 scheme / 非 open / 无 item = null —— 调用方静默忽略无关 URL,不 throw
 *  (fail-safe:陌生 URL 不该炸壳)。 */
export function parseDeepLink(raw: string): ParsedDeepLink | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== `${SCHEME}:` || u.host !== "open") return null;
  const item = u.searchParams.get("item");
  if (!item) return null;
  return { acc: u.searchParams.get("acc"), space: u.searchParams.get("space"), item };
}

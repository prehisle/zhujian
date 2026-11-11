// 混版提醒(878,发版全案 release-train-plan 第 1 条 · 用户 2026-11-11 拍板 A):本机第一次要往**已配同步的空间**
// 发出 `doc_at`(长文标记)那一刻,先问一句。
//
// 为什么:还没升级的旧端收到 `item set_field doc_at` 会判「认不出的改动」,从此挂起这台设备在这个空间里的**全部**
// 后续改动,直到它升级才自动补齐(longform-plan §1「⑥ 的诚实边界」)。⛔ 这不是版本门、不改协议:点了「仍然使用」
// 只代表「看过提醒」,⛔ 别改写成让人声明「都升了」(设备名单不显示版本,他答不准)。
//
// 规矩:
//   · 只问已配同步的空间(判据 = 前端现成的同步状态 `configured`,sync.ts 每空间一份);没配的不问、也不记。
//     状态还没到手(启动基线之前)= 当已配处理、照问 —— 宁可多问一次,不放过一次(安全的那一边,同 delete-confirm.ts)。
//   · 按空间记住,**只在「仍然使用」后写**;「先不用」/ Esc / 点外面 = 取消这次操作、不记。
//   · 移动到别的空间判的是**目标**空间(目标收到 create + doc_at)。
//   · 调用点(⛔ 漏一处就有一条路不提醒):随记「展开成长文」(inbox.ts doExpand)、长文「新建长文」(docs.ts startNew,
//     capture_doc 只在这条路后面)、长文「收回随记」(docs.ts doCollapse,收回也发 doc_at = null)、移动面板
//     「确认移动」(move-space.ts,条目带 doc_at 时)。撤销回执里的 set_doc 不再问:它紧跟在刚问过的那一下后面。
//   · 纪元压实等后台路径重发 doc_at 不问(不是用户操作,且那时这个空间早已有过 doc_at)。
//
// 记在 localStorage(同明暗 / 字号:这台机器看过没有,不进库、不同步)。键 `zhujian.skew-ask-ack` = 空间 id 的 JSON 数组,
// 与安卓端(android/src/skewask.ts)同形。读不出 / 形状不对 = 当没记过、照问(安全的那一边);写失败 = 这次照做、下次再问一次。
import { t } from "./i18n";
import { confirmDialog } from "./confirm-dialog";
import { syncStatusOf } from "./sync";

const ACK_KEY = "zhujian.skew-ask-ack";

function readAck(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(ACK_KEY) ?? "[]");
    return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : [];
  } catch {
    return [];
  }
}

/** 要往 `space` 发 doc_at 之前调:`true` = 照做,`false` = 用户选了「先不用」(调用方取消这次操作)。 */
export async function askDocSkew(space: string): Promise<boolean> {
  const st = syncStatusOf(space);
  if (st !== null && !st.configured) return true;
  if (readAck().includes(space)) return true;
  const yes = await confirmDialog({
    title: t("docs.skewAskTitle"),
    body: t("docs.skewAskBody"),
    ok: t("docs.skewAskGo"),
    cancel: t("docs.skewAskCancel"),
    // 后果落在别的设备上、一时看不见 ⇒ 焦点停「先不用」,回车不替人做决定(ui-guidelines §3.2 第 7 条的同一个理由)
    focus: "cancel",
    returnFocusOnOk: true,
    panelClass: "doc-skew-ask",
  });
  if (!yes) return false;
  try {
    const v = readAck();
    if (!v.includes(space)) localStorage.setItem(ACK_KEY, JSON.stringify([...v, space]));
  } catch {
    // 写不进去:这次照做(人已经看过了),下次再问一次。
  }
  return true;
}

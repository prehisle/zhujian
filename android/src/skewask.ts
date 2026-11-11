// 「其他设备都升级了吗?」(878,发版全案格 2 / 混版提醒;桌面那份在 src/ 同名接缝)。
// 旧端收到 `item set_field doc_at`(长文标记)会判 UnsupportedVocab,从此挂起这台设备在那个空间里的**全部**后续 op,
// 直到它升级才补齐(longform-plan §1「⑥ 的诚实边界」)。⇒ 本机第一次要往**已配同步的空间**发 doc_at 之前问一句。
// ⛔ 不是版本门、不改协议:点「仍然使用」只代表「看过提醒」,不代表「都升了」(设备名单不显示版本,用户答不准)。
// 规则:没配同步的空间不问也不记;配了的空间,点「仍然使用」才按空间记住(之后这一本不再问);
// 「先不用」/ 返回键 = 这一下作罢、不记,下次照问(条是 sticky 的,不会读秒到点自己收)。
// 触发面(凡会让本机往某个已配同步空间发 doc_at 的用户操作):展开成长文、新建长文(开编辑器那一刻问,
// 不在落盘那一刻 —— 关面 flush 那条路上没法问)、收回随记(发 doc_at = null)、带 doc_at 的条目移到别的空间
// (判的是**目标**空间)。纪元压实那类后台自动路径不问(没有「用户这一下」可拦)。
import { listSpaces } from "./api";
import { t } from "./i18n";
import { confirmBar } from "./ui";
import { showErr } from "./err";

/** 本机记的「这几本已经看过提醒」:空间 id 的数组。键名两端同形。 */
const ACK_KEY = "zhujian.skew-ask-ack";

function readAck(): string[] {
  const raw = localStorage.getItem(ACK_KEY);
  if (raw === null) return [];
  const v: unknown = JSON.parse(raw);
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new Error(`本机记的「看过混版提醒」账坏了:${raw}`);
  return v;
}

function markAck(space: string): void {
  const v = readAck();
  if (!v.includes(space)) localStorage.setItem(ACK_KEY, JSON.stringify([...v, space]));
}

/** 本机要往 `space` 发 doc_at 之前过这一道:不用问就直接 `go()`;要问就弹确认条,点「仍然使用」才记住并 `go()`。
 *  `go` 里由调用方自己复核点下去那一刻的前提(面还在 / 没在写 / 空间没换)—— 中间隔着一次读与一次确认。 */
export function skewAsk(space: string, go: () => void): void {
  void listSpaces()
    .then((all) => {
      const s = all.find((x) => x.id === space);
      if (!s) throw new Error(`混版提醒:空间列表里没有 ${space}`);
      if (!s.configured || readAck().includes(space)) {
        go();
        return;
      }
      // sticky:这段话 6 秒读不完 ⇒ 不自动作罢(878 主控拍);「先不用」/ 返回键 / 换面收它,都不记。
      confirmBar(
        t("docs.skewAskTitle"),
        t("docs.skewAskGo"),
        () => {
          markAck(space);
          go();
        },
        t("docs.skewAskCancel"),
        undefined,
        { sticky: true, body: t("docs.skewAskBody") },
      );
    })
    .catch(showErr);
}

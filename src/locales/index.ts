// 字典合并点(i18n-plan §1):全部分片在此收拢。新分片必须两处登记(import + spread),
// 漏 spread 那半会被门禁「存而不用/文件未收进」逮住;跨分片重键当场 throw——spread
// 会静默后者覆前者,这里不许安静。
import { backup } from "./backup";
import { board } from "./board";
import { capture } from "./capture";
import { chrome } from "./chrome";
import { comments } from "./comments";
import { common } from "./common";
import { filter } from "./filter";
import { images } from "./images";
import { inbox } from "./inbox";
import { reminder } from "./reminder";
import { settings } from "./settings";
import { shell } from "./shell";
import { sync } from "./sync";
import { topics } from "./topics";

const parts = [backup, board, capture, chrome, comments, common, filter, images, inbox, reminder, settings, shell, sync, topics];
{
  const seen = new Set<string>();
  for (const part of parts) {
    for (const key of Object.keys(part)) {
      if (seen.has(key)) throw new Error(`i18n 字典跨分片重键:${key}`);
      seen.add(key);
    }
  }
}

export const messages = {
  ...backup,
  ...board,
  ...capture,
  ...chrome,
  ...comments,
  ...common,
  ...filter,
  ...images,
  ...inbox,
  ...reminder,
  ...settings,
  ...shell,
  ...sync,
  ...topics,
};

export type MsgKey = keyof typeof messages;

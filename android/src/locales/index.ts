// 字典合并点(i18n-plan §1),桌面 src/locales/index.ts 的安卓孪生。新分片必须两处
// 登记(import + spread),漏 spread 那半会被门禁「存而不用/文件未收进」逮住;跨分片
// 重键当场 throw——spread 会静默后者覆前者,这里不许安静。
import { backup } from "./backup";
import { cardpanel } from "./cardpanel";
import { checklist } from "./checklist";
import { comments } from "./comments";
import { filter } from "./filter";
import { images } from "./images";
import { main } from "./main";
import { misc } from "./misc";
import { panes } from "./panes";
import { settings } from "./settings";
import { shell } from "./shell";
import { sync } from "./sync";
import { topics } from "./topics";
import { viewer } from "./viewer";

const parts = [backup, cardpanel, checklist, comments, filter, images, main, misc, panes, settings, shell, sync, topics, viewer];
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
  ...cardpanel,
  ...checklist,
  ...comments,
  ...filter,
  ...images,
  ...main,
  ...misc,
  ...panes,
  ...settings,
  ...shell,
  ...sync,
  ...topics,
  ...viewer,
};

export type MsgKey = keyof typeof messages;

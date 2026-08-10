// 跨视图通用文案。⚠ 清扫 agent 不动这份(避免并行冲突):各文件的文案进各自分片,
// 值重复无妨、键不许撞。
import { defineMessages } from "./entry";

export const common = defineMessages({
  "common.appName": { zh: "朱简", en: "Zhujian" },
  "common.save": { zh: "保存", en: "Save" },
  "common.loading": { zh: "读取中…", en: "Loading…" },
});

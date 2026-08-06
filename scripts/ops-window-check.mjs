// **台架专用**(305 真机复验):读一端的**到达事实**——两条被验的写有没有自己过去。
//
// 判据刻意取两端不同的观测面(294 定的规矩:观测面单一就分不出「工装的 bug」和
// 「产品的患」):
//   * 桌面 = **直接只读打开 sqlite**,连 `oplog` 的 per-origin 水位一起读 —— 这是
//     最硬的一面,它不经过任何我们自己的运行期代码;
//   * 手机 = CDP 裸 invoke(库在 app 私有目录,release 包 run-as 进不去)。
//
// 用法:
//   node --experimental-sqlite scripts/ops-window-check.mjs --side desktop --db <path>
//   node scripts/ops-window-check.mjs --side phone --space <id>
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) {
    if (def === undefined) throw new Error(`缺参数 --${name}`);
    return def;
  }
  return process.argv[i + 1];
}

const side = arg("side");

if (side === "desktop") {
  const { DatabaseSync } = await import("node:sqlite");
  const d = new DatabaseSync(arg("db"), { readOnly: true });
  const me = d.prepare("select value v from sync_meta where key='device_id'").get()?.v ?? "?";
  const origins = d
    .prepare("select origin, count(*) n, max(origin_seq) mx from oplog group by origin order by origin")
    .all();
  const items = d
    .prepare("select id, substr(content,1,40) c, born_device from items where content like 'ZJ305%' order by created_at")
    .all();
  const devices = d.prepare("select device_id, alias from device_profile order by device_id").all();
  console.log(JSON.stringify({ side, me, origins, items, devices }, null, 2));
  d.close();
} else if (side === "phone") {
  const space = arg("space");
  const js = `(async () => {
    const inv = window.__TAURI_INTERNALS__.invoke;
    const SP = ${JSON.stringify(space)};
    const ident = await inv("device_identity", { spaceId: SP });
    const tl = await inv("list_timeline", { spaceId: SP });
    return {
      me: ident.thisDevice,
      devices: ident.devices,
      items: tl.filter((t) => (t.content || t.title || "").startsWith("ZJ305"))
              .map((t) => ({ id: t.id, c: (t.content || t.title || "").slice(0, 40) })),
    };
  })()`;
  const { stdout } = await run(process.execPath, ["scripts/android-cdp.mjs", "eval", js], {
    maxBuffer: 8 << 20,
  });
  const parsed = JSON.parse(stdout);
  console.log(JSON.stringify({ side, ...(parsed.value ?? parsed) }, null, 2));
} else {
  throw new Error("--side 只能 desktop|phone");
}

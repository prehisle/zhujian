// **台架专用**(305 真机复验;配 core 的 `probe305` feature 与 server 的 slow-syncd)。
//
// 一次「两条挨得近的本地写」试验:在发送端一口气做三件事,并把三个墙钟时刻交回来。
//
//   ① ballast —— 一条长正文的条目。它自己**立刻被 Ack**(限速 FIFO 的队头判据),
//      但把服务端的 `committed_until` 往前推了 ceil(字节/rate) 秒;
//   ② op1 —— 真正被验的第一条写。它的 Send 排在 ballast 之后,故 **Ack 被推迟数秒**;
//   ③ op2 —— 隔 `--gap` 毫秒的第二条写,落在 op1 的「取数 → Ack」窗口正中。
//
// 为什么要 ballast:被验的窗口天然只有一个中转往返(本机 ping 中转 = 178ms),抢得中
// 抢不中你自己都不知道 —— 而「抢没抢中」正是这轮验收唯一的假绿来源。有了它,窗口宽度
// 由服务端算式说了算,不靠运气。
//
// 三次写全在**页面内同一段脚本**里完成(不是每次一个 node 进程):CDP 起一次进程要
// 200ms,那量级会直接进判据(294 的 lan-bigimage-bench 栽过同一个坑)。
//
// 用法:
//   node scripts/ops-window-trial.mjs --side desktop --space main \
//        --scenario item-item --gap 2000 --ballast 200000 --tag T1
//   --scenario: item-item(阴性基线)/ item-alias / alias-item
//
// 交回 JSON:三个时刻(墙钟毫秒)+ 各自产出的 id / 别名,供与两端埋点、服务端日志对时。
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
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
const space = arg("space");
const scenario = arg("scenario", "item-item");
const gap = Number(arg("gap", "2000"));
const ballast = Number(arg("ballast", "200000"));
const tag = arg("tag", "T");

if (!["desktop", "phone"].includes(side)) throw new Error("--side 只能 desktop|phone");
if (!["item-item", "item-alias", "alias-item"].includes(scenario)) {
  throw new Error("--scenario 只能 item-item|item-alias|alias-item");
}

// 两壳的命令面不同名(桌面 capture_note 走 ForegroundSpace 复核,安卓 capture_idea
// 走 Coord 协调状态复核),但两边都要求「落点 == 当前前台空间」,故都得先切过去。
const CMD = {
  desktop: { capture: "capture_note", focus: "set_foreground_space" },
  phone: { capture: "capture_idea", focus: "activate_space" },
}[side];

const [kind1, kind2] = scenario.split("-");

// 页面内脚本。**必须包 IIFE**:CDP 复用同一执行上下文,连着两次 `const` 同名会
// 整条报错(294/295 各栽过一次)。
const script = `(async () => {
  const inv = window.__TAURI_INTERNALS__.invoke;
  const SP = ${JSON.stringify(space)};
  const TAG = ${JSON.stringify(tag)};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { tag: TAG, side: ${JSON.stringify(side)}, scenario: ${JSON.stringify(scenario)} };

  await inv(${JSON.stringify(CMD.focus)}, { spaceId: SP });
  // 两壳的命令返回都是 **snake_case**(serde 默认,没加 rename_all)。写成
  // \`thisDevice\` 会安安静静变成 undefined,再原样传给 set_device_alias ——
  // item-item 那一档还照跑不误,只有别名档才炸。故在这里就响亮判一次。
  const ident = await inv("device_identity", { spaceId: SP });
  out.me = ident.this_device;
  if (typeof out.me !== "string" || !out.me) {
    throw new Error("device_identity 没给出 this_device:" + JSON.stringify(ident).slice(0, 200));
  }

  const item = async (label) => {
    const id = await inv(${JSON.stringify(CMD.capture)}, { spaceId: SP, content: "ZJ305 " + TAG + " " + label });
    return { kind: "item", id };
  };
  const alias = async (label) => {
    const name = "ZJ305-" + TAG + "-" + label;
    await inv("set_device_alias", { spaceId: SP, deviceId: out.me, alias: name });
    return { kind: "alias", alias: name };
  };
  const make = { item, alias };

  // ① ballast:长正文条目,只为把服务端限速时钟往前推。
  out.ballast_w = Date.now();
  out.ballast = await inv(${JSON.stringify(CMD.capture)}, {
    spaceId: SP,
    content: "ZJ305 " + TAG + " BALLAST " + "b".repeat(${ballast}),
  });
  // ballast 自己是队头、立刻放行;等它真出门(帧封发 + Ack)再开始计时。
  await sleep(1500);

  // ② op1 —— 被验的第一条写。
  out.op1_w = Date.now();
  out.op1 = await make[${JSON.stringify(kind1)}]("A");

  await sleep(${gap});

  // ③ op2 —— 落在 op1 的窗口里;**这之后不再制造第三次写**(清单第 4 条)。
  out.op2_w = Date.now();
  out.op2 = await make[${JSON.stringify(kind2)}]("B");
  out.done_w = Date.now();
  return out;
})()`;

const tmp = `${process.env.TEMP || "/tmp"}/zj305-trial-${tag}.js`;
writeFileSync(tmp, script, "utf8");

const driver = side === "desktop" ? "scripts/desktop-cdp.mjs" : "scripts/android-cdp.mjs";
const { stdout } = await run(process.execPath, [driver, "evalfile", tmp], {
  cwd: process.cwd(),
  maxBuffer: 8 << 20,
});
const parsed = JSON.parse(stdout);
if (parsed.type === "object" && parsed.value) {
  console.log(JSON.stringify(parsed.value, null, 2));
} else {
  console.log(stdout);
}

// **台架专用**(305 真机复验):把一端的 P305 埋点流读成一份判据表。
//
// 判的是清单第 2 条与第 5 条:
//   ② `prepare(op1) < commit(op2) < Ack(op1)` —— 三个**单调**时刻(`t=`,微秒);
//      不落在窗口里的一轮**不算数**(这轮验收唯一的假绿来源就是「窗口从没被命中」);
//   ⑤ 收尾链 `RangeAt(op1) → RangeAt(op2) → RangeDrained → work empty`,
//      并核「线上 op1/op2 各恰一次、没有空探帧、没有重复帧」。
//
// 「空探帧」怎么核:`Spun` 那一支压根产不出帧,故判据 = **`relay_send`/`lan_send` 的
// 条数**恰等于该 origin 上真实要发的段数;空探若错误地出了帧,这个数当场对不上。
//
// 用法:
//   node scripts/ops-window-report.mjs --log <file> --dev <device 末6位> --since <epoch_ms>
//   （安卓侧先 `adb logcat -d > file`;桌面侧直接给 %LOCALAPPDATA%\app.zhujian.notebook\logs\zhujian.log）
import { readFileSync } from "node:fs";

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) {
    if (def === undefined) throw new Error(`缺参数 --${name}`);
    return def;
  }
  return process.argv[i + 1];
}

const dev = arg("dev", null);
const since = Number(arg("since", "0"));
const until = Number(arg("until", String(Number.MAX_SAFE_INTEGER)));
if (!Number.isFinite(since) || !Number.isFinite(until) || until <= since) {
  throw new Error(`--since/--until 不成区间:since=${since} until=${until}`);
}
const raw = readFileSync(arg("log"), "utf8").split(/\r?\n/);

// 两端前缀不同(桌面 tauri-plugin-log 带 [时间][target][级别],安卓 logcat 自带头),
// 故一律从 "P305 t=" 起切,前面的壳一个字都不解析。
const evs = [];
for (const line of raw) {
  const m = line.match(/P305 t=(\d+) w=(\d+) (.*)$/);
  if (!m) continue;
  const [, t, w, body] = m;
  // 上界不是可选装饰:少了它,`--since` 会把**后面几轮**一起收进来,而
  // 「op1/op2 = 最后两次 outbound」这条启发式当场指到别的轮次上去(判据会给出
  // 负数窗口这种一眼假的数,但换个次序就可能给出一眼真的假数)。
  if (Number(w) < since || Number(w) > until) continue;
  evs.push({ t: Number(t), w: Number(w), body });
}
if (!evs.length) {
  console.log("(窗口内没有任何 P305 事件——是不是 --since 给晚了 / 包没带 probe305?)");
  process.exit(0);
}

// 只留与本设备 origin 相关的行。带标的三种(`outbound me=` / `read_gap origin=` /
// `*_send origin=`)按标过滤;`prepare` / `ACK` / `commit` 本来就不带标,一律留下
// ——它们靠**紧邻的带标行**定位,自己滤掉反而会把收尾链打断。
const TAGGED = /\b(?:me|origin)=([0-9A-Z]{6})\b/;
const mine = dev
  ? evs.filter((e) => {
      const m = e.body.match(TAGGED);
      return !m || m[1] === dev;
    })
  : evs;

const t0 = mine[0].t;
const rel = (t) => ((t - t0) / 1000).toFixed(1).padStart(8) + "ms";

console.log("== 事件流 ==");
for (const e of mine) console.log(`${rel(e.t)}  ${e.body}`);

// —— 判据 ——
const prepares = mine.filter((e) => /read_gap .*-> RangeAt/.test(e.body));
const acks = mine.filter((e) => /^ACK relay ops/.test(e.body));
const outbounds = mine.filter((e) => /outbound .* admit=/.test(e.body));
// 三个出帧点各是一条腿:中转泵 / LAN 定向写泵 / 断网期协调者自取(BROADCAST)。
// 少数任何一条,「上线帧 0 枚」就会变成一句**空洞的绿**(T6 第一次跑就是这样:
// 纯局域网走的是第三条,而当时只埋了前两条)。
// ⚠ 三条腿的行**中段不同形**(`relay_send target=… origin=…` / `lan_send peer=…
// origin=…` / `offline_send origin=…`),故只锚命令名 + 行内有 `seqs=`,别写成
// 「命令名后面紧跟 origin=」—— 那样只有 offline_send 匹配得上,另外两条腿会安静地
// 数成 0 枚,再被下面「无重复帧」背书成一句绿。
const sends = mine.filter((e) => /^(relay_send|lan_send|offline_send) .*\bseqs=/.test(e.body));
const spuns = mine.filter((e) => /-> Spun/.test(e.body));
const retires = mine.filter((e) => /RETIRE/.test(e.body));

console.log("\n== 判据 ==");
if (outbounds.length >= 2 && prepares.length >= 1 && acks.length >= 1) {
  // op1 = 倒数第二次 outbound(ballast 之后那次);op2 = 最后一次。
  const o1 = outbounds[outbounds.length - 2];
  const o2 = outbounds[outbounds.length - 1];
  const p1 = prepares.find((e) => e.t >= o1.t);
  const a1 = acks.find((e) => e.t >= (p1?.t ?? Infinity));
  if (p1 && a1) {
    const inside = p1.t < o2.t && o2.t < a1.t;
    console.log(`② 窗口:prepare(op1)=${rel(p1.t)}  commit(op2)=${rel(o2.t)}  Ack(op1)=${rel(a1.t)}`);
    console.log(`   窗口宽度 ${((a1.t - p1.t) / 1000).toFixed(0)}ms,op2 落在开头后 ${((o2.t - p1.t) / 1000).toFixed(0)}ms 处`);
    console.log(`   ${inside ? "✔ 落在窗口内 —— 这一轮算数" : "✘ 没落在窗口内 —— 这一轮不算数,加大 ballast 或缩小 gap 重跑"}`);
    console.log(`   op2 的 outbound:${o2.body.includes("woke=false") ? "woke=false ✔(正是原缺陷那条静默丢的路径)" : "woke=true —— 段已退役,没踩到被验的那一格"}`);
  }
} else {
  console.log("② 事件不全(outbound/read_gap/ACK 至少各要一条)——窗口没成形。");
}
console.log(`⑤ 上线帧 ${sends.length} 枚:`);
for (const s of sends) console.log(`     ${s.body.replace(/ own_max_seq=.*/, "")}`);
const seqs = sends.map((s) => s.body.match(/seqs=(\d+)\.\.(\d+)/)).filter(Boolean);
const dup = seqs.map((m) => m[1] + ".." + m[2]).filter((v, i, a) => a.indexOf(v) !== i);
console.log(`   重复帧:${dup.length ? "✘ " + dup.join(",") : "✔ 无"}`);
console.log(`   空探(Spun,0 字节不上线)${spuns.length} 次;段退役 ${retires.length} 次`);
// 「零帧」不许算过:那既可能是真没发,也可能是**出帧点没被埋到**(见上面 sends 的注释)。
const produced = mine.filter((e) => /read_gap .*-> RangeAt/.test(e.body)).length;
if (!sends.length) {
  console.log(`   ✘ 一枚上线帧都没看到,而 read_gap 产出过 ${produced} 枚 —— 出帧点没埋全,别当「没发」读`);
} else if (sends.length !== produced) {
  console.log(`   ✘ 上线 ${sends.length} 枚 ≠ read_gap 产出 ${produced} 枚`);
} else {
  console.log(`   ${!dup.length ? `✔ 上线帧 ${sends.length} 枚 == read_gap 产出 ${produced} 枚,无重复(空探一枚都没上线)` : "✘ 有重复帧"}`);
}

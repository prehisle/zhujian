#!/usr/bin/env node
// 第十一道门禁(366):**问线上,不问仓里**。
//
// 前十道扫的全是工作区里的文件,判据是「这些文件彼此对不对得上」。它们答不了
// 唯一真正要紧的那个问题:**用户现在用的是哪一版**。这个盲区已经咬过两次:
//   · 官网 360-362 三笔(双语壳 / 字体栈 / 下划线)躺了一整天一格没部署 —— 365
//     发版前 curl 一下才发现,并把话写死成「判据别用『我改了』,要用『线上是什么』」;
//   · 服务端 260 的洪泛三闸躺了**十天** —— 因为「线上跑的是哪一版」此前只能 ssh
//     上去看二进制的 mtime,那是「看着像」不是「是」。
//
// 四个面各有各的漂法:官网是纯静态 scp(不进任何 CI,只有跑发版流程 5 才动)、
// 两份更新清单由 CI 传(与仓里版本号的对账全靠人)、syncd 只有人肉部署。
//
// ⚠ 583 加了第 ⑤ 格,它**不是第五个漂移面**,是一格资源水位(服务器磁盘)——
// 放这儿的唯一理由是「这只脚本本来就在发版路径上、本来就要 ssh」,理由与边界见那一节。
//
// **fail-closed**:任何一格问不到(网断 / ssh 不通 / 回体不合形)一律红,绝不
// 「跳过」——一道会安静跳过的闸和没有闸是一回事。
//
// 跑法:node scripts/check-deployed-drift.mjs
// 时机:发版前(流程 4 第 2 步)与发版后(流程 5 收尾),以及任何时候想知道
//       「线上到底是什么」。要网络 + ssh,故不进 CI。
//
// ⚠ 阴性对照见 `check-gate-knives.mjs` 的 `deployed` 组。④ 那四条分支(脏构建 /
// 本地没有 / 不是祖先 / 落后 N 笔)在正常运行里**一条都跑不到**——线上是好的时候
// 它们全是不可达的防护。故本脚本留一个**只给刀用**的注入口 `ZJ_DRIFT_FAKE_SYNCD`,
// 见下方 FAKE:注入模式下前三格整个不跑、且**恒 exit 1**,structurally 不可能
// 靠它伪造一次绿。

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// 只给阴性对照用:一段假的 /admin/version 回体。见顶注最后一段。
const FAKE = process.env.ZJ_DRIFT_FAKE_SYNCD;

const fails = [];
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => {
  fails.push(m);
  console.error(`  FAIL  ${m}`);
};

/** 拉线上内容。`--noproxy "*"` 不是可选的:本机代理 env 会截走请求(deploy §3)。
 *
 *  `--retry` 不是「兜底」:它只对**瞬时**错误(连不上 / 5xx / 超时)重试,404 与内容不符照旧
 *  当场失败。这一格是量出来的 —— 阴性对照跑一轮要发四十多次请求,不重试的话隔几轮就有一次
 *  抖动,而那次抖动会被跑手记成「某一刀没擦干净」(366 判例:一个自信的错答案)。 */
function curl(url, { binary = false } = {}) {
  const args = [
    "-sS", "--noproxy", "*", "--max-time", "20",
    "--retry", "2", "--retry-delay", "1", "--retry-connrefused",
    "--fail", url,
  ];
  return execFileSync("curl", args, binary ? { maxBuffer: 64 << 20 } : { encoding: "utf8" });
}

const git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const json = (p) => JSON.parse(readFileSync(p, "utf8"));

// ── 服务器地址从 deploy.md 那张表里读 ───────────────────────────────────────
// 别在这里再抄一份 IP:deploy.md §1 是单一真相源,抄第二份就是下一处会腐烂的事实
// (skill zhujian-ops 顶上那句同理)。读不出来 = 表的形状变了 = 响亮失败。
let DEPLOY_MD;
try {
  DEPLOY_MD = readFileSync("docs/deploy.md", "utf8");
} catch {
  // 公开仓里没有这份文档(运维手册不导出),而这本来就是一只只有维护者跑得动的运维脚本
  // ——它还要 ssh 进那台机器。把话说清楚,别让人对着 ENOENT 猜。
  console.error("读不到 docs/deploy.md:这是运维脚本,要在工作仓里跑(公开仓不含运维手册,也没有那台机器的访问权)。");
  process.exit(1);
}
const hostRow = DEPLOY_MD.match(/^\|\s*服务器\s*\|\s*`([\d.]+)`/m);
if (!hostRow) {
  console.error("读不出服务器地址:docs/deploy.md §1 那张表里「| 服务器 | `<ip>`」这一行的形状变了。");
  process.exit(1);
}
const HOST = hostRow[1];

if (FAKE) {
  console.log("⚠ ZJ_DRIFT_FAKE_SYNCD 已设:只跑第 ④ 格且用注入的假回体,本次结果不是对账。\n");
} else {
  console.log(`线上对账(服务器 ${HOST},地址取自 docs/deploy.md §1)\n`);
}

// ── ① 官网:线上根页面必须与仓里的 site/index.html 逐字节相同 ───────────────
// 逐字节而不是「版本号对上就行」:官网不进任何 CI,漂的方式是**整段内容**没上去
// (360-362 那三笔就是这么躺了一天的),只比版本号一格照样全绿。
if (!FAKE) {
  console.log("① 官网 zhujian.app");
  try {
    const local = readFileSync("site/index.html");
    const live = curl("https://zhujian.app/", { binary: true });
    if (Buffer.compare(local, live) === 0) {
      ok(`与 site/index.html 逐字节相同(${local.length} 字节)`);
    } else {
      bad(
        `线上与 site/index.html 不同(线上 ${live.length} 字节 / 本地 ${local.length} 字节)——` +
          `官网不进 CI,要跑 zhujian-ops 流程 5 才会动`,
      );
    }
  } catch (e) {
    bad(`拉不到官网:${e.message.trim()}`);
  }

  // ── ② 桌面更新清单 ───────────────────────────────────────────────────────
  console.log("\n② 桌面更新清单 updates/latest.json");
  try {
    const want = json("package.json").version;
    const live = JSON.parse(curl("https://zhujian.app/updates/latest.json"));
    if (live.version === want) ok(`版本 ${live.version} == package.json`);
    else bad(`线上 ${live.version} ≠ 仓里 ${want}`);
    // 三平台齐不齐是另一格:少一个平台 = 那个平台的存量用户收不到更新。
    const plats = Object.keys(live.platforms ?? {});
    if (plats.length >= 3) ok(`平台 ${plats.length} 个:${plats.join(" / ")}`);
    else bad(`平台只有 ${plats.length} 个(期望三平台):${plats.join(" / ") || "(空)"}`);
  } catch (e) {
    bad(`拉不到 latest.json:${e.message.trim()}`);
  }

  // ── ③ 安卓更新清单 ───────────────────────────────────────────────────────
  console.log("\n③ 安卓更新清单 updates/android.json");
  try {
    const want = json("android/package.json").version;
    // versionCode 由 tauri 从版本号推导(deploy §7.4);比较轴是它,不是版本串。
    const [maj, min, pat] = want.split(".").map(Number);
    const wantCode = maj * 1_000_000 + min * 1_000 + pat;
    const live = JSON.parse(curl("https://zhujian.app/updates/android.json"));
    if (live.version === want) ok(`版本 ${live.version} == android/package.json`);
    else bad(`线上 ${live.version} ≠ 仓里 ${want}`);
    if (live.versionCode === wantCode) ok(`versionCode ${live.versionCode}`);
    else bad(`线上 versionCode ${live.versionCode} ≠ 按 ${want} 推导的 ${wantCode}`);
  } catch (e) {
    bad(`拉不到 android.json:${e.message.trim()}`);
  }
}

// ── ④ 同步服务端:线上二进制是从哪个 commit 出来的 ──────────────────────────
// 指纹由 server/build.rs 焊在编译期,经 admin 面(回环 + token)取回。
console.log("\n④ 同步服务端 zhujian-syncd");
try {
  const raw =
    FAKE ??
    execFileSync(
      "ssh",
      [
        HOST,
        'curl -sS --max-time 10 -H "Authorization: Bearer $(cat /var/lib/zhujian-syncd/admin-token)" http://127.0.0.1:8788/admin/version',
      ],
      { encoding: "utf8" },
    );
  const v = JSON.parse(raw);
  const commit = String(v.commit ?? "");
  if (!/^[0-9a-f]{12}$/.test(commit)) throw new Error(`commit 不合形:${JSON.stringify(v)}`);
  console.log(`  线上 commit=${commit} dirty=${v.dirty} built_at=${v.built_at}`);

  if (v.dirty) {
    // 脏构建的 commit 说不全这只二进制是什么,后面的比对全都失去意义。
    bad("线上跑的是**脏构建**(构建时 server/ 或 sync-proto/ 有未提交改动)——重新从干净提交构建并部署");
  }
  let known = true;
  try {
    execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], { stdio: "ignore" });
  } catch {
    known = false;
    bad(`线上 commit ${commit} 本机仓里没有(没 fetch?或那只二进制不是从本仓构建的)`);
  }
  if (known && !v.dirty) {
    let ancestor = true;
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", commit, "HEAD"], { stdio: "ignore" });
    } catch {
      ancestor = false;
      // 线上**超前**或在另一条线上:同样是漂,而且更危险(仓里没有它的源码)。
      bad(`线上 commit ${commit} 不是 HEAD 的祖先——线上跑着仓里 HEAD 上没有的东西`);
    }
    if (ancestor) {
      const behind = git(["log", `${commit}..HEAD`, "--oneline", "--", "server/", "sync-proto/"]);
      if (!behind) {
        ok("线上 = HEAD 在 server/ 与 sync-proto/ 上的当前态");
      } else {
        const lines = behind.split("\n");
        bad(`线上落后 ${lines.length} 笔(server/ 或 sync-proto/ 已改但未部署):`);
        for (const l of lines) console.error(`          ${l}`);
      }
    }
  }
} catch (e) {
  bad(`问不到 syncd 版本:${e.message.trim()}`);
}

// ── ⑤ 服务器磁盘水位 ───────────────────────────────────────────────────────
// 583 接上(582 那次事故):这台上的磁盘**此前没有任何监控** —— 「这条路坏了谁会先发现」
// 的答案是「一次失败的发版」,而那已经是最贵的时刻。这一格落在这儿的理由 =
// memory `guards-must-bind-to-the-automatic-edge`「已有的接上了吗」:这只脚本本来就在
// 发版路径上(zhujian-ops 流程 4 第 2 步)、本来就要 ssh,加一格近乎免费。
// ⚠ **它不替代上传那一步的空间闸**:那道按「这一趟要传多少字节」算、拦在 CI 里;
//    这一格是**发版前**的一眼,水位定在 1 GiB —— 一趟桌面发版峰值约 250 MB
//    (2026-09-04 实测:updates/ 里桌面那套 123.5 MB + apk 36 MB,换名期间新旧共存),
//    低于 1 GiB 就说明有东西在长(582 那次是 napcat 容器日志 8.2G),该去清了。
// ⚠ 诚实边界:这一格**没有阴性对照刀**(要伪造 df 就得在这只脚本里再开一个注入口,
//    不划算)。它靠 fail-closed 活着:读不出数就红,而每次跑都会把真实读数印出来。
if (!FAKE) {
  console.log("\n⑤ 服务器磁盘");
  const FLOOR = 1024 * 1024; // KB
  try {
    const raw = execFileSync("ssh", [HOST, "df -P -k /"], { encoding: "utf8" });
    const row = raw.split("\n")[1]?.trim().split(/\s+/) ?? [];
    const avail = Number(row[3]);
    const cap = row[4];
    if (!Number.isFinite(avail)) throw new Error(`df 回体不合形:${JSON.stringify(raw)}`);
    const gib = (avail / 1024 / 1024).toFixed(2);
    if (avail >= FLOOR) ok(`/ 可用 ${gib} GiB(已用 ${cap})`);
    else bad(`/ 只剩 ${gib} GiB(已用 ${cap})——低于 1 GiB 水位,发版会写坏线上产物,先清盘`);
  } catch (e) {
    bad(`问不到磁盘:${e.message.trim()}`);
  }
}

// ── 收口 ───────────────────────────────────────────────────────────────────
if (FAKE) {
  // 注入模式恒红:否则这个口子就成了「设个环境变量把门禁哄绿」的后门。
  console.error("\n注入模式(ZJ_DRIFT_FAKE_SYNCD):本次不是对账,恒判不过。");
  process.exit(1);
}
if (fails.length) {
  console.error(`\n线上对账不过(${fails.length} 格):线上与仓里对不上,或根本问不到。`);
  console.error("处置:官网走 zhujian-ops 流程 5 / 更新清单走流程 4 / syncd 走流程 2。");
  process.exit(1);
}
console.log("\n线上对账通过:官网、两份更新清单、同步服务端都与仓里当前态一致,磁盘水位够发一趟版。");

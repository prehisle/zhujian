// 构建身份戳(701)——把「这只客户端是从哪棵树出来的」焊进前端产物。
//
// # 为什么非有它不可
// 用户日常那两台(桌面 + 那台 vivo)从 701 起常年跑**未发版的测试构建**,而界面上显示的
// 版本号取自 `tauri.conf.json` ⇒ **测试构建与正式版报的是同一个数字**。此前的对号办法是
// 每次交付把 exe 的 sha1 记进 progress-log,用户报 bug 时翻日志比对(memory
// `zhujian-rebuild-release-for-user-testing` 那条「版本号骗人」)。一台机器、几天一轮还撑得住;
// 两台机器 + 一周攒七八轮之后它就退化成猜 —— ⚠ 而且**它不报错,只给一个听起来很合理的错答案**。
// 服务端那只二进制 366 起就自报 commit(`check-deployed-drift` 第 ④ 格问的就是它),
// 客户端这一格一直空着,这里补上。
//
// # 为什么住 vite 的 define,不住 build.rs
// build.rs 的指纹跟着 **cargo 的重编判据**走:只改前端(TS/CSS)不会让 cargo 重跑 build
// script ⇒ 戳停在上一次的 commit。那是最危险的形 —— 它**声称自己干净、却指着另一棵树**,
// 与「版本号骗人」是同一种错(合理的错答案)。vite 每次 `tauri build` 都真跑一遍
// (它就是 beforeBuildCommand),戳因此恒新。
//
// # 脏判据 = 整棵树,含未跟踪文件
// ⛔ 别改成「只看某几个源码目录」:那份名单会随着新开目录悄悄失守,而失守的方向是
// **该说脏时说了干净**。含未跟踪文件同理 —— 一个没 `git add` 的新模块照样会被 vite 打进
// 产物(memory `baseline-tool-only-sees-tracked-files` 是同一族的反面教材)。
// 唯一的例外是下面 `EXCLUDE`,加一条之前**先证明没有任何构建读它**。
//
// # fail-fast,不留 "unknown"
// git 拿不到就拒绝构建(与 `server/build.rs` 同一条纪律)。一只自称身份未知的客户端会让
// 「你手上那只是哪棵树」重新变回猜,那正是本项目「绝不回退兜底」要挡的东西。
//
// # ⚠ 一条诚实边界:CI 发出去的包,戳上的 commit 是**公开仓**的
// 发版走公开仓的 tag(deploy §7.3a / §7.4a),CI 在公开仓检出构建 ⇒ 那只包自报的 commit
// 在工作仓里查不到,要去 `../zhujian-public` 查。dogfood 那两只是本机从工作仓构建的,
// 戳就是工作仓的 commit —— 而那正是这件工装要服务的场景。
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// 每一条都必须答得出「为什么它进不了产物一个字节」。
const EXCLUDE = [
  // CI 的安卓两条线在构建**之前**会 sed 掉它(把本机 file:// 的 gradle 分发地址改回官网
  // 直连,`android-release.yml` / `android-nightly.yml`)⇒ 不排掉的话**每一个 CI 发出去的
  // 安卓包都自报脏**,这一格就恒被忽略、等于没有。它只决定 gradle 去哪儿下载自己。
  ":(exclude)**/gradle-wrapper.properties",
  // 给 agent 读的规矩与 skill;没有任何构建步骤读 `.claude/`。⚠ 第三方 skill 常以未跟踪
  // 目录的形态躺在这儿(本轮开工时就躺着一个),不排掉的话它会把每一只包染成脏。
  ":(exclude).claude",
  // 纯文档。一轮的收口顺序是「先改码、后写文档」,不排掉的话**收口那一刻构建出的包必脏**
  // —— 而那正是要交付给用户的那一只。
  ":(exclude)docs",
];

function git(args) {
  const out = execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 << 20 });
  return out.trim();
}

/**
 * 取当前工作树的构建身份。git 不可用 / 答得不合形 → 抛,拒绝构建(见顶注)。
 * @returns {{ commit: string, dirty: boolean, at: number }}
 */
export function buildStamp() {
  let commit;
  try {
    commit = git(["rev-parse", "--short=12", "HEAD"]);
  } catch (e) {
    throw new Error(
      `构建期取 git 身份失败(${e.message})——朱简只从 git 检出构建,见 scripts/lib/build-stamp.mjs 顶注。` +
        `若 git 不在 PATH 里,vite 是由 npm 起的,查那一层的 PATH。`,
    );
  }
  if (!/^[0-9a-f]{12}$/.test(commit)) {
    throw new Error(`git 回的 commit 不合形:${JSON.stringify(commit)}(期望 12 位十六进制)`);
  }
  return { commit, dirty: git(["status", "--porcelain", "--", ".", ...EXCLUDE]) !== "", at: Date.now() };
}

/**
 * 给 vite `define` 用的那一份。⚠ 注入的是**单个对象**而不是三个独立标识符:
 * define 是纯文本替换,标识符越多越容易撞上源码里同名的东西。
 */
export function buildStampDefine() {
  return { __ZJ_BUILD__: JSON.stringify(buildStamp()) };
}

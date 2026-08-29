// 「我是哪个开发环境」—— 一个名字,存在各自的 `.git/config` 里(529 立,用户点名要)。
//
//   git config --local zhujian.env win-main
//
// ── 为什么是这个来源,不是别的 ────────────────────────────────────────────────
// ⛔ **不用 `os.hostname()`**:闸分支名**会进公开仓** ⇒ 主机名跟着进去(可能泄漏点什么)。
//    `.git/config` 不被 git 跟踪 ⇒ 不进任何提交、不进导出快照,泄漏面是零。
// ⛔ **不用 `win`/`linux` 这种平台名**:527/528 那次撞车是**实测**,不是担心 ——
//    两个开发环境都在 Windows 上、都署「Windows 那台」,平台名当场重名。
//    (backlog 43 里那句「⚠ 同平台第三台机器出现时会撞」,写下一天之后就撞上了。)
// ⭐ **粒度是「每个 clone 一个」不是「每台机器一个」** —— 同一台机器上两份工作副本
//    = 两个开发环境,这样它自动分得开。用户问的就是「开发环境」,粒度正好对上。
// ⛔ **不给默认值,读不到就停**:一个猜出来的环境名会让 `sweep` 去删**别人**的闸分支。
//    产品代码不写静默默认值(设计铁律),工装同理。
//
// ── 它与 521「不存状态文件」不冲突,边界在这儿 ────────────────────────────────
// ⭐ 521 那句「状态文件会腐烂,推导不会」针对的是**随树变化**的东西(sha)——存下来会过期。
//    环境名**不随树变**,它是身份不是状态。⇒ **会变的推导,不会变的存。**

import { execFileSync } from "node:child_process";

export const PUBLIC_REPO = "prehisle/zhujian";
export const PUBLIC_URL = `https://github.com/${PUBLIC_REPO}.git`;

// ⚠ 默认值是 Windows 那台的;Linux 那台直连,要 `ZJ_GIT_PROXY=`(空串 = 不走代理,450 实测)。
export const proxy = process.env.ZJ_GIT_PROXY ?? "socks5h://127.0.0.1:10808";

// ⛔ 平台名一律拒:它们正是 527/528 撞车的那一族。
const BANNED = new Set(["win", "windows", "linux", "mac", "macos", "darwin", "ohos", "android"]);
const SHAPE = /^[a-z][a-z0-9-]{1,15}$/;

/**
 * 本开发环境的名字。fail-closed:没设 / 形不对 / 是平台名,一律当场停。
 * @param {string} repoRoot 工作仓根(`git config` 要在仓里读)
 */
export function devEnv(repoRoot) {
  let name = "";
  try {
    name = execFileSync("git", ["config", "--get", "zhujian.env"], {
      cwd: repoRoot, encoding: "utf8",
    }).trim();
  } catch { /* 没设时 git 退出码非 0 */ }

  if (!name) {
    throw new Error(
      `这个开发环境还没起名字 —— 闸分支名与进度日志的「哪台」都要用它。\n` +
        `  ⇒ 设一次(存 .git/config,不进任何提交):\n` +
        `      git config --local zhujian.env <名字>\n` +
        `  名字自己起,小写字母开头、2-16 位 [a-z0-9-]。⛔ 别用 win / linux 这种平台名:\n` +
        `  527/528 那次撞车就是它 —— 两个环境都在 Windows 上,平台名当场重名。`,
    );
  }
  if (BANNED.has(name)) {
    throw new Error(
      `环境名 \`${name}\` 是平台名 —— ⛔ 不许用。\n` +
        `  同平台的第二个开发环境一出现它就重名(527/528 实测撞过)。\n` +
        `  ⇒ 起一个认得出「是哪个环境」的名字,例如 win-main / win-min-home。`,
    );
  }
  if (!SHAPE.test(name)) {
    throw new Error(
      `环境名 \`${name}\` 形不对 —— 要小写字母开头、2-16 位 [a-z0-9-]。\n` +
        `  (它要进分支名 \`gate/<环境名>/<sha>\`,所以不许带 \`/\`、空格、大写。)`,
    );
  }
  return name;
}

/**
 * 公开仓上现在挂着哪些闸分支。**不需要公开仓的本地 clone** —— 直接问远端 URL,
 * 这样 `claim-entry.mjs` 也用得上(它不知道公开仓副本在哪,两台还不一样)。
 * @returns {{ref:string, sha:string, env:string}[]}
 */
export function listGateBranches() {
  const out = execFileSync(
    "git",
    ["-c", `http.proxy=${proxy}`, "ls-remote", "--heads", PUBLIC_URL, "refs/heads/gate/*"],
    { encoding: "utf8" },
  );
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, ref] = line.split("\t");
      const m = /^refs\/heads\/gate\/([^/]+)\//.exec(ref);
      // ⚠ 老形 `gate/<sha>`(529 之前推的)认不出环境 ⇒ env = null,两边都别当成自己的。
      return { ref: ref.replace(/^refs\/heads\//, ""), sha, env: m ? m[1] : null };
    });
}

#!/usr/bin/env node
// 开源导出:把「拟公开白名单」内的 git 跟踪文件快照复制到公开仓目录。
// 白名单是 fail-closed:新增路径默认不导出,须显式加进 ALLOW 才会公开;
// 每次运行核对被排除的跟踪文件清单(防「以为都公开了」的静默漏配)。
// 用法:node scripts/export-public.mjs [目标目录] [--accept-exclusions]  (默认 ../zhujian-public)
//
// ⭐ 448(ci-plan 阶段 2)把那条「打印的排除清单**逐条过目**」换了形。原因很实:
// 排除清单今天 100+ 条、每轮几乎一模一样,而「每次都要逐条看一遍」的东西人只会越看越快,
// 到最后等于没看 —— 它要防的那件事(**某个本该公开的新文件被默认排除掉了**)恰恰只发生在
// 清单**变了**的那一刻。于是改成与基线 `.export-excluded.json` 比对:
//   · 一模一样  ⇒ 一行带过;
//   · **多出排除项** ⇒ 逐条打印并 **fail-closed 退出**(那正是要人看的那一刻),
//     确认无误后带 `--accept-exclusions` 再跑一趟,把新基线落盘;
//   · 少了排除项(某文件进了 ALLOW、或被删了)⇒ 只提示不拦,同样靠那个开关落基线。
// ⚠ 基线文件**不在 ALLOW 里**(同 `.export-redlines.json`)⇒ 它自己不进公开仓,
//   而它自己也在排除清单里 —— 自指但稳定,别去"修"。
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const acceptExclusions = argv.includes("--accept-exclusions");
const target = resolve(argv.find((a) => !a.startsWith("--")) ?? join(repoRoot, "..", "zhujian-public"));
// 这道闸守的是「别把自己清空」——下面会把 target 里除 .git 外的东西全删掉。
// ⚠ **按路径分段比,别用裸 `startsWith`**(450 在 Linux 那台真撞上):公开仓的工作副本在
// 那台叫 `/exworkspace/zhujian`,而工作仓叫 `/exworkspace/zhujian-dev` ⇒ 裸字符串前缀
// 判定「工作仓在目标目录里面」**成立**,导出当场被拒。它是**假阳性不是安全洞**(fail-closed
// 那一侧),但它把这台机器整条「导出 → 推公开仓 → CI」的路堵死了。
// ⛔ **而修法本身栽了一次,原样记着**:第一版写的是 `repoRoot.startsWith(target + sep)`,
//    看着对,却把 **`/`** 这一格漏了 —— `resolve("/")` 已经以分隔符结尾,再拼一个就是 `//`,
//    于是 `node scripts/export-public.mjs /` **不再被拒**,当场走进下面那个 `rmSync` 循环
//    (450 的阴性对照真的跑到了那一步;这台没有 root、`/` 又是 root 属主 0755,
//    一个条目都没删成 —— **是环境救的,不是代码救的**)。⇒ 拼分隔符前先看它有没有。
const targetPrefix = target.endsWith(sep) ? target : target + sep;
if (target === repoRoot || repoRoot.startsWith(targetPrefix)) {
  console.error(`目标目录不能是仓库自身或其祖先:${target}`);
  process.exit(1);
}

// 公开白名单(目录以 / 结尾按前缀匹配,其余精确匹配)
const ALLOW = [
  ".github/", "android/", "core/", "e2e/", "mobile/", "ohos/", "scripts/", "server/", "site/",
  "src/", "src-tauri/", "sync-proto/",
  "docs/sync-protocol.md", "docs/design-rules.md", "docs/why-no-framework.md",
  // 385:三道门禁(timing / radius / fs)会 readFileSync 它——§2.2/§2.4/§2.5 那三张表
  // 是**被核对的断言**,不是描述。它不进公开仓,那三道在公开仓的 CI 上就永远 ENOENT
  // (385 探路实测:preflight 红在第五道 check-timing-drift)。内容是纯 UI 规范,无商业/
  // 密钥/服务器信息;用户 2026-08-15 拍板公开。
  "docs/ui-guidelines.md",
  "index.html", "notebook.html", "package.json", "package-lock.json",
  "tsconfig.json", "vite.config.ts", "readme.md", "readme.en.md", "LICENSE",
  ".gitignore", ".gitattributes",
];
// 公开树内容红线:命中即导出失败(个人语境 / 真实局域网网段 / 历史遗留密钥名)。
// 模式清单存在 .export-redlines.json —— 它**不在下面的 ALLOW 里**,故清单本身不进公开仓,
// 这样才敢往里放「真实网段」这类不宜公开的字面量(296:模式写在本文件里时,能公开的只有
// 抓不着真东西的粗规则)。缺文件 / 解析失败 / 空清单一律 fail-closed:宁可发不出去,
// 不可静默地不扫。
function loadRedlines() {
  const p = join(repoRoot, ".export-redlines.json");
  let patterns;
  try {
    patterns = JSON.parse(readFileSync(p, "utf8")).patterns;
  } catch (e) {
    console.error(`红线模式文件读不动,拒绝导出:${p}\n  ${e.message}`);
    process.exit(1);
  }
  if (!Array.isArray(patterns) || patterns.length === 0 || patterns.some((s) => typeof s !== "string")) {
    console.error(`红线模式清单不是非空字符串数组,拒绝导出:${p}`);
    process.exit(1);
  }
  try {
    return new RegExp(patterns.join("|"));
  } catch (e) {
    console.error(`红线模式拼不成正则,拒绝导出:${e.message}`);
    process.exit(1);
  }
}
const FORBIDDEN = loadRedlines();

// ALLOW 里那几条以 `/` 结尾的是**整目录**放行,于是偶尔会有一份「住在放行目录里、却明显不该公开」
// 的文件。DENY 就是给这种逐条挖的洞 —— **它不削弱 fail-closed**:被挖掉的文件照样落进下面的
// 排除清单,基线变了一样要人签字。⛔ 别拿它当「先放行再挑刺」的口子,每条都要写清为什么。
const DENY = [
  // 换机器搬迁工装:它逐条点名作者本机上私钥/凭据的落点(~/.tauri 那几把、memory 目录)。
  // 对开源用户零用处,对旁人则是一张「钥匙都放在哪」的清单 ⇒ 不公开。
  "scripts/migrate-machine.mjs",
  // 条目落号工装:它的**整个作用对象**(`docs/progress-log.md`)不在 ALLOW 里 ⇒ 推上去
  // 只会是一个在公开仓那棵树上必然报错的脚本。⚠ 与上一条的理由**不同**:那条是"不该公开",
  // 这条是"公开了也没法用"。⛔ 别把它读成"内部工装一律不公开" ——
  // `e2e-session.mjs` / `run-on-desktop.ps1` / `lib/win-desktop.cs` 同样是内部工装,
  // 但它们跑的是这个项目自己的 e2e,对着公开仓那棵树是成立的,故照旧公开。
  "scripts/claim-entry.mjs",
];

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot })
  .toString("utf8").split("\0").filter(Boolean);
const allowed = tracked.filter(
  (p) => !DENY.includes(p) && ALLOW.some((a) => (a.endsWith("/") ? p.startsWith(a) : p === a)),
);
const excluded = tracked.filter((p) => !allowed.includes(p));

// 清空目标(保留其 .git,公开仓自身历史不动)
mkdirSync(target, { recursive: true });
for (const entry of readdirSync(target)) {
  if (entry === ".git") continue;
  rmSync(join(target, entry), { recursive: true, force: true });
}

let copied = 0;
for (const rel of allowed) {
  const dst = join(target, rel);
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(join(repoRoot, rel), dst);
  copied++;
}

// 内容红线扫描(只扫小于 2MB 的文件,二进制按 utf8 宽松解码——正则命中率只增不减)
const hits = [];
for (const rel of allowed) {
  // 扫描器自身也扫(296 起模式外置,它不再含红线字面量,那条豁免随之取消)
  const dst = join(target, rel);
  if (statSync(dst).size > 2 * 1024 * 1024) continue;
  if (FORBIDDEN.test(readFileSync(dst, "utf8"))) hits.push(rel);
}

console.log(`已导出 ${copied} 个文件 → ${target}`);

if (hits.length) {
  console.error(`\n❌ 内容红线命中,导出树不可发布:`);
  for (const p of hits) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("内容红线扫描通过。");

// ---- 排除清单与基线比对(448 起,替代「每轮逐条过目」)----------------------------
const baselinePath = join(repoRoot, ".export-excluded.json");
let baseline = null;
try {
  const raw = JSON.parse(readFileSync(baselinePath, "utf8"));
  if (Array.isArray(raw?.excluded) && raw.excluded.every((s) => typeof s === "string")) {
    baseline = new Set(raw.excluded);
  }
} catch {
  // 缺文件 / 解析不动 ⇒ 当作"没有基线",走下面 fail-closed 那支要人签一次字。
}

const nowSorted = [...excluded].sort();
const added = baseline ? nowSorted.filter((p) => !baseline.has(p)) : nowSorted;
const removed = baseline ? [...baseline].filter((p) => !excluded.includes(p)).sort() : [];

function writeBaseline() {
  writeFileSync(
    baselinePath,
    `${JSON.stringify(
      {
        note: "export-public.mjs 的排除清单基线:白名单外、故不进公开仓的跟踪文件。变了才提醒,新增即 fail-closed。改它的唯一正当方式是 `node scripts/export-public.mjs --accept-exclusions`。",
        excluded: nowSorted,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

if (!baseline) {
  console.error(`\n❌ 读不到排除清单基线 ${baselinePath} —— 这是第一次,得有人签一次字。`);
  console.error(`   白名单外的跟踪文件共 ${nowSorted.length} 个:`);
  for (const p of nowSorted) console.error(`  - ${p}`);
  if (!acceptExclusions) {
    console.error(`\n   逐条确认「这些确实都不该公开」之后,重跑一次并带上 --accept-exclusions。`);
    process.exit(1);
  }
  writeBaseline();
  console.log(`\n✅ 已落基线 → ${baselinePath}(${nowSorted.length} 条)`);
} else if (added.length === 0 && removed.length === 0) {
  console.log(`排除清单与基线一致(${nowSorted.length} 条,未导出的跟踪文件)。`);
} else {
  if (removed.length) {
    console.log(`\nℹ 少了 ${removed.length} 条排除项(进了 ALLOW,或文件被删):`);
    for (const p of removed) console.log(`  - ${p}`);
  }
  if (added.length) {
    console.error(`\n❌ 多出 ${added.length} 条排除项 —— **这就是要你看一眼的那一刻**:`);
    for (const p of added) console.error(`  - ${p}`);
    console.error(`   逐条问一句「它该公开吗」:该公开就把路径加进本脚本的 ALLOW;`);
    console.error(`   确实不该公开,就带 --accept-exclusions 再跑一趟把新基线落盘。`);
  }
  if (!acceptExclusions) process.exit(added.length ? 1 : 0);
  writeBaseline();
  console.log(`\n✅ 已落新基线 → ${baselinePath}(${nowSorted.length} 条)`);
}

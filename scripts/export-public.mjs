#!/usr/bin/env node
// 开源导出:把「拟公开白名单」内的 git 跟踪文件快照复制到公开仓目录。
// 白名单是 fail-closed:新增路径默认不导出,须显式加进 ALLOW 才会公开;
// 每次运行打印被排除的跟踪文件清单(防「以为都公开了」的静默漏配)。
// 用法:node scripts/export-public.mjs [目标目录]   (默认 ../zhujian-public)
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(process.argv[2] ?? join(repoRoot, "..", "zhujian-public"));
if (target === repoRoot || repoRoot.startsWith(target)) {
  console.error(`目标目录不能是仓库自身或其祖先:${target}`);
  process.exit(1);
}

// 公开白名单(目录以 / 结尾按前缀匹配,其余精确匹配)
const ALLOW = [
  "android/", "core/", "e2e/", "scripts/", "server/", "site/", "src/",
  "src-tauri/", "sync-proto/",
  "docs/sync-protocol.md", "docs/design-rules.md", "docs/why-no-framework.md",
  "index.html", "notebook.html", "package.json", "package-lock.json",
  "tsconfig.json", "vite.config.ts", "readme.md", "LICENSE",
  ".gitignore", ".gitattributes",
];
// 公开树内容红线:命中即导出失败(个人语境 / 局域网地址 / 历史遗留密钥名)
const FORBIDDEN = /妻子|老婆|192\.168\.\d|DEEPSEEK_API_KEY/;

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot })
  .toString("utf8").split("\0").filter(Boolean);
const allowed = tracked.filter((p) => ALLOW.some((a) => a.endsWith("/") ? p.startsWith(a) : p === a));
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
  if (rel === "scripts/export-public.mjs") continue; // 扫描器自身含红线字面量
  const dst = join(target, rel);
  if (statSync(dst).size > 2 * 1024 * 1024) continue;
  if (FORBIDDEN.test(readFileSync(dst, "utf8"))) hits.push(rel);
}

console.log(`已导出 ${copied} 个文件 → ${target}`);
console.log(`未导出的跟踪文件 ${excluded.length} 个(白名单外,逐条确认无遗漏):`);
for (const p of excluded) console.log(`  - ${p}`);
if (hits.length) {
  console.error(`\n❌ 内容红线命中,导出树不可发布:`);
  for (const p of hits) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("\n内容红线扫描通过。");

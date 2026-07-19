// 发版(88):核对三处版本号一致 + 从 NSIS 产物读安装包与更新签名(.sig),生成 Tauri v2
// 静态更新清单 latest.json。用法:
//   node scripts/gen-update-manifest.mjs ["更新说明"]
// 前置:先 `npm run tauri build`(带 TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]),产物落
// src-tauri/target/release/bundle/nsis/。生成后按打印的 scp 命令上传到 VPS。
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = "https://zhujian.app/updates";
const fwd = (p) => p.replace(/\\/g, "/");

// ── 1. 三处版本号必须一致(单一真相源分散在三个文件,漂移即拒发) ──
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const conf = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8")).version;
const cargo = readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8").match(
  /^version\s*=\s*"([^"]+)"/m,
)?.[1];
if (!(pkg === conf && conf === cargo)) {
  console.error(`版本号不一致:package.json=${pkg} tauri.conf.json=${conf} Cargo.toml=${cargo}`);
  console.error("发版前三处必须同步 bump(CLAUDE.md 约定)。");
  process.exit(1);
}
const version = pkg;

// ── 2. 从 NSIS 产物取安装包 + 更新签名 ──
const nsisDir = join(root, "src-tauri/target/release/bundle/nsis");
let files;
try {
  files = readdirSync(nsisDir);
} catch {
  console.error(`找不到 NSIS 产物目录:${nsisDir}`);
  console.error("先跑 `npm run tauri build`(带签名环境变量)。");
  process.exit(1);
}
// 按版本号挑,别拿目录里第一个 *-setup.exe(dry-run 会让 0.1.0 与 0.2.0 并存)。
const installer = files.find((f) => f.includes(version) && f.endsWith("-setup.exe"));
const sig = files.find((f) => f.includes(version) && f.endsWith("-setup.exe.sig"));
if (!installer || !sig) {
  console.error(`NSIS 目录里没找到当前版本 ${version} 的 *-setup.exe / *.sig。`);
  console.error("createUpdaterArtifacts 开了吗?TAURI_SIGNING_PRIVATE_KEY 设了吗?版本 bump 了吗?");
  console.error(`现有文件:${files.join(", ") || "(空)"}`);
  process.exit(1);
}
const signature = readFileSync(join(nsisDir, sig), "utf8").trim();

// ── 3. 生成 Tauri v2 静态清单(平台键 windows-x86_64) ──
const notes = process.argv[2] ?? `朱笺 v${version}`;
const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": { signature, url: `${BASE_URL}/${installer}` },
  },
};
const outPath = join(nsisDir, "latest.json");
writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

console.log(`✔ 生成 ${fwd(outPath)}`);
console.log(`  版本 ${version} · 安装包 ${installer}`);
console.log("");
console.log("上传到 VPS(先清旧包再传):");
console.log('  ssh 69.63.208.74 "rm -f /var/www/zhujian-app/updates/*-setup.exe"');
console.log(
  `  scp "${fwd(join(nsisDir, installer))}" "${fwd(outPath)}" 69.63.208.74:/var/www/zhujian-app/updates/`,
);
console.log(`  curl -s --noproxy "*" ${BASE_URL}/latest.json   # 核验`);

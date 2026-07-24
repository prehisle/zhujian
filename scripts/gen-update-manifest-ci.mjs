// 发版(release CI):从 CI 下载的三平台产物合并生成 Tauri v2 三平台 latest.json,
// 并把要上传 VPS 的文件收集到 upload/(带统一版本命名)。gen-update-manifest.mjs 的
// 三平台 CI 版——单机手动发版仍用那个只出 windows 键的脚本。用法:
//   node scripts/gen-update-manifest-ci.mjs <artifacts-dir> <upload-dir> ["更新说明"]
// <artifacts-dir>=download-artifact 落地根(含各平台子树,保留 bundle/{nsis,macos,appimage,dmg,deb})。
import { readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = "https://zhujian.app/updates";
const [, , artifactsDir, uploadDir, notesArg] = process.argv;
if (!artifactsDir || !uploadDir) {
  console.error("用法: node scripts/gen-update-manifest-ci.mjs <artifacts-dir> <upload-dir> [notes]");
  process.exit(1);
}

// 版本从 package.json(workflow 已校验 tag==此版本);notes 默认版本串
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const notes = notesArg ?? `朱简 v${version}`;

// 递归收集 artifacts 下所有文件,按后缀精确挑(sig 内容进 latest.json、sig 文件不上传)
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}
const all = walk(artifactsDir);
const pick = (suffix) => {
  const hit = all.filter((f) => f.endsWith(suffix));
  if (hit.length !== 1) {
    console.error(`挑 "${suffix}" 期望恰 1 个,实得 ${hit.length}:\n  ${hit.join("\n  ") || "(无)"}`);
    process.exit(1);
  }
  return hit[0];
};

// updater 产物(+ .sig)与首装包
const winExe = pick("-setup.exe");
const winSig = pick("-setup.exe.sig");
const macTar = pick(".app.tar.gz");
const macSig = pick(".app.tar.gz.sig");
const macDmg = pick(".dmg");
const linApp = pick(".AppImage");
const linSig = pick(".AppImage.sig");
const linDeb = pick(".deb");

// 统一带版本命名(mac tar 原名 zhujian.app.tar.gz 不带版本,补上;VPS 上「只留最新」但命名一致防混)
const winName = `zhujian_${version}_x64-setup.exe`;
const macTarName = `zhujian_${version}_aarch64.app.tar.gz`;
const macDmgName = `zhujian_${version}_aarch64.dmg`;
const linAppName = `zhujian_${version}_amd64.AppImage`;
const linDebName = `zhujian_${version}_amd64.deb`;

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": { signature: readFileSync(winSig, "utf8").trim(), url: `${BASE_URL}/${winName}` },
    "darwin-aarch64": { signature: readFileSync(macSig, "utf8").trim(), url: `${BASE_URL}/${macTarName}` },
    "linux-x86_64": { signature: readFileSync(linSig, "utf8").trim(), url: `${BASE_URL}/${linAppName}` },
  },
};

mkdirSync(uploadDir, { recursive: true });
const put = (src, name) => copyFileSync(src, join(uploadDir, name));
put(winExe, winName); // windows updater + 首装
put(macTar, macTarName); // mac updater
put(macDmg, macDmgName); // mac 首装
put(linApp, linAppName); // linux updater + 首装
put(linDeb, linDebName); // linux 首装(deb)
writeFileSync(join(uploadDir, "latest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

console.log(`✔ upload/ 就绪(版本 ${version}):`);
for (const n of [winName, macTarName, macDmgName, linAppName, linDebName, "latest.json"]) {
  console.log(`  ${n}`);
}

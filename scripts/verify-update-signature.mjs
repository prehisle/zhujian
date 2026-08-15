#!/usr/bin/env node
// 用**客户端里焊死的那把公钥**验 latest.json 每个平台产物的签名。
//
// 为什么值得单独一步(296 立):§7.3a 原来的线上核验只看「版本对不对、能不能下载」,
// 而签名是老客户端**唯一**的接受判据 —— 签错了产物照样 200、清单照样好看,但每一个
// 存量用户都会卡在旧版且毫无提示(updater 静默拒绝)。这类错误不报错,只给你一个
// 看着全绿的发版。
//
// 两种模式:
//   ① **上传前**(385 加,release.yml 的 publish job 在 scp 之前跑这一趟):
//      `--manifest upload/latest.json --artifacts upload` —— 清单与产物都从本地目录取,
//      **一个字节都不下载**。这是主路径:签名坏掉时产物根本上不了线。
//      ⚠ 给了 `--artifacts` 就**只认本地**,文件不在 = 当场判红,绝不回退去下载
//      (fail-fast:回退会把「产物没造出来」伪装成「验的是线上那份」)。
//   ② **上传后**(296 原形,人工复核线上那份还在不在、对不对):
//      不带 `--artifacts`,清单走 https、产物按需下载并缓存(AppImage 87 MB,重跑别再拉)。
//
// 用法:node scripts/verify-update-signature.mjs [--conf src-tauri/tauri.conf.json]
//                                               [--manifest https://zhujian.app/updates/latest.json]
//                                               [--artifacts <本地产物目录>]
//                                               [--cache <目录,默认系统临时目录>]
// 退出码非 0 = 有平台没通过。
import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const confPath = resolve(repoRoot, arg("--conf", "src-tauri/tauri.conf.json"));
const manifestUrl = arg("--manifest", "https://zhujian.app/updates/latest.json");
// 给了就只认本地产物(模式①),不回退下载。null = 模式②。
const artifactsDir = argv.includes("--artifacts") ? resolve(arg("--artifacts")) : null;
const cache = resolve(arg("--cache", join(tmpdir(), "zhujian-update-verify")));
mkdirSync(cache, { recursive: true });

// ── 公钥:tauri.conf.json 里那串 base64 解出来就是一个 minisign 公钥文件 ──
const pkFile = Buffer.from(
  JSON.parse(readFileSync(confPath, "utf8")).plugins.updater.pubkey,
  "base64",
).toString("utf8");
const pkRaw = Buffer.from(pkFile.trim().split("\n").pop().trim(), "base64");
const pkId = pkRaw.subarray(2, 10);
// Node 只认 SPKI DER;Ed25519 的 SPKI 前缀是固定这 12 字节。
const key = createPublicKey({
  key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pkRaw.subarray(10)]),
  format: "der",
  type: "spki",
});
console.log(`公钥 keyID=${pkId.toString("hex")}(取自 ${confPath.replace(repoRoot + "\\", "")})`);

const manifest = manifestUrl.startsWith("http")
  ? await (await fetch(manifestUrl)).json()
  : JSON.parse(readFileSync(resolve(manifestUrl), "utf8"));
console.log(`清单 ${manifestUrl} → 版本 ${manifest.version}\n`);

let bad = 0;
for (const [plat, p] of Object.entries(manifest.platforms)) {
  const name = p.url.split("/").pop();
  let file;
  if (artifactsDir) {
    // 模式①:只认本地那一份。不在就红——**不许回退去下载线上那份**,那会把
    // 「这次的产物没造出来」伪装成「验过了」。
    const local = join(artifactsDir, name);
    if (!existsSync(local)) {
      console.log(`❌ ${plat.padEnd(16)} 本地产物不在:${local}`);
      bad++;
      continue;
    }
    file = readFileSync(local);
  } else {
    const dst = join(cache, name);
    if (!existsSync(dst)) {
      const r = await fetch(p.url);
      if (!r.ok) {
        console.log(`❌ ${plat.padEnd(16)} 产物拉不动:HTTP ${r.status}`);
        bad++;
        continue;
      }
      writeFileSync(dst, Buffer.from(await r.arrayBuffer()));
    }
    file = readFileSync(dst);
  }

  // minisign 签名文件:第二行是 base64(2 字节算法 ‖ 8 字节 keyID ‖ 64 字节签名)。
  // "ED" = 先 BLAKE2b-512 预散列再签(tauri 用的就是它);"Ed" = 直接签原文。
  const sigLine = Buffer.from(p.signature, "base64").toString("utf8").split("\n").filter((l) => l.trim())[1];
  const sigRaw = Buffer.from(sigLine.trim(), "base64");
  const alg = sigRaw.subarray(0, 2).toString("utf8");
  const idOk = sigRaw.subarray(2, 10).equals(pkId);
  const signed = alg === "ED" ? createHash("blake2b512").update(file).digest() : file;
  const ok = verify(null, signed, key, sigRaw.subarray(10));
  if (!ok || !idOk) bad++;
  console.log(
    `${ok && idOk ? "✅" : "❌"} ${plat.padEnd(16)} alg=${alg} keyID一致=${idOk} 验签=${ok}  ${name} (${file.length} bytes)`,
  );
}

console.log(
  bad === 0
    ? `\n全部通过:存量客户端会接受这次更新(验的是${artifactsDir ? "上传前的本地产物" : "线上产物"})。`
    : `\n${bad} 个平台没通过 —— ${artifactsDir ? "**这批产物别上传**" : "别宣布发版"},先查签名钥。`,
);
process.exit(bad === 0 ? 0 : 1);

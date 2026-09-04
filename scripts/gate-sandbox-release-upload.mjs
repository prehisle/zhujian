#!/usr/bin/env node
// `scripts/release-upload.sh` 的阴性对照(583 立)。
//
// **为什么要有这一支**:那支脚本只在**发版当天**跑,而它守的正是「发版当天出事」那一档
// (582:满盘 ⇒ 旧包已删 / 新包是残骸 / 清单指着坏包)。memory `guards-must-bind-to-the-automatic-edge`
// 那条的形 —— 一道平时不跑的闸,坏了和好了长得一模一样 ⇒ 必须有台架能在任何一天证明它还有牙齿。
//
// **台架怎么骗过它**:不改脚本一个字,只在 PATH 前面摆三只假外部命令 ——
//   · `ssh`  → 把命令串原样 `bash -c` 在本机跑(远端目录就是一个真实的本地目录 ⇒ 路径天然对)
//   · `scp`  → 本地拷贝;`FAKE_TRUNCATE_AT` 下**只写前 N 字节却退出 0**(582 那种「写了一半」的形,
//              而且是最刁的那一版:退出码骗人 ⇒ 只有「核字节数」那一格能逮到它)
//   · `df`   → 按 `FAKE_AVAIL_KB` 印一张合形的表
// ⛔ 别把这三只做成「顺带也验证一下参数」的智能替身 —— memory `fixture-played-step-is-untested-assumption`:
//    夹具替演的那一步就是没被验证的假设。这里只演「外部世界」,判据全落在真实文件上。
//
// 跑法:node scripts/gate-sandbox-release-upload.mjs
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd().replace(/\\/g, "/");
const SANDBOX = mkdtempSync(join(tmpdir(), `zj-relup-${process.pid}-`)).replace(/\\/g, "/");
const BIN = `${SANDBOX}/bin`;
const LOG = `${SANDBOX}/calls.log`;

const sh = (script, env = {}) =>
  spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, ZJ_FAKE_LOG: LOG, ...env },
  });

function writeExec(path, body) {
  writeFileSync(path, body, "utf8");
  execFileSync("chmod", ["+x", path]);
}

mkdirSync(BIN, { recursive: true });
writeExec(
  `${BIN}/ssh`,
  `#!/usr/bin/env bash
printf 'ssh %s\\n' "$*" >> "$ZJ_FAKE_LOG"
cmd="\${@: -1}"
bash -c "$cmd"
`,
);
writeExec(
  `${BIN}/scp`,
  `#!/usr/bin/env bash
printf 'scp %s\\n' "$*" >> "$ZJ_FAKE_LOG"
args=(); for a in "$@"; do case "$a" in -i) skip=1;; *) if [ "\${skip:-}" = 1 ]; then skip=0; else args+=("$a"); fi;; esac; done
dest="\${args[\${#args[@]}-1]}"; unset 'args[\${#args[@]}-1]'
path="\${dest#*:}"
for src in "\${args[@]}"; do
  target="$path"
  [ -d "$path" ] && target="$path/\$(basename "$src")"
  if [ -n "\${FAKE_TRUNCATE_AT:-}" ]; then head -c "$FAKE_TRUNCATE_AT" "$src" > "$target"; else cp "$src" "$target"; fi
done
exit 0
`,
);
writeExec(
  `${BIN}/df`,
  `#!/usr/bin/env bash
echo "Filesystem     1024-blocks     Used Available Capacity Mounted on"
echo "/dev/fake         20547776 10933084 \${FAKE_AVAIL_KB:-8707180}      56% /"
`,
);

// ── 场景:线上是 0.2.40 那一套,要发 0.2.41 ─────────────────────────────────
const OLD = {
  "zhujian_0.2.40_x64-setup.exe": 6_000_126,
  "zhujian_0.2.40_amd64.AppImage": 8_811_570,
  "latest.json": null, // 见下,清单是文本
};
const NEW_PKGS = {
  "zhujian_0.2.41_x64-setup.exe": 6_010_000,
  "zhujian_0.2.41_amd64.AppImage": 8_820_000,
};
const GLOBS = ["*-setup.exe", "*.AppImage", "latest.json"];
const filler = (n, seed) => Buffer.alloc(n, seed);

function freshScene() {
  const remote = `${SANDBOX}/remote`;
  const local = `${SANDBOX}/local`;
  rmSync(remote, { recursive: true, force: true });
  rmSync(local, { recursive: true, force: true });
  mkdirSync(remote, { recursive: true });
  mkdirSync(local, { recursive: true });
  for (const [n, size] of Object.entries(OLD)) {
    if (size !== null) writeFileSync(`${remote}/${n}`, filler(size, 0x40));
  }
  writeFileSync(`${remote}/latest.json`, JSON.stringify({ version: "0.2.40" }) + "\n");
  for (const [n, size] of Object.entries(NEW_PKGS)) writeFileSync(`${local}/${n}`, filler(size, 0x41));
  writeFileSync(`${local}/latest.json`, JSON.stringify({ version: "0.2.41" }) + "\n");
  writeFileSync(LOG, "");
  return { remote, local };
}

const snapshot = (dir) =>
  readdirSync(dir)
    .sort()
    .map((n) => `${n}:${createHash("sha1").update(readFileSync(`${dir}/${n}`)).digest("hex").slice(0, 12)}`)
    .join("\n");

const run = (local, remote, env) =>
  sh(`"${ROOT}/scripts/release-upload.sh" "${local}" latest.json ${GLOBS.map((g) => `'${g}'`).join(" ")}`, {
    ZJ_UPLOAD_HOST: "zjci@fake",
    ZJ_UPLOAD_DIR: remote,
    ...env,
  });

// ── 刀 ─────────────────────────────────────────────────────────────────────
let bad = 0;
const knife = (name, fn) => {
  const scene = freshScene();
  const before = snapshot(scene.remote);
  let verdicts;
  try {
    verdicts = fn(scene, before);
  } catch (e) {
    verdicts = [[false, `刀自己炸了:${e.message}`]];
  }
  const okAll = verdicts.every(([v]) => v);
  if (!okAll) bad++;
  console.log(`${okAll ? "✔" : "✖"} ${name}`);
  for (const [v, msg] of verdicts) console.log(`    ${v ? "ok  " : "FAIL"} ${msg}`);
};

knife("① 正常路径:新包就位 / 清单是新的 / 旧包清干净 / 无临时件残留", ({ local, remote }) => {
  const r = run(local, remote, { FAKE_AVAIL_KB: "8707180" });
  const files = readdirSync(remote).sort();
  const manifest = JSON.parse(readFileSync(`${remote}/latest.json`, "utf8"));
  return [
    [r.status === 0, `退出码 ${r.status}(期望 0)`],
    [
      Object.keys(NEW_PKGS).every((n) => files.includes(n) && statSync(`${remote}/${n}`).size === NEW_PKGS[n]),
      `新包两只逐字节大小对(实得 ${files.join(", ")})`,
    ],
    [manifest.version === "0.2.41", `清单是新的(${manifest.version})`],
    [!files.some((n) => n.includes("0.2.40")), "旧包已清"],
    [!files.some((n) => n.endsWith(".uploading")), "无 .uploading 残留"],
  ];
});

knife("② 承重:盘不够 ⇒ 当场红,且**线上逐字节未动**", ({ local, remote }, before) => {
  // 8 MB 可用,而这一套要 ~15 MB ×2 + 64 MiB 水位
  const r = run(local, remote, { FAKE_AVAIL_KB: "8192" });
  return [
    [r.status !== 0, `退出码 ${r.status}(期望非 0)`],
    [/空间不够/.test(r.stderr), "红的理由说的是空间不够"],
    [snapshot(remote) === before, "远端逐字节与开跑前相同(旧包与旧清单原样)"],
    [!readdirSync(remote).some((n) => n.endsWith(".uploading")), "没留下临时件"],
  ];
});

knife("③ scp 写了一半却退出 0 ⇒ 靠核字节数逮住,线上仍未动", ({ local, remote }, before) => {
  const r = run(local, remote, { FAKE_AVAIL_KB: "8707180", FAKE_TRUNCATE_AT: "261120" });
  return [
    [r.status !== 0, `退出码 ${r.status}(期望非 0)`],
    [/传坏了|≠/.test(r.stderr), "红的理由说的是字节数对不上"],
    [snapshot(remote) === before, "远端逐字节与开跑前相同"],
    [!readdirSync(remote).some((n) => n.endsWith(".uploading")), "临时件已清"],
  ];
});

knife("④ 顺序:所有 scp 在任何 mv 之前,清单的 mv 排最后,清旧包再往后", ({ local, remote }) => {
  const r = run(local, remote, { FAKE_AVAIL_KB: "8707180" });
  const lines = readFileSync(LOG, "utf8").split("\n").filter(Boolean);
  const idx = (pred) => lines.map((l, i) => [l, i]).filter(([l]) => pred(l)).map(([, i]) => i);
  const scps = idx((l) => l.startsWith("scp "));
  const mvs = idx((l) => / mv -f /.test(l));
  const mvManifest = idx((l) => /mv -f .*latest\.json\.uploading/.test(l));
  const rmOld = idx((l) => /rm -f .*0\.2\.40/.test(l));
  return [
    [r.status === 0, `退出码 ${r.status}`],
    [scps.length === 3 && mvs.length === 3, `3 次 scp / 3 次 mv(实得 ${scps.length} / ${mvs.length})`],
    [Math.max(...scps) < Math.min(...mvs), "最后一次 scp 早于第一次 mv"],
    [mvManifest.length === 1 && mvManifest[0] === Math.max(...mvs), "清单那次 mv 排在最后"],
    [rmOld.length === 1 && rmOld[0] > mvManifest[0], "清旧包排在换清单之后"],
  ];
});

knife("⑤ 反向刀:旧那个「先 rm 后 scp」的形,在同一个局面下真会把线上毁掉", ({ local, remote }, before) => {
  // ⛔ 这一把不跑被测脚本,跑的是 582 之前两条 workflow 里那两行原文。
  // 它证明的是「洞真的存在」——没有它,上面四把只说明新脚本自洽。
  const r = sh(
    `set -e
     ssh zjci@fake "rm -f ${remote}/*-setup.exe ${remote}/*.AppImage ${remote}/latest.json"
     scp ${local}/* "zjci@fake:${remote}/"`,
    { FAKE_TRUNCATE_AT: "261120" },
  );
  const files = readdirSync(remote).sort();
  const manifest = JSON.parse(readFileSync(`${remote}/latest.json`, "utf8"));
  const truncated = Object.keys(NEW_PKGS).filter((n) => statSync(`${remote}/${n}`).size === 261120);
  return [
    [r.status === 0, `旧形自己不报错(退出码 ${r.status})—— 那正是它最坏的地方`],
    [snapshot(remote) !== before, "线上被改了(与开跑前不同)"],
    [!files.some((n) => n.includes("0.2.40")), "⚠ 旧包全没了(用户回退无路)"],
    [truncated.length === 2, `⚠ 新包是残骸(${truncated.length} 只只有 261,120 字节)`],
    [manifest.version === "0.2.41", "⚠ 清单完整且指着这些坏包 —— 582 线上那一幕"],
  ];
});

rmSync(SANDBOX, { recursive: true, force: true });
if (bad) {
  console.error(`\n${bad} 把刀没过:release-upload.sh 的保护掉了一格。`);
  process.exit(1);
}
console.log("\n5/5:空间闸、字节数闸、顺序、以及「旧形真会毁掉线上」的反向刀全部成立。");

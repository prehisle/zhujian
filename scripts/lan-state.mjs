// 局域网直连(L 系列)的**只读**观测面 —— 262 记账里那条「验收工装缺一条正式观测面」。
//
// 直连没有 UI(`SyncStatus` 的 lan_peers/lan_warning/lan_disabled 三格两端前端都没渲染),
// 验收得靠三个互相独立的面拼(见 docs/dev-and-testing.md「局域网直连的真机验收」):
//   ① 两端 sync_status 裸 invoke(desktop-cdp.mjs / android-cdp.mjs)
//   ② netstat 见真 TCP ESTABLISHED —— 不经我们自己的代码,最硬
//   ③ 直接读库的 sync_meta:lan_ad_owner / lan_ad_seq / lan_peer:<device>
// 本脚本收的是 ②③ 这两面(桌面侧)。① 得驱动运行中的 app,留在各自的 CDP 脚本里。
//
// 用法:node --experimental-sqlite scripts/lan-state.mjs [--dir <数据目录>] [--json]
// 只读打开,跑的时候 app 开着也安全。
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const dir = args.includes("--dir")
  ? args[args.indexOf("--dir") + 1]
  : join(process.env.APPDATA, "app.zhujian.notebook");
const asJson = args.includes("--json");

// ---- 最小 CBOR 解码器(只覆盖 LanPeerAd 用到的:map/array/text/bytes/uint/bool/null)----
// ciborium 把 struct 序列化成「文本键的 map」,serde_bytes 的字段是 major type 2。
function decodeCbor(buf) {
  let p = 0;
  const need = (n) => {
    if (p + n > buf.length) throw new Error("CBOR 截断");
  };
  function argOf(ai) {
    if (ai < 24) return ai;
    if (ai === 24) return (need(1), buf[p++]);
    if (ai === 25) return (need(2), ((buf[p++] << 8) | buf[p++]) >>> 0);
    if (ai === 26) {
      need(4);
      const v = buf.readUInt32BE(p);
      p += 4;
      return v;
    }
    if (ai === 27) {
      need(8);
      const v = buf.readBigUInt64BE(p);
      p += 8;
      return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
    }
    throw new Error(`不支持的 additional info ${ai}`);
  }
  function value() {
    need(1);
    const b = buf[p++];
    const major = b >> 5;
    const ai = b & 0x1f;
    switch (major) {
      case 0:
        return argOf(ai);
      case 2: {
        const n = Number(argOf(ai));
        need(n);
        const v = buf.subarray(p, p + n);
        p += n;
        return v;
      }
      case 3: {
        const n = Number(argOf(ai));
        need(n);
        const v = buf.toString("utf8", p, p + n);
        p += n;
        return v;
      }
      case 4: {
        const n = Number(argOf(ai));
        const out = [];
        for (let i = 0; i < n; i++) out.push(value());
        return out;
      }
      case 5: {
        const n = Number(argOf(ai));
        const out = {};
        for (let i = 0; i < n; i++) out[value()] = value();
        return out;
      }
      case 7:
        if (ai === 20) return false;
        if (ai === 21) return true;
        if (ai === 22) return null;
        throw new Error(`不支持的 simple value ${ai}`);
      default:
        throw new Error(`不支持的 major type ${major}`);
    }
  }
  const v = value();
  // 「严格一个值」——与 core 的 read_peer_ad 同口径:尾随字节即坏记录,别静默接受。
  if (p !== buf.length) throw new Error(`有尾随字节(读了 ${p}/${buf.length})`);
  return v;
}

function metaOf(db) {
  const rows = db
    .prepare(
      "SELECT key, value FROM sync_meta WHERE key IN ('device_id','lan_ad_owner','lan_ad_seq') OR key LIKE 'lan\\_peer:%' ESCAPE '\\'",
    )
    .all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

const spaces = [];
for (const f of readdirSync(dir)) {
  if (!f.endsWith(".sqlite3")) continue; // .bak-* / -wal / -shm 天然排除
  const path = join(dir, f);
  const space = { file: f };
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    const meta = metaOf(db);
    space.device_id = meta.device_id ?? null;
    space.lan_ad_owner = meta.lan_ad_owner ?? null;
    space.lan_ad_seq = meta.lan_ad_seq ?? null;
    try {
      space.name = db.prepare("SELECT name FROM space LIMIT 1").get()?.name ?? null;
    } catch {
      space.name = null; // 老库可能没有 space 表(0028 之前)
    }
    space.peers = [];
    for (const [k, v] of Object.entries(meta)) {
      if (!k.startsWith("lan_peer:")) continue;
      const peer = { device: k.slice("lan_peer:".length) };
      try {
        const rec = decodeCbor(Buffer.from(v, "hex"));
        peer.ad_seq = rec.ad_seq;
        peer.key_conflict = rec.key_conflict ?? false;
        peer.listen = rec.listen ? { port: rec.listen.port, addrs: rec.listen.addrs } : null;
        peer.received_at = rec.received_at;
        peer.received_at_iso = new Date(Number(rec.received_at)).toISOString();
        peer.pubkey_head = Buffer.from(rec.pubkey).toString("hex").slice(0, 16);
      } catch (e) {
        peer.error = String(e.message ?? e); // 读不动一律响亮,与 core 同口径
      }
      space.peers.push(peer);
    }
    db.close();
  } catch (e) {
    space.error = String(e.message ?? e);
  }
  spaces.push(space);
}

// netstat:24618 的真 TCP 态。桌面才有监听席位,手机恒无(Transport.lan = None)。
let sockets = [];
try {
  sockets = execFileSync("netstat", ["-ano"], { encoding: "utf8" })
    .split(/\r?\n/)
    .filter((l) => l.includes(":24618"))
    .map((l) => l.trim());
} catch (e) {
  sockets = [`netstat 失败:${e.message}`];
}

if (asJson) {
  console.log(JSON.stringify({ dir, spaces, sockets }, null, 2));
} else {
  console.log(`数据目录: ${dir}\n`);
  for (const s of spaces) {
    const tag = s.name ? `${s.name} ` : "";
    console.log(`── ${tag}${s.file}`);
    if (s.error) {
      console.log(`   打不开: ${s.error}`);
      continue;
    }
    console.log(
      `   device=${s.device_id}  lan_ad_owner=${s.lan_ad_owner ?? "(无)"}  lan_ad_seq=${s.lan_ad_seq ?? "(无)"}`,
    );
    if (!s.peers.length) console.log("   对端通告缓存: (空)");
    for (const p of s.peers) {
      if (p.error) {
        console.log(`   peer ${p.device}: 读不动 → ${p.error}`);
        continue;
      }
      const listen = p.listen ? `${p.listen.addrs.join(",")}:${p.listen.port}` : "(不监听)";
      const flag = p.key_conflict ? " ⚠禁用(同id异钥)" : "";
      console.log(
        `   peer ${p.device}  seq=${p.ad_seq}  listen=${listen}  收于=${p.received_at_iso}  pk=${p.pubkey_head}…${flag}`,
      );
    }
  }
  console.log(`\n── 24618 的真 TCP(netstat)`);
  console.log(sockets.length ? sockets.map((l) => "   " + l).join("\n") : "   (无)");
}

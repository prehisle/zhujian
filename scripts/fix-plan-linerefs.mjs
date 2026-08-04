// 一次性工装:把 lan-direct-plan.md 里已漂移的 transport.rs 行号钉回 2026-08-01 HEAD 的真实位置。
// 只做**字面**替换并逐条报数,替换 0 次即失败退出(防止「以为改了其实没匹配上」)。
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'docs/lan-direct-plan.md';

// [旧, 新, 说明];顺序有讲究——组合形("4047/4097")必须排在单个形之前。
const MAP = [
  ['transport.rs:4047/4097', 'transport.rs:4596/4646', 'serve_blob_relay 定义 / 每块 send_relay().await'],
  ['transport.rs:4852/4865', 'transport.rs:5422-5429', 'Sent::Direct 臂(不看 code)'],
  ['transport.rs:2647/2672', 'transport.rs:2704/2708', 'impl Drop for LanLink'],
  ['transport.rs:4874', 'transport.rs:5430-5432', '_ => {} 兜底臂 +「mail 帧不会 Nack」注释'],
  ['transport.rs:4341', 'transport.rs:4902-4903', 'send_relay 的 Sent 分类'],
  ['transport.rs:4365', 'transport.rs:4923-4925', 'tracked.insert 先于 await'],
  ['transport.rs:3248', 'transport.rs:3718', 'struct RelaySession'],
  ['transport.rs:3251', 'transport.rs:3721', 'tracked 字段'],
  ['transport.rs:3030', 'transport.rs:3223', 'lan_write_pump(现已是四段)'],
  ['transport.rs:7975-8013', 'transport.rs:9367-9404', 'lan_select_arms_only_name_the_event'],
  ['transport.rs:3971', 'transport.rs:4520', 'Deck::reverify_tick'],
  ['transport.rs:2859-2867', 'transport.rs:2994+', 'LanLinks::enqueue(第③笔已修)'],
  ['transport.rs:2912', 'transport.rs:3090', 'LanLinks::touch 刷 last_rx'],
  ['transport.rs:4047', 'transport.rs:4596', 'serve_blob_relay 定义(单独出现的那处)'],
  ['transport.rs:1718', 'transport.rs:1719', '唯一心跳定时器'],
  ['(2579/2942)', '(2600/3118)', 'LAN_SILENCE_SECS / LanLinks::beats'],
];

let text = readFileSync(FILE, 'utf8');
let failed = false;
for (const [from, to, why] of MAP) {
  const n = text.split(from).length - 1;
  if (n === 0) {
    console.error(`✗ 0 次命中,没改成:${from}  (${why})`);
    failed = true;
    continue;
  }
  text = text.split(from).join(to);
  console.log(`✓ ${from} → ${to}  ×${n}  (${why})`);
}
if (failed) process.exit(1);
writeFileSync(FILE, text);
console.log('\n写回', FILE);

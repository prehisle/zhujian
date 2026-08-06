//! **台架专用**(非生产二进制):可注入达量限速的 zhujian-syncd,用来把「发出一枚
//! ops 帧 → 收到它的 Ack」这个窗口从毫秒级拉到秒级。
//!
//! 为什么需要它(305 真机复验清单第 7 条):被验的活性缺口只在
//! `prepare(op1) < commit(op2) < Ack(op1)` 这个窗口里成立,而自然网络下它 ≈ 一个
//! 中转往返(本机 ping sync.zhujian.app = 178ms)。抢 200ms 的窗口不但难,更糟的是
//! **抢没抢中你自己不知道** —— 一轮「全绿」可能只说明窗口从没被命中。
//!
//! 为什么是 example 而不是给 `main.rs` 加开关:与 `busy-syncd.rs` 同一条理由 ——
//! 限速率是 §5.2 的资源闸,生产二进制不该长出「把闸拧到几乎不动」的入口。
//!
//! 机制:`conn.rs` 的 `throttle_wait` 排在 `dispatch` **之前**,而 `Ack` 是
//! `dispatch` 里生成的 —— 故等待时长直接就是 Ack 的推迟量,等待时长 =
//! `ceil(帧字节 / rate)`(`throttle::service_of`)。配一枚**大 op 帧**(一条长正文
//! 的条目,单帧上限 `MAX_OPS_FRAME_BYTES` = 256 KiB)即可换来数秒的确定窗口。
//!
//! `free_fastlane_bytes` 调到 1 = fresh 账户从第一帧起就在越额档,不必 admin 改配额。
//!
//! 启动校验(`serve_inner`)钉死 `device_cap·MAX_FRAME·3 ≤ rate·silence`,故
//! 拧小 rate 的同时要拧小 `device_cap`、拧大 `silence`;下面的默认值已配平并留了余量
//! (2·1 MiB·3 / 300s = 20972 B/s,取 24000 不贴界)。
//!
//! 跑法:
//! ```text
//! cargo run --release --example slow-syncd -- \
//!     --listen 0.0.0.0:8787 --data-dir ./slow-data
//! ```
//! 手机侧经 USB:`adb reverse tcp:8787 tcp:8787`,空间的服务器地址填
//! `ws://127.0.0.1:8787`(295 同法)。跑完 `adb reverse --remove tcp:8787`。

use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

#[tokio::main]
async fn main() {
    let mut listen: SocketAddr = "127.0.0.1:8787".parse().expect("字面量恒合法");
    let mut data_dir = PathBuf::from("./data");
    let mut rate: u64 = 24_000;
    let mut fastlane: u64 = 1;
    let mut device_cap: usize = 2;
    let mut silence_secs: u64 = 300;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--listen" => {
                let v = args.next().unwrap_or_else(|| die("--listen 缺参数"));
                listen = v.parse().unwrap_or_else(|_| die(&format!("--listen 不是合法地址:{v}")));
            }
            "--data-dir" => {
                data_dir = PathBuf::from(args.next().unwrap_or_else(|| die("--data-dir 缺参数")));
            }
            "--throttle-rate-bps" => rate = num(args.next(), "--throttle-rate-bps"),
            "--free-fastlane-bytes" => fastlane = num(args.next(), "--free-fastlane-bytes"),
            "--device-cap" => device_cap = num(args.next(), "--device-cap") as usize,
            "--silence-secs" => silence_secs = num(args.next(), "--silence-secs"),
            other => die(&format!(
                "未知参数 {other}\n用法:slow-syncd [--listen 0.0.0.0:8787] [--data-dir ./slow-data]\n  [--throttle-rate-bps 24000] [--free-fastlane-bytes 1] [--device-cap 2] [--silence-secs 300]"
            )),
        }
    }
    std::fs::create_dir_all(&data_dir)
        .unwrap_or_else(|e| die(&format!("建 data-dir {} 失败:{e}", data_dir.display())));
    let banlist = data_dir.join("banlist.txt");
    if !banlist.exists() {
        std::fs::write(&banlist, "# 台架:零封禁\n")
            .unwrap_or_else(|e| die(&format!("写空封禁表失败:{e}")));
    }
    let mut cfg = zhujian_syncd::Config::new(banlist, data_dir.join("registry.json"));
    cfg.throttle_rate_bps = rate;
    cfg.free_fastlane_bytes_per_month = fastlane;
    cfg.device_cap = device_cap;
    cfg.silence_timeout = Duration::from_secs(silence_secs);
    eprintln!(
        "slow-syncd 起在 {listen},data-dir={},rate={rate} B/s,fastlane={fastlane} B,\
         device_cap={device_cap},silence={silence_secs}s\n\
         → 一枚 N 字节的帧,Ack 推迟约 ceil(N/{rate}) 秒(256 KiB 满帧 ≈ {} 秒)",
        data_dir.display(),
        (256 * 1024_u64).div_ceil(rate)
    );
    let handle = match zhujian_syncd::serve(listen, cfg).await {
        Ok((addr, handle)) => {
            eprintln!("已监听 {addr}");
            handle
        }
        Err(e) => die(&format!("启动失败:{e}")),
    };
    let _ = handle.await;
}

fn num(v: Option<String>, flag: &str) -> u64 {
    let v = v.unwrap_or_else(|| die(&format!("{flag} 缺参数")));
    v.parse().unwrap_or_else(|_| die(&format!("{flag} 不是合法整数:{v}")))
}

fn die(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(1);
}

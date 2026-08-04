//! **台架专用**(非生产二进制):可注入字节预算的 zhujian-syncd,用来在真机上
//! 造出「服务端持续 `busy`」这一态。
//!
//! 为什么是 example 而不是给 `main.rs` 加开关:预算是 §5.2 的资源闸,生产二进制
//! 不该长出一个「把闸调到几乎为零」的入口(误设 = 全账户永久拒帧)。example 不
//! 随 `cargo install` 出货、也不进部署产物,验收跑完即失效。
//!
//! 用途见 lan-direct-plan §11「BUSY 注入」:`budget_global_bytes` 调到小于任何一
//! 枚帧时,`Hub::admit` 的全局线**恒**判不过 —— 走的是 hub.rs 那条「宁拒不 OOM」
//! 的硬拒路径(不驱逐、不摘连接),故是**稳定的持续 busy**,不是一瞬的抖动。
//! 鉴权 / 上下线广播不过 `admit`,故会话照样能稳在 Authed、对端照样显示在线。
//!
//! 跑法:
//! ```text
//! cargo run --release --example busy-syncd -- \
//!     --listen 0.0.0.0:8787 --data-dir ./busy-data --budget-global-bytes 1
//! ```
//! 预算给足(如 268435456)即是一台正常服务器,用来跑「无 LAN 时中转恢复」那一段。

use std::net::SocketAddr;
use std::path::PathBuf;

#[tokio::main]
async fn main() {
    let mut listen: SocketAddr = "127.0.0.1:8787".parse().expect("字面量恒合法");
    let mut data_dir = PathBuf::from("./data");
    let mut budget_global: Option<usize> = None;
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
            "--budget-global-bytes" => {
                let v = args.next().unwrap_or_else(|| die("--budget-global-bytes 缺参数"));
                budget_global = Some(
                    v.parse()
                        .unwrap_or_else(|_| die(&format!("--budget-global-bytes 不是合法整数:{v}"))),
                );
            }
            other => die(&format!(
                "未知参数 {other}\n用法:busy-syncd [--listen 0.0.0.0:8787] [--data-dir ./busy-data] [--budget-global-bytes N]"
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
    if let Some(b) = budget_global {
        cfg.budget_global_bytes = b;
    }
    eprintln!(
        "busy-syncd 起在 {listen},data-dir={},budget_global_bytes={}",
        data_dir.display(),
        cfg.budget_global_bytes
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

fn die(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(1);
}

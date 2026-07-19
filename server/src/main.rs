//! 薄壳:参数解析 + 起服务(库面见 lib.rs;部署形态见 sync-protocol §4——
//! 监听 localhost 明文 WS,TLS 由 Caddy 反代终结,P2-i)。

use std::net::SocketAddr;
use std::path::PathBuf;

#[tokio::main]
async fn main() {
    let mut listen: SocketAddr = "127.0.0.1:8787".parse().expect("字面量恒合法");
    let mut admin_listen: Option<SocketAddr> = None;
    let mut admin_token: Option<String> = None;
    let mut data_dir = PathBuf::from("./data");
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--listen" => {
                let v = args.next().unwrap_or_else(|| die("--listen 缺参数"));
                listen = v.parse().unwrap_or_else(|_| die(&format!("--listen 不是合法地址:{v}")));
            }
            "--admin-listen" => {
                let v = args.next().unwrap_or_else(|| die("--admin-listen 缺参数"));
                admin_listen = Some(
                    v.parse()
                        .unwrap_or_else(|_| die(&format!("--admin-listen 不是合法地址:{v}"))),
                );
            }
            "--admin-token-file" => {
                let v = args.next().unwrap_or_else(|| die("--admin-token-file 缺参数"));
                let raw = std::fs::read_to_string(&v)
                    .unwrap_or_else(|e| die(&format!("读 admin token 文件 {v} 失败:{e}")));
                admin_token = Some(raw.trim().to_owned());
            }
            "--data-dir" => {
                data_dir = PathBuf::from(args.next().unwrap_or_else(|| die("--data-dir 缺参数")));
            }
            // 封禁表离线校验(open-signup §1.6 运维纪律:先校验、原子替换、再 reload
            // ——直写活文件留坏内容会让下次重启 fail-fast 拒启)。与运行期同一解析器,
            // 过=打印封禁数退 0,不过=打印带行号的错误退 1。
            "--validate-banlist" => {
                let v = args.next().unwrap_or_else(|| die("--validate-banlist 缺参数(封禁表文件路径)"));
                match zhujian_syncd::registry::validate_banlist(std::path::Path::new(&v)) {
                    Ok(n) => {
                        println!("ok:封禁表合法,当前封禁 {n} 个账户");
                        std::process::exit(0);
                    }
                    Err(e) => die(&format!("封禁表不合法:{e}")),
                }
            }
            other => die(&format!(
                "未知参数 {other}\n用法:zhujian-syncd [--listen 127.0.0.1:8787] [--admin-listen 127.0.0.1:8788 --admin-token-file ./data/admin-token] [--data-dir ./data] | zhujian-syncd --validate-banlist <file>\n  data-dir 下须有 banlist.txt(封禁表:一行一个被封禁的 account_id,须为合法 26 位 ULID,# 整行注释;空文件=零封禁;准入开放,fresh 账户直接 TOFU;改动先 --validate-banlist 校验再原子替换)\n  admin 面(运营侧设备吊销)只许回环地址、别进反代;token 文件 openssl rand -hex 32 生成、chmod 600,两参数必须同给"
            )),
        }
    }
    let cfg = zhujian_syncd::Config::new(
        data_dir.join("banlist.txt"),
        data_dir.join("registry.json"),
    );
    let handle = match (admin_listen, admin_token) {
        (Some(admin), Some(token)) => {
            match zhujian_syncd::serve_with_admin(listen, admin, token, cfg).await {
                Ok((_, _, handle)) => handle,
                Err(e) => die(&format!("启动失败:{e}")),
            }
        }
        (None, None) => match zhujian_syncd::serve(listen, cfg).await {
            Ok((_, handle)) => handle,
            Err(e) => die(&format!("启动失败:{e}")),
        },
        _ => die("--admin-listen 与 --admin-token-file 必须同给(admin 面无 token 不开)"),
    };
    let _ = handle.await;
}

fn die(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(1);
}

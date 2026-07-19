//! 安卓半自动更新(106,android-plan §8「安卓端自更新」的 v1 轻提示兑现):启动时拉
//! https://zhujian.app/updates/android.json,versionCode 比本包新才回条目;前端出
//! 「下载」条,点了跳系统浏览器下 APK(同签名钥 + versionCode 递增,覆盖装数据存活
//! 已在 103 真机验证)。刻意不做应用内下载+调起安装:REQUEST_INSTALL_PACKAGES 权限
//! 加第三方安装插件换不来真「全自动」——vivo 的外部来源确认页哪条路都得手点。
//! 清单与桌面 latest.json 刻意分开:桌面那份归 Tauri updater 严格消费,两端发版节奏
//! 也不必绑死(生成脚本 scripts/gen-android-update-manifest.mjs)。

use std::time::Duration;

/// 安卓更新清单(android.json 全文)。
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidUpdate {
    pub version: String,
    /// 比较轴:覆盖安装的真实闸就是 versionCode 单调递增(L2),不做语义化版本解析。
    pub version_code: i64,
    pub notes: String,
    pub url: String,
}

pub const MANIFEST_URL: &str = "https://zhujian.app/updates/android.json";

/// tauri 从 version 推 versionCode 的同一条公式(major*1e6 + minor*1e3 + patch)——
/// 本包的比较基线必须与打进 APK 的 versionCode 逐位一致,否则提示与安装闸打架。
pub fn version_code_of(version: &str) -> Result<i64, String> {
    let parts: Vec<i64> = version
        .split('.')
        .map(|p| {
            p.parse::<i64>()
                .map_err(|e| format!("版本号「{version}」不合法:{e}"))
        })
        .collect::<Result<_, _>>()?;
    match parts.as_slice() {
        [major, minor, patch] => Ok(major * 1_000_000 + minor * 1_000 + patch),
        _ => Err(format!("版本号「{version}」不是 x.y.z 三段")),
    }
}

/// 拉清单并与本包比较:有更新 Some,已最新 None,网络/格式坏响亮 Err(吞不吞由调用方
/// 定——启动检查静默,logcat 的 UPDATE_CHECK 锚负责排障)。阻塞式,spawn_blocking 里跑。
pub fn check() -> Result<Option<AndroidUpdate>, String> {
    let local = version_code_of(env!("CARGO_PKG_VERSION"))?;
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(10))
        .build();
    let manifest: AndroidUpdate = agent
        .get(MANIFEST_URL)
        .call()
        .map_err(|e| format!("拉更新清单失败:{e}"))?
        .into_json()
        .map_err(|e| format!("更新清单不是合法 JSON:{e}"))?;
    Ok((manifest.version_code > local).then_some(manifest))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_code_matches_tauri_formula() {
        // 0.2.0 → 2000 是 103 轮真机核验过的锚(gen/android tauri.properties)。
        assert_eq!(version_code_of("0.2.0").unwrap(), 2000);
        assert_eq!(version_code_of("0.2.1").unwrap(), 2001);
        assert_eq!(version_code_of("1.0.0").unwrap(), 1_000_000);
    }

    #[test]
    fn version_code_rejects_malformed() {
        assert!(version_code_of("0.2").is_err());
        assert!(version_code_of("0.2.x").is_err());
        assert!(version_code_of("0.2.1.9").is_err());
        assert!(version_code_of("").is_err());
    }

    #[test]
    fn manifest_parses_and_compares() {
        let json = r#"{"version":"0.3.0","versionCode":3000,"notes":"说明","url":"https://zhujian.app/updates/zhujian_0.3.0_aarch64.apk"}"#;
        let m: AndroidUpdate = serde_json::from_str(json).unwrap();
        assert_eq!(m.version_code, 3000);
        assert!(m.version_code > version_code_of("0.2.1").unwrap());
        // 同版不提示:比较是严格大于。
        assert!(m.version_code <= version_code_of("0.3.0").unwrap());
    }
}

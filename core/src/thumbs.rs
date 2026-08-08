//! 缩略图本地派生表(0032 / image-perf-plan §3)—— 「算一次、存起来、之后只读几 KB」。
//!
//! 这里**没有一行图像处理代码**,也刻意不引 `image` crate:缩放本来就发生在两个壳的
//! WebView 里(canvas 中央方裁 + 重编码 JPEG),core 只负责把算好的那几 KB 存起来、
//! 按规格取回来。§3.2 的「零 Rust 图像依赖」就是这个意思。
//!
//! **四条性质(§3.1)**,与 0016 的正表相对:
//! ① 纯本地派生 —— 不发 op、不动时钟、不进同步、不进引导导入、不进 `strict_battery`;
//! ② 丢了能重建 —— 整表 DELETE 无害;
//! ③ 惰性填充 —— 存量图没有缩略图,第一次要显示时由前端算完 [`put`] 回存;
//! ④ 规格带版本 —— [`THUMB_SPEC`] 是**唯一真相源**,由 [`put`] 自己写、[`get`] 自己比;
//!    不匹配当未命中。改旋钮只改这个常量,存量行当场全体未命中、看一次即刷新。
//!
//! 删图/删条目的连带由 0032 的 `ON DELETE CASCADE` 负责(FK 三条开库路径均 enforce)。

use rusqlite::Connection;

use crate::repo::now_iso;

/// 当前缩略图规格的指纹。**唯一真相源**,只在 core 内部流转:[`put`] 写它、[`get`] 比它。
/// 壳与前端都碰不到这个 token(299 codex 实现审:让前端往返搬运它是伪契约,见 [`put`])。
///
/// 含义 = 「原图中央方裁 → 长边至多 144px → JPEG q0.8」,与两端 `shrinkToThumb` 的
/// `THUMB_PX` / 质量参数一一对应。**改那两个参数必须同轮改这里**,否则存量缓存会
/// 冒充新规格(改了这里则存量行全体未命中、看一次自动刷新,是安全方向)。
pub const THUMB_SPEC: &str = "144sq-jpeg80";

/// 缩略图字节上界(与 0032 的 CHECK 同值,`thumb_size_cap_matches_schema` 对拍钉死)。
///
/// 判据(首版自检 #2:把最大合法单笔负载和承载它的上界拉出来直接比):单笔 × 图张数
/// = 这张派生表的天花板。144² 的 JPEG 实测约 8 KB、未压缩 PNG 上限约 82 KB —— 128 KiB
/// 挡的是「把整图当缩略图塞进来」那个量级(整图均值 780 KB),不是一道紧贴实测值的闸。
pub const MAX_THUMB_BYTES: usize = 128 * 1024;

/// 缩略图恒为 JPEG(编进 [`THUMB_SPEC`],故表上不存 mime)。读路径直接拼这个 MIME。
pub const THUMB_MIME: &str = "image/jpeg";

/// 回存时 base64 字符串的长度上界 —— **在解码之前**用它挡住无界输入
/// (299 codex 实现审 L3:两壳原先先把整串解完,才由 core 检查 128 KiB)。
///
/// 规范 base64 是 4 字符编 3 字节 + `=` 补齐,故 [`MAX_THUMB_BYTES`] 对应
/// `ceil(131072/3)*4 = 174764` 字符。留这么紧是故意的:它挡的是「把整图 base64 灌进来」
/// 那个量级(32 MiB 的图 ≈ 4400 万字符),不是要精确到字节。
pub const MAX_THUMB_B64_CHARS: usize = (MAX_THUMB_BYTES.div_ceil(3)) * 4;

/// JPEG 的 SOI + 首个 marker 前缀。读路径对外宣称 `data:image/jpeg`,回存不验形态
/// 就等于放一个谎言进库(此后每次命中缓存都渲染失败,还看不出为什么)。
const JPEG_MAGIC: [u8; 3] = [0xFF, 0xD8, 0xFF];

/// 取一张图的缩略图字节:**命中且 spec 恰为当前规格**才返回 `Some`。
///
/// 规格不匹配(旧版本留下的行)与根本没有一律返回 `None` = 未命中 —— 调用方照旧回退
/// 到全尺寸(维持今天的行为,首次不比现在慢),前端算完会用新规格覆盖这一行。
pub fn get(conn: &Connection, image_id: &str) -> rusqlite::Result<Option<Vec<u8>>> {
    use rusqlite::OptionalExtension;
    conn.query_row(
        "SELECT data FROM item_image_thumb WHERE image_id = ?1 AND spec = ?2",
        rusqlite::params![image_id, THUMB_SPEC],
        |r| r.get(0),
    )
    .optional()
}

/// 回存一张缩略图(惰性填充;每张图至多一行,换规格即整行覆盖)。
///
/// 规格标签由**这里**写死成 [`THUMB_SPEC`],不由调用方传(299 codex 实现审:原先设计成
/// 「读命令下发 token → 前端原样带回 → put 校验相等」,那是**伪契约** —— token 恒等于同
/// 一个常量,这一趟往返在单进程内等价于前端硬编码,而且它**并不能证明**前端 canvas 那边
/// 的 144/q0.8 真的与 token 描述的一致。「改常量即存量行全体失效」这条价值由 [`get`] 里的
/// `AND spec = ?` 单独提供,与往返无关)。
///
/// 三条拒,全部 fail-fast(派生数据也不收来路不明的字节)。**点名不数数** —— 这个数
/// 曾在三处各写成 2 / 3 / 4(拆掉 spec 往返后没回扫,architecture 与 image-perf-plan
/// 都跟着漂了一轮,300 才对齐):
/// 1. 非空;
/// 2. ≤ [`MAX_THUMB_BYTES`](DB 的 CHECK 是背板,这里给人话;壳层另有
///    [`MAX_THUMB_B64_CHARS`] 在**解码前**挡一道);
/// 3. 必须真是 JPEG(见 [`JPEG_MAGIC`])。
///
/// 图不存在 = FK 违例 → 响亮 Err(不静默建孤儿行)。**不发 op、不动时钟**:调用方无需
/// 持时钟锁,拿库锁即可。
pub fn put(conn: &Connection, image_id: &str, data: &[u8]) -> Result<(), String> {
    if data.is_empty() {
        return Err("缩略图为空,拒绝回存".to_string());
    }
    if data.len() > MAX_THUMB_BYTES {
        return Err(format!(
            "缩略图过大({} 字节,上限 {MAX_THUMB_BYTES}),拒绝回存",
            data.len()
        ));
    }
    if !data.starts_with(&JPEG_MAGIC) {
        return Err("缩略图不是 JPEG(规格声明的是 jpeg),拒绝回存".to_string());
    }
    // 每张图至多一行:换规格 / 重算都整行覆盖(image_id 是主键)。派生行没有历史价值,
    // 不适用 item_image 的「只增删不改」不可变铁律 —— 那条守的是用户资产,这里是缓存。
    conn.execute(
        "INSERT INTO item_image_thumb (image_id, spec, data, created_at) VALUES (?1, ?2, ?3, ?4) \
         ON CONFLICT(image_id) DO UPDATE SET spec = excluded.spec, data = excluded.data, \
                                             created_at = excluded.created_at",
        rusqlite::params![image_id, THUMB_SPEC, data, now_iso()],
    )
    .map_err(|e| format!("缩略图回存失败:{e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::Clock;

    /// 一张最小合法 JPEG 的前缀 + 填充(本模块只看魔数,不解码)。
    fn jpeg(n: usize) -> Vec<u8> {
        let mut v = vec![0xFF, 0xD8, 0xFF, 0xE0];
        v.resize(n.max(4), 0x42);
        v
    }

    fn png() -> Vec<u8> {
        vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3]
    }

    /// 建库 + 一条带图的条目,返回 (conn, clock, item_id, image_id)。
    fn seed(tag: &str) -> (rusqlite::Connection, Clock, String, String) {
        let path = crate::test_temp::dir()
            .join(format!("zj-thumb-{tag}-{}.sqlite3", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let mut conn = crate::db::open(&path).expect("open migrated db");
        let mut clock = Clock::load(&conn).expect("clock");
        let item = crate::notes::capture(&mut conn, &mut clock, "带图的条目").unwrap();
        let (image, _seq) =
            crate::images::attach(&mut conn, &mut clock, &item, &jpeg(64), "image/jpeg").unwrap();
        (conn, clock, item, image)
    }

    /// §7 验收 1:命中 / 未命中 / spec 不匹配三条路。
    #[test]
    fn hit_miss_and_spec_mismatch() {
        let (conn, _clk, _item, image) = seed("paths");
        // 未命中(还没填过)。
        assert!(get(&conn, &image).unwrap().is_none(), "没填过 = 未命中");
        // 填 → 命中,字节原样。
        put(&conn, &image, &jpeg(1234)).unwrap();
        assert_eq!(get(&conn, &image).unwrap().unwrap(), jpeg(1234));
        // spec 不匹配 = 当未命中(直接改库造一行旧规格的,模拟版本升级后的存量行)。
        conn.execute(
            "UPDATE item_image_thumb SET spec = 'legacy-72sq' WHERE image_id = ?1",
            [&image],
        )
        .unwrap();
        assert!(get(&conn, &image).unwrap().is_none(), "spec 不匹配必须当未命中");
        // 重算回存:整行覆盖回当前规格,再次命中。
        put(&conn, &image, &jpeg(99)).unwrap();
        assert_eq!(get(&conn, &image).unwrap().unwrap(), jpeg(99));
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM item_image_thumb", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "每张图至多一行(覆盖而非追加)");
    }

    /// put 的三条拒 + FK:每一条都响亮拒,且**一行都不留**。
    #[test]
    fn put_rejects_bad_size_shape_and_unknown_image() {
        let (conn, _clk, _item, image) = seed("gates");
        let count = |c: &rusqlite::Connection| -> i64 {
            c.query_row("SELECT COUNT(*) FROM item_image_thumb", [], |r| r.get(0)).unwrap()
        };
        let e = put(&conn, &image, &[]).unwrap_err();
        assert!(e.contains("为空"), "{e}");
        let e = put(&conn, &image, &jpeg(MAX_THUMB_BYTES + 1)).unwrap_err();
        assert!(e.contains("过大"), "{e}");
        let e = put(&conn, &image, &png()).unwrap_err();
        assert!(e.contains("不是 JPEG"), "{e}");
        // 不存在的图 = FK 违例(不静默建孤儿行)。
        let e = put(&conn, "01NOSUCHIMAGE0000000000000", &jpeg(64)).unwrap_err();
        assert!(e.contains("回存失败"), "{e}");
        assert_eq!(count(&conn), 0, "三条拒 + FK 全部不留痕");
        // 恰好等于上界的放行(闸是 > 不是 >=)。
        put(&conn, &image, &jpeg(MAX_THUMB_BYTES)).unwrap();
        assert_eq!(count(&conn), 1);
    }

    /// Rust 常量与 0032 的 CHECK 必须同值 —— 靠 DB 亲口拒 MAX+1 来对拍(不是读 SQL 文本)。
    #[test]
    fn thumb_size_cap_matches_schema() {
        let (conn, _clk, _item, image) = seed("cap");
        let raw = |c: &rusqlite::Connection, n: usize| -> rusqlite::Result<usize> {
            c.execute(
                "INSERT INTO item_image_thumb (image_id, spec, data, created_at) \
                 VALUES (?1, ?2, ?3, '2026-08-05T00:00:00Z')",
                rusqlite::params![image, THUMB_SPEC, jpeg(n)],
            )
        };
        assert!(raw(&conn, MAX_THUMB_BYTES + 1).is_err(), "库的 CHECK 必须拒 MAX+1");
        assert!(raw(&conn, MAX_THUMB_BYTES).is_ok(), "库的 CHECK 必须放行恰好 MAX");
    }

    /// §7 验收 1(⚠ 要真验 FK 生效,不是只读代码):删图 / 删条目两级级联都带走缩略图。
    #[test]
    fn cascade_follows_image_and_item_deletion() {
        let (mut conn, mut clk, item, image) = seed("cascade");
        put(&conn, &image, &jpeg(64)).unwrap();
        let count = |c: &rusqlite::Connection| -> i64 {
            c.query_row("SELECT COUNT(*) FROM item_image_thumb", [], |r| r.get(0)).unwrap()
        };
        assert_eq!(count(&conn), 1);
        // ① 删图(images::remove 的正道)→ 缩略图随之走。
        crate::images::remove(&mut conn, &mut clk, &image).unwrap();
        assert_eq!(count(&conn), 0, "删图必须级联带走缩略图");
        // ② 删条目(items → item_image → item_image_thumb 两级级联)。
        let (image2, _) =
            crate::images::attach(&mut conn, &mut clk, &item, &jpeg(64), "image/jpeg").unwrap();
        put(&conn, &image2, &jpeg(64)).unwrap();
        assert_eq!(count(&conn), 1);
        conn.execute("DELETE FROM items WHERE id = ?1", [&item]).unwrap();
        assert_eq!(count(&conn), 0, "删条目必须两级级联带走缩略图");
    }

    /// 性质①:回存**不产生任何 op**(纯本地派生,永不进同步)。
    #[test]
    fn put_emits_no_op() {
        let (conn, _clk, _item, image) = seed("noop");
        let ops = |c: &rusqlite::Connection| -> i64 {
            c.query_row("SELECT COUNT(*) FROM oplog", [], |r| r.get(0)).unwrap()
        };
        let before = ops(&conn);
        put(&conn, &image, &jpeg(64)).unwrap();
        put(&conn, &image, &jpeg(65)).unwrap();
        assert_eq!(ops(&conn), before, "缩略图回存绝不进 oplog");
    }

    /// 性质②:整表 DELETE 无害 —— 数据面分毫未动,读回退到未命中。
    #[test]
    fn wiping_the_table_is_harmless() {
        let (conn, _clk, _item, image) = seed("wipe");
        put(&conn, &image, &jpeg(64)).unwrap();
        conn.execute("DELETE FROM item_image_thumb", []).unwrap();
        assert!(get(&conn, &image).unwrap().is_none());
        let (bytes, mime) = crate::repo::item_image_data(&conn, &image).unwrap().unwrap();
        assert_eq!(mime, "image/jpeg");
        assert_eq!(bytes, jpeg(64), "正表字节分毫未动");
        // 补回来照旧。
        put(&conn, &image, &jpeg(64)).unwrap();
        assert!(get(&conn, &image).unwrap().is_some());
    }

    /// 性质①续:这张表不进 `strict_battery`(纯本地派生行不该被当成「无背书的行」拒)。
    #[test]
    fn thumbs_do_not_disturb_the_strict_battery() {
        let (conn, _clk, _item, image) = seed("battery");
        crate::sync::boot::strict_battery(&conn).expect("填之前就该过");
        put(&conn, &image, &jpeg(64)).unwrap();
        crate::sync::boot::strict_battery(&conn).expect("有缩略图行照样过严格电池");
    }
}

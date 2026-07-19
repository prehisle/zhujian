//! Fractional index(分数排序键)—— 看板列内手动序的排序轴(迁移 0021 起,还 sync-plan
//! P1「position 改 fractional index」的债)。
//!
//! 键是 base62 字母表上的短字符串,**字节序(= SQLite BINARY 文本序)即排序序**——与
//! HLC 编码同一手法(clock.rs:字典序 == 逻辑序),SQLite 直接 `ORDER BY position`。
//! 核心操作只有一个:`key_between(a, b)` 造出严格落在 a、b 之间的新键——把卡插进任意
//! 两张卡之间**只写这一张卡**,不必重排整列;a/b 缺省对应「列首前」/「列尾后」。
//!
//! 多写者友好正是还债动机:整数密排下,两端离线各自拖动必撞旧的 (stage, position) 唯一
//! 索引,且一次拖动要发整列 op;分数键下一次拖动只发一条 position op。**注意本算法是
//! 确定性的:两端离线往同一空隙插卡会算出同一个键**(70 纠正早期「各得不同键」的错误
//! 认识)——所以 0022 把唯一索引降成了普通索引,同键并列由读序 (position, id) 打平,
//! 这是多写者合并的合法结局,不是要避免的事故。
//!
//! 键的结构:整数段 + 可选小数段。整数段头字符标记自身长度('a'-'z' 为正、总长 2-27;
//! 'A'-'Z' 为负、反向),顺序追加走整数递增("a0"→"a1"…"az"→"b00"),键长 O(log n)
//! 不随追加次数疯长;同一整数段内插空隙走小数段中点("a0"|"a1" → "a0V")。小数段禁
//! 尾随最小 digit '0'(规范形态唯一,任何空隙恒可再分)。算法忠实移植业界公认的
//! fractional-indexing(rocicorp / David Greenspan),不自创变体——排序键的正确性
//! 值不得省,自创变体省不出任何东西。

/// base62 digit 表,升序 == ASCII 字节序('0'-'9' < 'A'-'Z' < 'a'-'z')。
const DIGITS: &[u8; 62] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE: usize = 62;

/// 一个 digit 字符在表内的序号;表外字符 = 键不合规。
fn digit_index(c: u8) -> Result<usize, String> {
    match c {
        b'0'..=b'9' => Ok((c - b'0') as usize),
        b'A'..=b'Z' => Ok((c - b'A') as usize + 10),
        b'a'..=b'z' => Ok((c - b'a') as usize + 36),
        other => Err(format!("排序键含 base62 之外的字符:{:?}", other as char)),
    }
}

/// 整数段总长(含头字符)由头字符决定:'a'+1 位、'b'+2 位……负数从 'Z' 反向同理。
fn int_len(head: u8) -> Result<usize, String> {
    match head {
        b'a'..=b'z' => Ok((head - b'a') as usize + 2),
        b'A'..=b'Z' => Ok((b'Z' - head) as usize + 2),
        other => Err(format!("排序键头字符必须是字母:{:?}", other as char)),
    }
}

/// 最小的整数段("A" + 26 个 '0')。它前面没有整数可用,故**不允许作为完整键存在**
/// (在它之前插入只能走它的小数段);key_between 的 None 下界永远够用。
fn smallest_int() -> String {
    format!("A{}", "0".repeat(26))
}

/// 校验一枚完整键的规范形态。不合规的键说明库被外部改写或代码有 bug——调用方按
/// fail-fast 处置(repo 层 panic,编排层报错),绝不静默修复。
pub fn validate(key: &str) -> Result<(), String> {
    let bytes = key.as_bytes();
    let head = *bytes.first().ok_or("排序键不能为空")?;
    let ilen = int_len(head).map_err(|e| format!("{e}(键 {key:?})"))?;
    if bytes.len() < ilen {
        return Err(format!("排序键整数段不完整:{key:?}(头字符要求总长 ≥ {ilen})"));
    }
    for &c in bytes {
        digit_index(c).map_err(|e| format!("{e}(键 {key:?})"))?;
    }
    if bytes[ilen..].last() == Some(&b'0') {
        return Err(format!("排序键小数段不得以 '0' 结尾(非规范形态):{key:?}"));
    }
    if key == smallest_int() {
        return Err(format!("最小整数段保留,不可作为键:{key:?}"));
    }
    Ok(())
}

/// 键的整数段切片(键已过 validate)。
fn int_part(key: &str) -> &str {
    let ilen = int_len(key.as_bytes()[0]).expect("已校验的键头字符必是字母");
    &key[..ilen]
}

/// 整数段 +1:低位进位,全进位时头字符升级(正数变长 "az"→"b00"、负数变短、跨零
/// "Zz"→"a0")。None = 已是最大整数段("z"+26 个 'z'),调用方退回小数段续尾。
fn increment_int(x: &str) -> Option<String> {
    let bytes = x.as_bytes();
    let head = bytes[0];
    let mut digs: Vec<u8> = bytes[1..].to_vec();
    for i in (0..digs.len()).rev() {
        let d = digit_index(digs[i]).expect("已校验") + 1;
        if d < BASE {
            digs[i] = DIGITS[d];
            return Some(compose(head, &digs));
        }
        digs[i] = DIGITS[0];
    }
    match head {
        b'Z' => Some("a0".to_string()),
        b'z' => None,
        h => {
            let nh = h + 1;
            if nh > b'a' {
                digs.push(DIGITS[0]); // 正数升长度
            } else {
                digs.pop(); // 负数向零收短
            }
            Some(compose(nh, &digs))
        }
    }
}

/// 整数段 -1(increment_int 的镜像)。None = 已是最小整数段,前面没有整数可用。
fn decrement_int(x: &str) -> Option<String> {
    let bytes = x.as_bytes();
    let head = bytes[0];
    let mut digs: Vec<u8> = bytes[1..].to_vec();
    for i in (0..digs.len()).rev() {
        match digit_index(digs[i]).expect("已校验").checked_sub(1) {
            Some(d) => {
                digs[i] = DIGITS[d];
                return Some(compose(head, &digs));
            }
            None => digs[i] = DIGITS[BASE - 1],
        }
    }
    match head {
        b'a' => Some("Zz".to_string()),
        b'A' => None,
        h => {
            let nh = h - 1;
            if nh < b'Z' {
                digs.push(DIGITS[BASE - 1]); // 负数升长度
            } else {
                digs.pop(); // 正数向零收短
            }
            Some(compose(nh, &digs))
        }
    }
}

fn compose(head: u8, digs: &[u8]) -> String {
    let mut s = String::with_capacity(1 + digs.len());
    s.push(head as char);
    s.push_str(std::str::from_utf8(digs).expect("digits 全是 ASCII"));
    s
}

/// 小数段中点:返回严格落在 a 与 b 之间的小数段(b = None 视为上界 1)。
/// 前置条件(由 key_between 的 validate + a<b 检查保证):a < b、二者皆无尾随 '0'、
/// b 若给出必非空。
fn midpoint(a: &str, b: Option<&str>) -> String {
    if let Some(b) = b {
        // 剥掉公共前缀(a 视为以 '0' 无限补齐)。
        let ab = a.as_bytes();
        let bb = b.as_bytes();
        let mut n = 0;
        while n < bb.len() && ab.get(n).copied().unwrap_or(b'0') == bb[n] {
            n += 1;
        }
        assert!(n < bb.len(), "midpoint 前置条件被破坏:a={a:?} 不小于 b={b:?}");
        if n > 0 {
            let a_rest = if n <= a.len() { &a[n..] } else { "" };
            return format!("{}{}", &b[..n], midpoint(a_rest, Some(&b[n..])));
        }
    }
    // 首位 digit(或缺位)不同。
    let digit_a = if a.is_empty() { 0 } else { digit_index(a.as_bytes()[0]).expect("已校验") };
    let digit_b = match b {
        Some(b) => digit_index(b.as_bytes()[0]).expect("已校验"),
        None => BASE,
    };
    if digit_b - digit_a > 1 {
        // 空隙够宽:取中(四舍五入偏上,与参考实现一致)。
        let mid = (digit_a + digit_b + 1) / 2;
        (DIGITS[mid] as char).to_string()
    } else if b.is_some_and(|b| b.len() > 1) {
        // 首位相邻且 b 还有后续:b 的首位本身就严格在 a、b 之间(b 无尾随 '0')。
        b.expect("上一行已判 Some")[..1].to_string()
    } else {
        // 首位相邻且 b 已尽:沿 a 的首位下钻,在 a 的余部之后续中点。
        let a_rest = if a.is_empty() { "" } else { &a[1..] };
        format!("{}{}", DIGITS[digit_a] as char, midpoint(a_rest, None))
    }
}

/// 造一枚严格落在 a 与 b 之间的新键(唯一的公开入口)。
///   * `(None, None)` -> 首键 "a0"(空列第一张卡);
///   * `(Some(a), None)` -> 比 a 大:整数段 +1,溢出则小数段续尾(列尾追加);
///   * `(None, Some(b))` -> 比 b 小:整数段 -1 或钻 b 的小数段(列首前插);
///   * `(Some(a), Some(b))` -> 二者之间(卡与卡之间插入)。
/// 输入键先过 validate 且要求 a < b,违反即 Err——库里的键不合规是数据事故,fail-fast。
pub fn key_between(a: Option<&str>, b: Option<&str>) -> Result<String, String> {
    if let Some(a) = a {
        validate(a)?;
    }
    if let Some(b) = b {
        validate(b)?;
    }
    if let (Some(a), Some(b)) = (a, b) {
        if a >= b {
            return Err(format!("排序键无中间可插:要求 a < b,收到 a={a:?} b={b:?}"));
        }
    }
    match (a, b) {
        (None, None) => Ok("a0".to_string()),
        (None, Some(b)) => {
            let ib = int_part(b);
            let fb = &b[ib.len()..];
            if ib == smallest_int() {
                // 整数轴已到底:钻 b 的小数段。
                return Ok(format!("{ib}{}", midpoint("", Some(fb))));
            }
            if !fb.is_empty() {
                // b 带小数段:其整数段本身就严格小于 b。
                return Ok(ib.to_string());
            }
            match decrement_int(ib) {
                // 减出保留键(最小整数段裸键)时给它续一枚小数段中点——参考实现在这里
                // 会返回保留键、下一次前插才报废,我们把这步补齐(仍 < b:整数段更小)。
                Some(i) if i == smallest_int() => Ok(format!("{i}{}", midpoint("", None))),
                Some(i) => Ok(i),
                None => Err(unreachable_state(b)), // ib ≠ 最小整数段,减一必有解
            }
        }
        (Some(a), None) => {
            let ia = int_part(a);
            let fa = &a[ia.len()..];
            match increment_int(ia) {
                Some(i) => Ok(i),
                None => Ok(format!("{ia}{}", midpoint(fa, None))),
            }
        }
        (Some(a), Some(b)) => {
            let ia = int_part(a);
            let fa = &a[ia.len()..];
            let ib = int_part(b);
            let fb = &b[ib.len()..];
            if ia == ib {
                return Ok(format!("{ia}{}", midpoint(fa, Some(fb))));
            }
            let i = increment_int(ia).ok_or_else(|| unreachable_state(a))?;
            if i.as_str() < b {
                Ok(i)
            } else {
                Ok(format!("{ia}{}", midpoint(fa, None)))
            }
        }
    }
}

/// 数学上不可达的分支(validate 已拦下最小整数段;最大整数段之上不存在更大的整数段)。
/// 走到这里只可能是本模块自身的 bug,报错而非 panic 是给编排层留一条撤退路。
fn unreachable_state(key: &str) -> String {
    format!("排序键计算进入不可达分支(必是 frindex bug):{key:?}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 速记:两个 &str 之间取键并断言严格序 + 规范形态。
    fn between(a: Option<&str>, b: Option<&str>) -> String {
        let k = key_between(a, b).expect("key_between");
        validate(&k).expect("生成的键必须合规");
        if let Some(a) = a {
            assert!(a < k.as_str(), "{a:?} < {k:?} 不成立");
        }
        if let Some(b) = b {
            assert!(k.as_str() < b, "{k:?} < {b:?} 不成立");
        }
        k
    }

    #[test]
    fn first_key_and_known_values_match_the_reference_algorithm() {
        assert_eq!(between(None, None), "a0");
        assert_eq!(between(Some("a0"), None), "a1");
        assert_eq!(between(None, Some("a0")), "Zz");
        assert_eq!(between(Some("a0"), Some("a1")), "a0V");
        assert_eq!(between(Some("a0"), Some("a0V")), "a0G");
        assert_eq!(between(Some("a0V"), Some("a1")), "a0l");
        // 整数段长度升降级。
        assert_eq!(between(Some("az"), None), "b00");
        assert_eq!(between(Some("b00"), None), "b01");
        assert_eq!(between(None, Some("Z0")), "Yzz");
        // 跨零:最大负数 +1 = 最小正数。
        assert_eq!(increment_int("Zz"), Some("a0".to_string()));
        assert_eq!(decrement_int("a0"), Some("Zz".to_string()));
    }

    #[test]
    fn sequential_appends_grow_logarithmically_not_linearly() {
        // 列尾追加 200 次(新任务/流转落列尾的主路径):键长走整数轴,应保持很短。
        let mut last = between(None, None);
        for _ in 0..200 {
            last = between(Some(&last), None);
        }
        assert!(last.len() <= 3, "200 次追加后键仍应是整数段短键,实得 {last:?}");
    }

    #[test]
    fn sequential_prepends_stay_short_too() {
        let mut first = between(None, None);
        for _ in 0..200 {
            first = between(None, Some(&first));
        }
        assert!(first.len() <= 3, "200 次前插后键仍应是整数段短键,实得 {first:?}");
    }

    #[test]
    fn dense_middle_inserts_keep_strict_order() {
        // 反复往同一个空隙里插(最坏情况):每次都必须仍然严格有序、全部合规。
        let mut lo = between(None, None);
        let hi = between(Some(&lo), None);
        for _ in 0..100 {
            lo = between(Some(&lo), Some(&hi));
        }
        // 混合方向:模拟一列卡在首、尾、中间的持续插入。
        let mut keys = vec![between(None, None)];
        for i in 0..120 {
            let k = match i % 3 {
                0 => between(None, Some(&keys[0])),
                1 => between(Some(keys.last().expect("非空")), None),
                _ => {
                    let mid = keys.len() / 2;
                    between(Some(&keys[mid - 1]), Some(&keys[mid]))
                }
            };
            match i % 3 {
                0 => keys.insert(0, k),
                1 => keys.push(k),
                _ => keys.insert(keys.len() / 2, k),
            }
            let mut sorted = keys.clone();
            sorted.sort();
            assert_eq!(keys, sorted, "第 {i} 次插入后失序");
        }
    }

    #[test]
    fn rejects_malformed_keys_and_inverted_bounds() {
        // 非法键:空、头字符非字母、整数段不完整、小数段尾随 '0'、表外字符、保留键。
        let smallest = smallest_int();
        for bad in ["", "0a", "a", "b0", "a00", "a0-", "a0 ", smallest.as_str()] {
            assert!(validate(bad).is_err(), "{bad:?} 应判不合规");
            assert!(key_between(Some(bad), None).is_err());
            assert!(key_between(None, Some(bad)).is_err());
        }
        // a >= b 拒绝。
        assert!(key_between(Some("a1"), Some("a0")).is_err());
        assert!(key_between(Some("a0"), Some("a0")).is_err());
    }

    #[test]
    fn before_smallest_integer_dives_into_its_fraction() {
        // 一路前插到最小整数段附近,仍必须有解(钻小数段),永不枯竭。
        let mut first = format!("A{}1", "0".repeat(25));
        validate(&first).expect("最小整数段 +1 是合法键");
        for _ in 0..40 {
            first = between(None, Some(&first));
        }
    }
}

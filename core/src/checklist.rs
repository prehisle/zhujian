//! 「这次改正文,是不是只勾了/取消了几个方框?」—— 编辑历史归档的豁免判据(用户面 63)。
//!
//! **由头**:561 起正文行首 `- [ ] ` 画成可点的方框,而点一下 = **整条正文写回** ⇒ 0014 那只
//! `trg_item_archive_on_edit` 照常把旧文归进 `item_revisions`。一个 8 项的清单从头勾到尾就是
//! 8 条只差一个 `x` 的历史版本,而历史**用户在卡片上看得见**。
//!
//! **判据刻意不放在 op 类型上,放在文本比对上**(用户当面拍的形):写入前算一句「旧文本 →
//! 新文本 是不是纯勾选变更」,是就在本事务内立起豁免旗、让那只触发器跳过这一次。
//! ⭐ **同步 op 一个字不改** —— 发出去的仍是普通的 content `set_field`,旧版本客户端收到照常
//! 应用(只是它自己那边会多归档一条)⇒ **混版零风险**。
//!
//! ⚠⚠ **这是那条判据在仓里的第三份实现,而且是跨语言的**(前两份 = `src/checklist.ts` 与
//! `android/src/checklist.ts`,由 `check-filter-parity` 逐字对拍)。**那道闸切的是 TS 源码,
//! 核不到这一份** —— 别指望它替这里把关。为此这一份刻意**只要求「不比前端那两份宽」**,
//! 不追求逐字等价:
//!
//! - **窄了**(前端认作待办项、这里不认)⇒ 那次勾选照常多存一版历史 = **退化成今天的行为**,无害。
//! - **宽了**(前端不认、这里认了)⇒ **吞掉一次真实的编辑历史**,而历史是「原文永不被覆盖
//!   而不留历史」那条设计铁律的载体 ⇒ 这是唯一有害的方向。
//!
//! 所以每一处拿不准都往**窄**里写(例:行尾那个空白只认 ASCII 空白,而 JS 的 `\s` 还认一批
//! unicode 空白 —— ASCII 是它的子集,故这里认的行前端必然也认)。⛔ **改这份时别顺手「对齐
//! 前端」把它放宽**,先问清楚放宽的那一格会不会吞掉真编辑。

/// 这一行是不是待办项?是就返回方括号里那个字符的**字节下标**。
///
/// 与前端 `LINE_RE`(`/^([ \t]*)- \[([ xX])\](|\s.*)$/`)同形而更窄:行首缩进只认空格与
/// 制表符、`- ` 之后恰好是 `[` + 一个 ` `/`x`/`X` + `]`、方括号之后必须是行尾或**一个 ASCII
/// 空白**(⛔ 不认 unicode 空白 —— 那是刻意留的窄边)。
fn checklist_mark_pos(line: &str) -> Option<usize> {
    let b = line.as_bytes();
    let mut i = 0;
    while i < b.len() && (b[i] == b' ' || b[i] == b'\t') {
        i += 1;
    }
    // `- [` + 标记 + `]`
    if b.len() < i + 5 || b[i] != b'-' || b[i + 1] != b' ' || b[i + 2] != b'[' || b[i + 4] != b']' {
        return None;
    }
    let mark = b[i + 3];
    if mark != b' ' && mark != b'x' && mark != b'X' {
        return None;
    }
    // 方括号之后:行尾,或一个 ASCII 空白(⛔ 别放宽成「任意字符」——`- [x]abc` 是一句
    // 普通的话,前端不给它画方框,这里也就不许拿它当勾选)。
    match b.get(i + 5) {
        None => Some(i + 3),
        Some(c) if c.is_ascii_whitespace() => Some(i + 3),
        Some(_) => None,
    }
}

/// 旧文本 → 新文本 是不是**纯勾选变更**?
///
/// 判据(三条全中才算):①行数相同;②每一行要么逐字相同,要么**只有方括号里那一个字符**
/// 不同、且那一对是 ` ` ↔ `x`/`X`;③至少有一行真的翻了。
///
/// ⛔ **别放宽**:`- [x]` → `- [X]`(只换大小写)、行尾多打一个空格、插入一行 —— 这些都
/// 判 `false`,那次编辑照常进历史。判 `false` 的代价只是「多存一版」,判 `true` 判错则是
/// **永久少一版用户看得见的历史**。
pub(crate) fn is_checklist_toggle_only(before: &str, after: &str) -> bool {
    let old: Vec<&str> = before.split('\n').collect();
    let new: Vec<&str> = after.split('\n').collect();
    if old.len() != new.len() {
        return false;
    }
    let mut toggled = 0usize;
    for (x, y) in old.iter().zip(new.iter()) {
        if x == y {
            continue;
        }
        // 长度必须相同 —— 标记恒一个字符,长度变了就不只是勾选(可能是同一行里改了字)。
        if x.len() != y.len() {
            return false;
        }
        let (Some(px), Some(py)) = (checklist_mark_pos(x), checklist_mark_pos(y)) else {
            return false;
        };
        if px != py {
            return false;
        }
        // 除了那一个字符,整行必须逐字节相同(缩进、标记后那一截原文都不许动)。
        let (bx, by) = (x.as_bytes(), y.as_bytes());
        if bx[..px] != by[..px] || bx[px + 1..] != by[px + 1..] {
            return false;
        }
        let checked = |c: u8| c == b'x' || c == b'X';
        let flipped = (bx[px] == b' ' && checked(by[px])) || (checked(bx[px]) && by[px] == b' ');
        if !flipped {
            return false;
        }
        toggled += 1;
    }
    toggled > 0
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- 认行:与前端那两份同形而更窄 ----------------------------------------
    #[test]
    fn mark_pos_accepts_the_canonical_shapes() {
        assert_eq!(checklist_mark_pos("- [ ] 买菜"), Some(3));
        assert_eq!(checklist_mark_pos("- [x] 买菜"), Some(3));
        assert_eq!(checklist_mark_pos("- [X] 买菜"), Some(3), "大写 X 也是待办项(markdown 两种写法都有)");
        assert_eq!(checklist_mark_pos("  - [ ] 买菜"), Some(5), "缩进随意");
        assert_eq!(checklist_mark_pos("\t- [x] 买菜"), Some(4), "制表符缩进");
        assert_eq!(checklist_mark_pos("- [ ]"), Some(3), "标记后什么都没有也算");
    }

    #[test]
    fn mark_pos_rejects_everything_else() {
        assert_eq!(checklist_mark_pos("- 买菜"), None, "⭐ 裸 `- 文字` 不是待办项");
        assert_eq!(checklist_mark_pos("- [x]买菜"), None, "方括号后必须是行尾或空白");
        assert_eq!(checklist_mark_pos("-[ ] 买菜"), None, "`-` 与 `[` 之间恰一个空格");
        assert_eq!(checklist_mark_pos("-  [ ] 买菜"), None, "两个空格不算");
        assert_eq!(checklist_mark_pos("* [ ] 买菜"), None, "只认 `-`");
        assert_eq!(checklist_mark_pos("- [o] 买菜"), None, "方框里别的字符不算");
        assert_eq!(checklist_mark_pos("- [xx] 买菜"), None, "方框里只许一个字符");
        assert_eq!(checklist_mark_pos("先说一句 - [ ] 买菜"), None, "整行必须从标记起头");
        assert_eq!(checklist_mark_pos(""), None);
        // ⭐ 刻意留的窄边:unicode 空白(全角空格)不认 —— 前端的 `\s` 认它,这里不认
        // ⇒ 这一格是「窄了」的方向,代价只是多存一版历史。
        assert_eq!(checklist_mark_pos("- [ ]\u{3000}买菜"), None, "全角空格不认(刻意的窄边)");
    }

    // ---- 纯勾选变更:该豁免的 ------------------------------------------------
    #[test]
    fn a_single_box_flip_is_toggle_only() {
        assert!(is_checklist_toggle_only("- [ ] 买菜", "- [x] 买菜"));
        assert!(is_checklist_toggle_only("- [x] 买菜", "- [ ] 买菜"), "取消勾选同样算");
        assert!(is_checklist_toggle_only("- [ ] 买菜", "- [X] 买菜"), "翻成大写 X 也是勾上");
    }

    #[test]
    fn flipping_one_line_among_many_is_toggle_only() {
        let before = "抬头\n- [ ] 甲\n- [x] 乙\n- 丙不是待办项\n落款";
        let after = "抬头\n- [x] 甲\n- [x] 乙\n- 丙不是待办项\n落款";
        assert!(is_checklist_toggle_only(before, after));
    }

    #[test]
    fn flipping_several_lines_at_once_is_still_toggle_only() {
        // 一次写回带多行差异(远端合并、或用户手打改了两个勾)——语义上仍是「只有勾变了」。
        assert!(is_checklist_toggle_only("- [ ] 甲\n- [ ] 乙", "- [x] 甲\n- [x] 乙"));
    }

    #[test]
    fn indented_items_keep_their_indent() {
        assert!(is_checklist_toggle_only("  - [ ] 甲", "  - [x] 甲"));
        assert!(is_checklist_toggle_only("\t- [x] 甲", "\t- [ ] 甲"));
    }

    // ---- 不是纯勾选的:一律进历史(⭐ 承重,判错这边就吞掉真编辑)-------------
    #[test]
    fn editing_the_text_of_a_checklist_item_is_a_real_edit() {
        assert!(!is_checklist_toggle_only("- [ ] 买菜", "- [ ] 买肉"));
        assert!(
            !is_checklist_toggle_only("- [ ] 买菜", "- [x] 买肉"),
            "⭐ 同一行既翻了勾又改了字 —— 那是真编辑,别因为勾也变了就放过它"
        );
    }

    #[test]
    fn adding_or_removing_a_line_is_a_real_edit() {
        assert!(!is_checklist_toggle_only("- [ ] 甲", "- [ ] 甲\n- [ ] 乙"));
        assert!(!is_checklist_toggle_only("- [ ] 甲\n- [ ] 乙", "- [ ] 甲"));
        assert!(!is_checklist_toggle_only("- [ ] 甲", "- [x] 甲\n"), "末尾多一个空行也是改了行数");
    }

    #[test]
    fn touching_anything_outside_the_box_is_a_real_edit() {
        assert!(!is_checklist_toggle_only("- [ ] 甲", " - [x] 甲"), "缩进变了");
        assert!(!is_checklist_toggle_only("- [ ] 甲", "- [x] 甲 "), "行尾多一个空格");
        assert!(!is_checklist_toggle_only("抬头\n- [ ] 甲", "抬头改\n- [x] 甲"), "别的行也动了");
    }

    #[test]
    fn case_only_change_of_the_mark_is_a_real_edit() {
        // `x` → `X` 勾没变(两边都是勾上),那就是用户在改字 —— 照常进历史。⛔ 别顺手放行。
        assert!(!is_checklist_toggle_only("- [x] 甲", "- [X] 甲"));
    }

    #[test]
    fn a_line_the_front_end_would_not_draw_a_box_for_is_a_real_edit() {
        // ⭐ 承重:`- [x]abc` 前端不给它画方框(方括号后必须是行尾或空白)⇒ 这里也绝不许
        // 拿它当勾选。放宽这一格 = 用户手打把 `[ ]` 改成 `[x]` 的那次编辑被静默吞掉。
        assert!(!is_checklist_toggle_only("- [ ]abc", "- [x]abc"));
        assert!(!is_checklist_toggle_only("-[ ] abc", "-[x] abc"));
        assert!(!is_checklist_toggle_only("* [ ] abc", "* [x] abc"));
    }

    #[test]
    fn no_change_at_all_is_not_a_toggle() {
        // 触发器的 WHEN 里已经有 `NEW.content <> OLD.content`,走不到这儿;答 false 是安全方向。
        assert!(!is_checklist_toggle_only("- [ ] 甲", "- [ ] 甲"));
        assert!(!is_checklist_toggle_only("", ""));
    }

    #[test]
    fn plain_prose_edits_are_untouched() {
        assert!(!is_checklist_toggle_only("随手记一笔", "随手记两笔"));
        assert!(!is_checklist_toggle_only("- 买菜", "- 买肉"), "裸 `- 文字` 是普通列表");
    }

    #[test]
    fn multibyte_text_does_not_panic_or_misjudge() {
        // 切片用的是字节下标,而中文是多字节 —— 边界要落在标记那个 ASCII 字符上,
        // 前后两段按字节比较(不解码),既不 panic 也不误判。
        assert!(is_checklist_toggle_only("- [ ] 甲乙丙丁", "- [x] 甲乙丙丁"));
        assert!(!is_checklist_toggle_only("- [ ] 甲乙丙丁", "- [x] 甲乙丙戊"));
    }
}

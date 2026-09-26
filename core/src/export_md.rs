//! 「导出为 Markdown」的落盘半(用户面 136)。
//!
//! Markdown 正文**不在这里写** —— 它由桌面前端 `src/export-md.ts` 排好,与「复制随记」共用
//! 同一份写法(一种格式,两个出口:复制 = 当前筛出的那批、纯文字;导出 = 全量、带图、落文件)。
//! 这里只管两件前端做不了的事:
//! - 配图**字节不过前端**:调用方给 `image_id → 相对路径`,字节由 `fetch` 逐张现取(壳层让每张
//!   各拿一次库锁,几十 MB 的图不会一口气把同步与界面锁住)。
//! - **要么整份在、要么什么都不留**:先写进同级的隐藏临时目录,全部写完才改名成正式名字;
//!   中途任何一步失败就把临时目录删掉、原话报错(⛔ 不留半截文件夹让用户误当成一份完整导出)。
//!
//! ⛔ 相对路径是前端给的,一律当不可信输入核:只许「普通名字 + `/`」,`..`、绝对路径、
//! 盘符、反斜杠、Windows 保留字符都拒 —— 否则一个写错的名字就能写到导出目录外面去。
use std::path::{Path, PathBuf};

/// 一份文本文件(如 `随记.md`)。`rel` 是导出目录内的相对路径,`/` 分隔。
pub struct Doc {
    pub rel: String,
    pub text: String,
}

/// 一张配图:库里的 `image_id` 写到导出目录内的 `rel`。
pub struct Image {
    pub image_id: String,
    pub rel: String,
}

/// 同名文件夹已存在时往后顺延的上限(`名字 (2)` … `名字 (99)`)。一分钟里点一百次才会撞到。
const MAX_SUFFIX: u32 = 99;

/// 在 `parent` 下建出 `folder`(已存在就顺延成 `folder (2)` …),写入全部文件,返回最终路径。
/// 失败时 `parent` 下不留任何东西。
pub fn write_folder(
    parent: &Path,
    folder: &str,
    docs: &[Doc],
    images: &[Image],
    mut fetch: impl FnMut(&str) -> Result<Vec<u8>, String>,
) -> Result<PathBuf, String> {
    check_component(folder).map_err(|e| format!("导出文件夹名不合法({folder}):{e}"))?;
    let mut seen = std::collections::HashSet::new();
    for rel in docs.iter().map(|d| &d.rel).chain(images.iter().map(|i| &i.rel)) {
        check_rel(rel).map_err(|e| format!("导出文件名不合法({rel}):{e}"))?;
        if !seen.insert(rel.to_lowercase()) {
            // 按小写比:Windows / macOS 的文件系统不分大小写,两个只差大小写的名字会互相覆盖。
            return Err(format!("导出文件名重复:{rel}"));
        }
    }
    if !parent.is_dir() {
        return Err(format!("导出位置不存在:{}", parent.display()));
    }

    let dest = free_name(parent, folder)?;
    let tmp = parent.join(format!(".{folder}.part-{}", std::process::id()));
    if tmp.exists() {
        // 同一进程上一趟崩在中途留下的(正常失败路径会自己删)。它只可能是本功能写的。
        std::fs::remove_dir_all(&tmp).map_err(|e| format!("清不掉上次没写完的 {}:{e}", tmp.display()))?;
    }
    std::fs::create_dir(&tmp).map_err(|e| format!("建不出 {}:{e}", tmp.display()))?;

    let written = (|| -> Result<(), String> {
        for d in docs {
            write_file(&tmp, &d.rel, d.text.as_bytes())?;
        }
        for im in images {
            let bytes = fetch(&im.image_id)?;
            write_file(&tmp, &im.rel, &bytes)?;
        }
        std::fs::rename(&tmp, &dest).map_err(|e| format!("改名成 {} 失败:{e}", dest.display()))
    })();
    if let Err(e) = written {
        if let Err(clean) = std::fs::remove_dir_all(&tmp) {
            return Err(format!("{e}(临时目录 {} 也没删掉:{clean})", tmp.display()));
        }
        return Err(e);
    }
    Ok(dest)
}

fn free_name(parent: &Path, folder: &str) -> Result<PathBuf, String> {
    let first = parent.join(folder);
    if !first.exists() {
        return Ok(first);
    }
    for n in 2..=MAX_SUFFIX {
        let p = parent.join(format!("{folder} ({n})"));
        if !p.exists() {
            return Ok(p);
        }
    }
    Err(format!("{} 下同名的导出文件夹太多了,先挪走几个", parent.display()))
}

fn write_file(root: &Path, rel: &str, bytes: &[u8]) -> Result<(), String> {
    let path = rel.split('/').fold(root.to_path_buf(), |p, c| p.join(c));
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("建不出 {}:{e}", dir.display()))?;
    }
    std::fs::write(&path, bytes).map_err(|e| format!("写不进 {}:{e}", path.display()))
}

fn check_rel(rel: &str) -> Result<(), String> {
    if rel.is_empty() {
        return Err("空".into());
    }
    rel.split('/').try_for_each(check_component)
}

/// 一段路径名:非空、不是 `.` / `..`、不含分隔符与 Windows 保留字符、不以空格或点结尾
/// (Windows 会悄悄把结尾的点和空格吃掉,写出去的名字与链接里的对不上)。
fn check_component(c: &str) -> Result<(), String> {
    if c.is_empty() || c == "." || c == ".." {
        return Err("路径段为空或是 . / ..".into());
    }
    if let Some(bad) = c.chars().find(|ch| matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || ch.is_control()) {
        return Err(format!("含不许用的字符 {bad:?}"));
    }
    if c.ends_with(' ') || c.ends_with('.') {
        return Err("以空格或点结尾".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh(name: &str) -> PathBuf {
        let d = crate::test_temp::dir().join(format!("export-md-{name}"));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn doc(rel: &str, text: &str) -> Doc {
        Doc { rel: rel.into(), text: text.into() }
    }
    fn img(id: &str, rel: &str) -> Image {
        Image { image_id: id.into(), rel: rel.into() }
    }
    fn entries(d: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(d).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    #[test]
    fn writes_docs_and_images_into_named_folder() {
        let p = fresh("ok");
        let out = write_folder(
            &p,
            "朱简导出 2026-09-26 2130",
            &[doc("随记.md", "# 随记\n"), doc("看板.md", "# 看板\n")],
            &[img("a", "图/2026-09-24-2210-ABCD-图1.png")],
            |id| Ok(format!("bytes-of-{id}").into_bytes()),
        )
        .unwrap();
        assert_eq!(out, p.join("朱简导出 2026-09-26 2130"));
        assert_eq!(std::fs::read_to_string(out.join("随记.md")).unwrap(), "# 随记\n");
        assert_eq!(std::fs::read(out.join("图").join("2026-09-24-2210-ABCD-图1.png")).unwrap(), b"bytes-of-a");
        assert_eq!(entries(&p), vec!["朱简导出 2026-09-26 2130"], "临时目录必须已改名走,不留别的东西");
    }

    #[test]
    fn existing_folder_gets_a_numbered_sibling_and_is_left_untouched() {
        let p = fresh("dup");
        std::fs::create_dir(p.join("导出")).unwrap();
        std::fs::write(p.join("导出").join("旧.md"), "old").unwrap();
        let out = write_folder(&p, "导出", &[doc("a.md", "new")], &[], |_| unreachable!()).unwrap();
        assert_eq!(out, p.join("导出 (2)"));
        assert_eq!(entries(&p.join("导出")), vec!["旧.md"]);
    }

    #[test]
    fn failed_fetch_leaves_nothing_behind() {
        let p = fresh("fail");
        let err = write_folder(&p, "导出", &[doc("a.md", "x")], &[img("gone", "图/1.png")], |_| Err("图片不存在".into()))
            .unwrap_err();
        assert!(err.contains("图片不存在"), "{err}");
        assert!(entries(&p).is_empty(), "失败后还留着:{:?}", entries(&p));
    }

    #[test]
    fn rejects_unsafe_names_before_touching_disk() {
        let p = fresh("bad");
        for rel in ["../逃出去.md", "a/../b.md", "C:x.md", "a\\b.md", "/abs.md", "", "a//b.md", "尾巴.", "a?.md"] {
            let r = write_folder(&p, "导出", &[doc(rel, "x")], &[], |_| unreachable!());
            assert!(r.is_err(), "{rel:?} 应被拒");
        }
        for folder in ["..", "a/b", "a\\b", ""] {
            assert!(write_folder(&p, folder, &[doc("a.md", "x")], &[], |_| unreachable!()).is_err(), "{folder:?} 应被拒");
        }
        assert!(entries(&p).is_empty(), "拒掉的请求不许在盘上留东西:{:?}", entries(&p));
    }

    #[test]
    fn rejects_case_insensitive_duplicates() {
        let p = fresh("case");
        let r = write_folder(&p, "导出", &[doc("A.md", "1"), doc("a.md", "2")], &[], |_| unreachable!());
        assert!(r.unwrap_err().contains("重复"));
        assert!(entries(&p).is_empty());
    }
}

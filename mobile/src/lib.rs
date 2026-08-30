//! 朱简两只手机壳(安卓 / 鸿蒙)共用的壳层。整份说明在 [`shell`] 的头注。
//!
//! # ⭐ 为什么命令面住在子模块里,而不是直接摊在这个文件上
//!
//! **这是 D1 抽取时当场撞出来的,不是排版口味**:`#[tauri::command]` 只在函数是 `pub`
//! 时给包装宏加 `#[macro_export]`,而 `#[macro_export]` 的宏**一律落在 crate 根**;
//! 同时宏展开末尾还有一句 `pub use {__cmd__x, __tauri_command_name_x};`。两者都在根 ⇒
//! **自己与自己撞名**,94 条命令一次报 188 个 `E0255`:
//!
//! ```text
//! error[E0255]: the name `__cmd__capture_idea` is defined multiple times
//!   = note: `__cmd__capture_idea` must be defined only once in the macro namespace of this module
//! ```
//!
//! ⚠ 它在安卓那份里**永远不会出现** —— 那边命令全是私有 `fn`,压根不发 `#[macro_export]`。
//! ⇒ 命令沉进 [`shell`],根这里只做 glob 再导出。于是两条路径**同时**成立,壳那边照常写
//! `zhujian_mobile::capture_idea`:函数来自下面这句 `pub use`,包装宏来自 `#[macro_export]`
//! 落在根上的那一份。⛔ 别把 [`shell`] 的内容搬回这个文件。

pub mod coord;
pub mod shell;
// 测试容器目录(per-pid,progress-log 326);测试之外无人调用。
#[cfg(test)]
mod test_temp;

pub use shell::*;

/// **两只手机壳共用的那份命令清单**(D1 抽取时立)。
///
/// ⭐ **为什么它是一个宏而不是「各壳各抄一份」**:清单抄两份,漂移的表现是
/// **命令编得过、真机上找不到** —— 前端一句 `invoke("xxx")` 返回
/// `Command xxx not found`,而 Rust 侧、TS 侧、门禁侧**没有任何一处会红**。
/// 这正是「不报错、只给一个别的答案」那一族。⇒ 清单只留这一份,壳那边只补自己的。
///
/// 用法(壳里):
/// ```ignore
/// .invoke_handler(zhujian_mobile::shared_handler![
///     take_shared_text,   // ← 壳自己那几条,写在后面
///     check_update,
/// ])
/// ```
///
/// ⚠ **`$crate::` 那个前缀是承重的**:命令函数由本 crate 根的 `pub use shell::*` 提供,
/// 而 `generate_handler!` 会把最后一段换成 `__cmd__<名字>` 去找包装宏 —— 那一份是
/// `#[macro_export]` 落在本 crate 根上的(见本文件头注)。两条路径必须同时指得对。
#[macro_export]
macro_rules! shared_handler {
    ($($extra:path),* $(,)?) => {
        ::tauri::generate_handler![
            $crate::startup_gate,
            $crate::list_spaces,
            $crate::create_space,
            $crate::rename_space,
            $crate::device_identity,
            $crate::set_device_alias,
            $crate::rescan_spaces,
            $crate::activate_space,
            $crate::foreground_space,
            $crate::reset_space,
            $crate::move_item_to_space,
            $crate::sync_all_spaces,
            $crate::capture_idea,
            $crate::capture_todo,
            $crate::list_timeline,
            $crate::get_item_image,
            $crate::get_item_thumb,
            $crate::put_item_thumb,
            $crate::complete_task,
            // 119 全功能底座:灵感
            $crate::list_ideas,
            $crate::list_archived,
            $crate::idea_stats,
            $crate::search_notes,
            $crate::edit_note,
            $crate::list_note_history,
            $crate::archive_note,
            $crate::restore_note,
            $crate::purge_note,
            $crate::purge_archived,
            $crate::promote_note_to_task,
            $crate::revert_task_to_inbox,
            $crate::file_note_to_topic,
            $crate::remove_note_topic,
            // 119 全功能底座:任务
            $crate::list_board_columns,
            $crate::list_tasks,
            $crate::list_archived_tasks,
            $crate::list_sealed_tasks,
            $crate::pane_counts,
            $crate::create_task,
            $crate::rename_task,
            $crate::update_task_status,
            $crate::reorder_task,
            $crate::reorder_task_visible,
            $crate::set_task_due,
            $crate::set_task_priority,
            $crate::add_task_topic,
            $crate::remove_task_topic,
            $crate::archive_task,
            $crate::restore_task,
            $crate::purge_task,
            $crate::purge_archived_tasks,
            $crate::seal_task,
            $crate::seal_done_tasks,
            $crate::unseal_task,
            // 119 全功能底座:标签
            $crate::list_topics,
            $crate::list_topic_tree,
            $crate::list_topics_full,
            $crate::create_topic,
            $crate::update_topic,
            $crate::set_topic_color,
            $crate::delete_topic,
            $crate::merge_topics,
            $crate::reorder_topic,
            $crate::set_topic_kind,
            // 119 全功能底座:配图
            $crate::add_item_image,
            $crate::list_item_images,
            $crate::delete_item_image,
            // 314 第②笔:条目留言命令面(UI 在第③笔,契约与桌面同源)
            $crate::add_item_comment,
            $crate::delete_item_comment,
            $crate::list_item_comments,
            $crate::item_comment_counts,
            $crate::mark_item_comments_seen,
            // 120 UI 第一批的 core 加菜
            $crate::list_trash,
            $crate::purge_all_trash,
            $crate::add_task_topic_by_title,
            $crate::find_space_by_account,
            $crate::sync_status,
            $crate::sync_create_account,
            $crate::sync_pair_start,
            $crate::sync_device_admin,
            $crate::sync_roster_refresh,
            $crate::sync_pair_join,
            $crate::join_space,
            $crate::join_space_cancel,
            $crate::sync_set_server,
            $crate::sync_recovery_code,
            $crate::db_info,
            $crate::net_probe,
            // 加密备份的安卓半(backup-plan §17):⛔ 没有 set_dir / open_dir / 自动那几条
            $crate::backup_status,
            $crate::backup_begin_setup,
            $crate::backup_confirm_setup,
            $crate::backup_cancel_setup,
            $crate::backup_run,
            $crate::backup_verify,
            $crate::backup_retry_cleanup,
            $($extra),*
        ]
    };
}

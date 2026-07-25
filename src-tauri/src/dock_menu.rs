// macOS Dock 右键菜单(macos-port-plan §2 的 b)。右键 Dock 上的「朱」图标,在系统
// 默认项(Options / Show All Windows / Hide / Quit)之上多出「记录灵感 / 打开朱简」
// 两项,点了路由回壳里现成的 show_window / open_notebook——与托盘菜单、全局热键同
// 三条入口共用同一段逻辑,不另起一份。(a = 左键点 Dock 开主窗,已由 lib.rs run()
// 里的 RunEvent::Reopen 拿下;这里只补右键。)
//
// 为什么非写 objc 不可:macOS 只认 NSApplicationDelegate 的 `applicationDockMenu:`
// 这一条路(NSApplication 没有 dockMenu 属性),而 tao 0.35 / tauri 2.11 的 delegate
// 类(TaoAppDelegateParent)没实现也没转发这只回调。故只能在运行期把方法补进 tao 那
// 个类里,再让菜单项的 action 打回同一个 delegate 实例上。
//
// 整个模块 macOS 专属,lib.rs 侧以 #[cfg(target_os = "macos")] 挂载 + 调用,
// Windows/Linux 构建里根本不存在。

use std::ffi::CStr;
use std::sync::OnceLock;

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::sel;
use objc2_app_kit::{NSApplication, NSMenu};
use objc2_foundation::{MainThreadMarker, NSString};
use tauri::AppHandle;

use crate::{open_notebook, show_window};

/// 点菜单要拿 AppHandle 回 Tauri 侧,但 ObjC 方法是裸函数、带不了闭包捕获——故存
/// 静态。install 时写一次,之后只读。
static APP: OnceLock<AppHandle> = OnceLock::new();

/// Dock 菜单建一次、永久持有。AppKit 每次右键都调 `applicationDockMenu:` 取菜单,
/// 但该选择器不属于 retain 家族——调用方不接管所有权、也不会释放它。菜单是写死的
/// 两项、没有随状态重算的东西,与其每次重建再纠缠 autorelease,不如建一次留着。
struct DockMenu(Retained<NSMenu>);

// SAFETY: 只在主线程(setup)构建,只在主线程(AppKit 的 applicationDockMenu: 回调)
// 取裸指针;别的线程既拿不到它也不解引用它。NSMenu 本身是 MainThreadOnly,这层
// 包装的存在只为让它能躺在 static 里。
unsafe impl Send for DockMenu {}
unsafe impl Sync for DockMenu {}

static MENU: OnceLock<DockMenu> = OnceLock::new();

/// 补给 tao delegate 类的三只方法。签名必须与 ObjC 调用约定逐字对上
/// `(self, _cmd, sender)`,返回类型与下面 `install` 里给的类型编码一一对应。
/// 声明成 `extern "C-unwind"`(= objc2 的 `Imp`):万一 show_window 那边 panic,
/// 展开能穿回来,而不是在 extern "C" 边界上直接 abort 掉线索。
extern "C-unwind" fn application_dock_menu(
    _this: &AnyObject,
    _cmd: Sel,
    _sender: &AnyObject,
) -> *mut NSMenu {
    let menu = MENU.get().expect("Dock 菜单应在 install 时已建好");
    // 返回不带所有权的裸指针:见 DockMenu 上的说明,我们这边永久持有,悬垂不了。
    (&*menu.0 as *const NSMenu).cast_mut()
}

extern "C-unwind" fn dock_capture(_this: &AnyObject, _cmd: Sel, _sender: *mut AnyObject) {
    show_window(app_handle(), "capture");
}

extern "C-unwind" fn dock_notebook(_this: &AnyObject, _cmd: Sel, _sender: *mut AnyObject) {
    open_notebook(app_handle());
}

fn app_handle() -> &'static AppHandle {
    APP.get().expect("点 Dock 菜单时 AppHandle 应已就位")
}

/// `class_addMethod` 的薄封装:失败就响亮 panic。静默失手的表现是「右键 Dock 什么
/// 都没多出来」,不留任何线索——正是本项目 fail-fast 铁律要避免的那类哑巴失败。
///
/// # Safety
/// `imp` 必须是一只能按 ObjC 调用约定、以 `types` 描述的签名被调用的函数指针,且
/// `sel` 在 `class` 上尚未实现(否则只是加不上,不会盖掉既有实现)。
unsafe fn add_method(class: &AnyClass, sel: Sel, imp: *const (), types: &CStr) {
    // SAFETY: 调用方保证 imp 的签名与 types 相符;class 取自活的 delegate 实例。
    let added = unsafe {
        objc2::ffi::class_addMethod(
            (class as *const AnyClass).cast_mut(),
            sel,
            std::mem::transmute::<*const (), Imp>(imp),
            types.as_ptr(),
        )
    };
    assert!(
        added.as_bool(),
        "给 {} 补 {sel:?} 失败(选择器已存在?)——Dock 右键菜单装不上",
        class.name().to_string_lossy()
    );
}

/// 在 tauri `setup` 里调用一次(主线程,事件循环已建成 = delegate 已就位)。
pub fn install(app: &AppHandle) {
    let mtm = MainThreadMarker::new().expect("Dock 菜单须在主线程安装");
    APP.set(app.clone()).ok().expect("Dock 菜单只装一次");

    // delegate 类从活实例上取,不按名字 objc_getClass("TaoAppDelegateParent")——
    // tao 将来改类名也不至于静默查不到。
    let ns_app = NSApplication::sharedApplication(mtm);
    let delegate = ns_app
        .delegate()
        .expect("NSApplication delegate 应已由 tao 装好(setup 跑在事件循环建成之后)");
    let delegate_obj: &AnyObject = (&*delegate).as_ref();
    let class = delegate_obj.class();

    // SAFETY: 三只函数的签名与各自的类型编码逐字对应(`@`=id / `:`=SEL / `v`=void);
    // 三只选择器 tao 的 delegate 类都没实现(applicationDockMenu: 已 grep 确认;
    // zjDock* 是本项目私有前缀),加不上会在 add_method 里响亮 panic。
    unsafe {
        add_method(
            class,
            sel!(applicationDockMenu:),
            application_dock_menu as *const (),
            c"@@:@",
        );
        add_method(class, sel!(zjDockCapture:), dock_capture as *const (), c"v@:@");
        add_method(
            class,
            sel!(zjDockNotebook:),
            dock_notebook as *const (),
            c"v@:@",
        );
    }

    let menu = NSMenu::new(mtm);
    // 用词与托盘菜单完全一致(lib.rs setup 里的 "记录灵感" / "打开朱简"),两处入口
    // 同一件事就该同一个名字。不放「退出」——Dock 默认菜单自带 Quit。
    // 快捷键提示留空:Dock 菜单不显示 key equivalent,写了也只是噪音(热键本身由
    // global_shortcut 插件持有)。
    for (title, action) in [
        ("记录灵感", sel!(zjDockCapture:)),
        ("打开朱简", sel!(zjDockNotebook:)),
    ] {
        // SAFETY: action 就是上面刚补进 delegate 类的选择器,target 随即设成那个
        // delegate 实例——点击必有人接。
        let item = unsafe {
            menu.addItemWithTitle_action_keyEquivalent(
                &NSString::from_str(title),
                Some(action),
                &NSString::from_str(""),
            )
        };
        // SAFETY: delegate 由 NSApp 持有,活得比菜单长。
        unsafe { item.setTarget(Some(delegate_obj)) };
    }

    MENU.set(DockMenu(menu)).ok().expect("Dock 菜单只建一次");
}

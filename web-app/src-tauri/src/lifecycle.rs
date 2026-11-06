use objc2::{
    MainThreadMarker, msg_send,
    runtime::{AnyObject, ClassBuilder, Sel},
    sel,
};
use objc2_app_kit::{NSApplication, NSApplicationTerminateReply};
use std::sync::OnceLock;

static APPLICATION: OnceLock<tauri::AppHandle> = OnceLock::new();

extern "C-unwind" fn application_should_terminate(
    _: &AnyObject,
    _: Sel,
    _: *mut AnyObject,
) -> NSApplicationTerminateReply {
    if APPLICATION.get().is_some_and(crate::request_close) {
        NSApplicationTerminateReply::TerminateNow
    } else {
        NSApplicationTerminateReply::TerminateCancel
    }
}

pub fn install(app: &tauri::AppHandle) -> Result<(), String> {
    let main_thread =
        MainThreadMarker::new().ok_or("종료 보호는 메인 스레드에서 준비해야 합니다.")?;
    APPLICATION
        .set(app.clone())
        .map_err(|_| "종료 보호가 이미 준비됐습니다.")?;
    let application = NSApplication::sharedApplication(main_thread);
    // Tao owns this delegate for the event-loop lifetime. Its subclass inherits
    // every existing method and adds no ivars, preserving Tao's layout and drop.
    let delegate: *mut AnyObject = unsafe { msg_send![&application, delegate] };
    let delegate = unsafe { delegate.as_ref() }.ok_or("앱 종료 대리자가 없습니다.")?;
    let parent = delegate.class();
    if parent
        .instance_method(sel!(applicationShouldTerminate:))
        .is_some()
    {
        return Err("다른 앱 종료 보호가 이미 설정돼 있습니다.".into());
    }
    let mut builder = ClassBuilder::new(c"MyPaintTerminationDelegate", parent)
        .ok_or("앱 종료 보호 대리자를 만들지 못했습니다.")?;
    // AppKit declares this selector as (id, SEL, NSApplication*) -> NSUInteger.
    unsafe {
        builder.add_method(
            sel!(applicationShouldTerminate:),
            application_should_terminate as extern "C-unwind" fn(_, _, _) -> _,
        );
    }
    let guarded = builder.register();
    if parent.instance_size() != guarded.instance_size() {
        return Err("앱 종료 대리자의 메모리 구조가 일치하지 않습니다.".into());
    }
    // Synchronous setup runs on the main thread; no app code changes this
    // delegate's class concurrently. The ivar-free subclass is layout-compatible.
    let previous = unsafe { AnyObject::set_class(delegate, guarded) };
    if !std::ptr::eq(previous, parent) {
        return Err("앱 종료 대리자가 준비 중 변경됐습니다.".into());
    }
    Ok(())
}

pub fn terminate() {
    if let Some(main_thread) = MainThreadMarker::new() {
        let application = NSApplication::sharedApplication(main_thread);
        // Only our own NSApplication is targeted. The native delegate applies
        // the same approval gate as menu/Dock Quit before any termination occurs.
        application.terminate(None);
    }
}

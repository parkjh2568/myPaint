#[cfg(windows)]
mod windows {
    use std::{cell::Cell, mem::MaybeUninit};

    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        UI::{
            Input::Pointer::{GetPointerPenInfo, POINTER_PEN_INFO},
            Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
            WindowsAndMessaging::{
                GetMessageExtraInfo, GetMessageTime, PEN_MASK_PRESSURE, WM_LBUTTONDBLCLK,
                WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDBLCLK, WM_MBUTTONDOWN, WM_MBUTTONUP,
                WM_MOUSEMOVE, WM_NCDESTROY, WM_POINTERDOWN, WM_POINTERUP, WM_POINTERUPDATE,
                WM_RBUTTONDBLCLK, WM_RBUTTONDOWN, WM_RBUTTONUP,
            },
        },
    };

    #[derive(Clone, Copy)]
    struct Sample {
        window: HWND,
        time: u32,
        pressure: f64,
    }

    thread_local! {
        static LAST_PEN: Cell<Option<Sample>> = const { Cell::new(None) };
        static ACTIVE_PRESSURE: Cell<Option<f64>> = const { Cell::new(None) };
    }

    const SUBCLASS: usize = 1;

    fn is_promoted_pen(extra_info: u32) -> bool {
        const PEN_OR_TOUCH_SIGNATURE: u32 = 0xff51_5700;
        const SIGNATURE_AND_TOUCH_BIT: u32 = 0xffff_ff80;
        extra_info & SIGNATURE_AND_TOUCH_BIT == PEN_OR_TOUCH_SIGNATURE
    }

    pub fn register(window: &gpui::Window) -> bool {
        let Ok(handle) = HasWindowHandle::window_handle(window) else {
            return false;
        };
        let RawWindowHandle::Win32(handle) = handle.as_raw() else {
            return false;
        };
        // GPUI creates and owns this HWND on the UI thread calling this hook.
        unsafe { SetWindowSubclass(handle.hwnd.get() as HWND, Some(window_proc), SUBCLASS, 0) != 0 }
    }

    pub fn current_pressure() -> Option<f64> {
        ACTIVE_PRESSURE.get()
    }

    unsafe extern "system" fn window_proc(
        window: HWND,
        message: u32,
        word: WPARAM,
        argument: LPARAM,
        subclass: usize,
        _: usize,
    ) -> LRESULT {
        match message {
            WM_POINTERDOWN | WM_POINTERUPDATE | WM_POINTERUP => {
                let mut properties = MaybeUninit::<POINTER_PEN_INFO>::uninit();
                let pointer_id = (word & u16::MAX as usize) as u32;
                // Query during the pointer message. User32 can discard this packet after dispatch.
                if unsafe { GetPointerPenInfo(pointer_id, properties.as_mut_ptr()) } != 0 {
                    let properties = unsafe { properties.assume_init() };
                    let pressure = if properties.penMask & PEN_MASK_PRESSURE == 0 {
                        1.
                    } else {
                        f64::from(properties.pressure.min(1024)) / 1024.
                    };
                    LAST_PEN.set(Some(Sample {
                        window,
                        time: unsafe { GetMessageTime() } as u32,
                        pressure,
                    }));
                }
            }
            WM_MOUSEMOVE | WM_LBUTTONDOWN | WM_LBUTTONUP | WM_LBUTTONDBLCLK | WM_RBUTTONDOWN
            | WM_RBUTTONUP | WM_RBUTTONDBLCLK | WM_MBUTTONDOWN | WM_MBUTTONUP
            | WM_MBUTTONDBLCLK => {
                let extra_info = unsafe { GetMessageExtraInfo() } as u32;
                let pressure = if is_promoted_pen(extra_info) {
                    let time = unsafe { GetMessageTime() } as u32;
                    LAST_PEN
                        .get()
                        .filter(|sample| {
                            sample.window == window && time.wrapping_sub(sample.time) <= 100
                        })
                        .map(|sample| sample.pressure)
                } else {
                    None
                };
                // Restrict the pressure value to the matching Win32 mouse dispatch.
                let previous = ACTIVE_PRESSURE.replace(pressure);
                let result = unsafe { DefSubclassProc(window, message, word, argument) };
                ACTIVE_PRESSURE.set(previous);
                return result;
            }
            WM_NCDESTROY => {
                if LAST_PEN.get().is_some_and(|sample| sample.window == window) {
                    LAST_PEN.set(None);
                }
                unsafe { RemoveWindowSubclass(window, Some(window_proc), subclass) };
            }
            _ => {}
        }
        unsafe { DefSubclassProc(window, message, word, argument) }
    }

    #[cfg(test)]
    #[test]
    fn only_promoted_pen_messages_have_a_pen_signature() {
        assert!(is_promoted_pen(0xff51_5700));
        assert!(is_promoted_pen(0xff51_5743));
        assert!(!is_promoted_pen(0xff51_5780));
        assert!(!is_promoted_pen(0));
    }
}

#[cfg(windows)]
pub use windows::{current_pressure, register};

#[cfg(not(windows))]
pub fn register(_: &gpui::Window) -> bool {
    false
}

#[cfg(not(windows))]
pub fn current_pressure() -> Option<f64> {
    None
}

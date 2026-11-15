use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    mem::MaybeUninit,
    rc::Rc,
};

use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    Graphics::Gdi::ScreenToClient,
    UI::{
        Input::Pointer::{GetPointerInfo, POINTER_FLAG_CANCELED, POINTER_INFO},
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{
            GetSystemMetrics, NID_EXTERNAL_TOUCH, NID_INTEGRATED_TOUCH, NID_READY, PT_TOUCH,
            SM_DIGITIZER, WM_CANCELMODE, WM_KILLFOCUS, WM_NCDESTROY, WM_POINTERCAPTURECHANGED,
            WM_POINTERDOWN, WM_POINTERUP, WM_POINTERUPDATE,
        },
    },
};

use super::{NativeContact, Phase};

struct Registration {
    callback: RefCell<Box<dyn FnMut(NativeContact) -> bool>>,
    captured: RefCell<HashSet<u32>>,
    pending_cancellations: RefCell<Vec<NativeContact>>,
}

thread_local! {
    static WINDOWS: RefCell<HashMap<HWND, Rc<Registration>>> = RefCell::default();
}

const SUBCLASS: usize = 2;

pub fn touch_available() -> bool {
    let digitizer = unsafe { GetSystemMetrics(SM_DIGITIZER) } as u32;
    digitizer & NID_READY != 0 && digitizer & (NID_INTEGRATED_TOUCH | NID_EXTERNAL_TOUCH) != 0
}

pub fn register(
    window: &gpui::Window,
    callback: impl FnMut(NativeContact) -> bool + 'static,
) -> bool {
    let Ok(handle) = HasWindowHandle::window_handle(window) else {
        return false;
    };
    let RawWindowHandle::Win32(handle) = handle.as_raw() else {
        return false;
    };
    let handle = handle.hwnd.get() as HWND;

    // GPUI owns the HWND and invokes this hook on the window's UI thread.
    if unsafe { SetWindowSubclass(handle, Some(window_proc), SUBCLASS, 0) } == 0 {
        return false;
    }
    WINDOWS.with_borrow_mut(|windows| {
        windows.insert(
            handle,
            Rc::new(Registration {
                callback: RefCell::new(Box::new(callback)),
                captured: RefCell::default(),
                pending_cancellations: RefCell::default(),
            }),
        );
    });
    true
}

impl Registration {
    fn dispatch(&self, contact: NativeContact) -> bool {
        let Ok(mut callback) = self.callback.try_borrow_mut() else {
            if matches!(contact.phase, Phase::Cancel | Phase::CancelAll) {
                self.pending_cancellations.borrow_mut().push(contact);
            }
            return false;
        };
        let handled = callback(contact);
        loop {
            // Focus changes can synchronously reenter the HWND while GPUI is mutating
            // Studio. Deliver capture loss once that original callback has returned.
            let pending = std::mem::take(&mut *self.pending_cancellations.borrow_mut());
            if pending.is_empty() {
                break;
            }
            for cancellation in pending {
                callback(cancellation);
            }
        }
        handled
    }

    fn pointer(&self, window: HWND, id: u32, phase: Phase) -> bool {
        let captured = self.captured.borrow().contains(&id);
        if phase == Phase::Down {
            if captured {
                return true;
            }
            let Some(contact) = read_contact(window, id, phase) else {
                return false;
            };
            if contact.phase != Phase::Down {
                return false;
            }
            self.captured.borrow_mut().insert(id);
            if self.dispatch(contact) {
                return true;
            }
            self.captured.borrow_mut().remove(&id);
            return false;
        }
        if !captured {
            return false;
        }

        // Keep the captured sequence away from DefWindowProc's mouse promotion,
        // even when the editor has cancelled it and is ignoring further samples.
        if matches!(phase, Phase::Up | Phase::Cancel) {
            self.captured.borrow_mut().remove(&id);
        }
        let contact = if phase == Phase::Cancel {
            None
        } else {
            read_contact(window, id, phase)
        };
        self.dispatch(contact.unwrap_or_else(|| cancellation(id, Phase::Cancel)));
        true
    }
}

fn read_contact(window: HWND, id: u32, phase: Phase) -> Option<NativeContact> {
    let mut info = MaybeUninit::<POINTER_INFO>::uninit();
    // User32 data belongs to the pointer message currently being dispatched.
    if unsafe { GetPointerInfo(id, info.as_mut_ptr()) } == 0 {
        return None;
    }
    let info = unsafe { info.assume_init() };
    if info.pointerType != PT_TOUCH {
        return None;
    }
    if info.pointerFlags & POINTER_FLAG_CANCELED != 0 {
        return Some(cancellation(id, Phase::Cancel));
    }
    let mut position = info.ptPixelLocation;
    if unsafe { ScreenToClient(window, &mut position) } == 0 {
        return None;
    }
    Some(NativeContact {
        id,
        phase,
        x: position.x,
        y: position.y,
    })
}

fn cancellation(id: u32, phase: Phase) -> NativeContact {
    NativeContact {
        id,
        phase,
        x: 0,
        y: 0,
    }
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
        WM_POINTERDOWN
        | WM_POINTERUPDATE
        | WM_POINTERUP
        | WM_POINTERCAPTURECHANGED
        | WM_CANCELMODE
        | WM_KILLFOCUS => {
            if let Some(registration) = WINDOWS.with_borrow(|windows| windows.get(&window).cloned())
            {
                let phase = match message {
                    WM_POINTERDOWN => Phase::Down,
                    WM_POINTERUPDATE => Phase::Move,
                    WM_POINTERUP => Phase::Up,
                    WM_POINTERCAPTURECHANGED => Phase::Cancel,
                    _ => Phase::CancelAll,
                };
                if phase == Phase::CancelAll {
                    let has_capture = !registration.captured.borrow().is_empty();
                    if has_capture {
                        registration.dispatch(cancellation(0, phase));
                    }
                } else {
                    let id = (word & u16::MAX as usize) as u32;
                    if registration.pointer(window, id, phase) {
                        return 0;
                    }
                }
            }
        }
        WM_NCDESTROY => {
            WINDOWS.with_borrow_mut(|windows| windows.remove(&window));
            unsafe { RemoveWindowSubclass(window, Some(window_proc), subclass) };
        }
        _ => {}
    }
    unsafe { DefSubclassProc(window, message, word, argument) }
}

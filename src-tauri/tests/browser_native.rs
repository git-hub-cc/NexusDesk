#![cfg(windows)]

#[path = "../src/commands/browser_layout_state.rs"]
mod browser_layout_state;

#[test]
fn stale_layout_cannot_reshow_a_tab_or_replace_the_other_pane() {
    use browser_layout_state::{BrowserPane::*, BrowserWindow, LayoutChange::*};

    let mut window = BrowserWindow::default();
    assert!(matches!(
        window.layout(Left, "old", 1, true, true),
        Apply { .. }
    ));
    assert!(matches!(
        window.layout(Right, "right", 2, true, true),
        Apply { .. }
    ));
    let Apply { hide_previous } = window.layout(Left, "new", 5, true, true) else {
        panic!("new active browser did not claim the left pane");
    };
    assert_eq!(hide_previous.as_deref(), Some("old"));
    assert!(matches!(window.layout(Left, "old", 4, true, true), Stale));
    assert!(matches!(
        window.layout(Left, "old", 7, false, false),
        Apply {
            hide_previous: None
        }
    ));
    assert!(matches!(
        window.layout(Left, "new", 6, true, false),
        Apply { .. }
    ));
    assert!(matches!(window.layout(Left, "new", 5, true, true), Stale));
    assert!(window.owns_pane("right"));
    assert!(!window.owns_pane("old"));
    assert!(!window.owns_pane("new"));
    window.forget("right");
    assert!(!window.owns_pane("right"));
    assert!(window.fullscreen.is_none());
}

#[test]
fn late_cleanup_from_previous_tab_does_not_reject_new_active_tab() {
    use browser_layout_state::{BrowserPane::Left, BrowserWindow, LayoutChange::*};

    let mut window = BrowserWindow::default();
    assert!(matches!(
        window.layout(Left, "old", 1, true, true),
        Apply { .. }
    ));
    assert!(matches!(
        window.layout(Left, "old", 3, false, false),
        Apply {
            hide_previous: None
        }
    ));
    assert!(matches!(
        window.layout(Left, "new", 2, true, true),
        Apply {
            hide_previous: None
        }
    ));
    assert!(window.owns_pane("new"));
    assert!(!window.owns_pane("old"));
    assert!(matches!(window.layout(Left, "old", 2, true, true), Stale));
    assert!(window.owns_pane("new"));
}

mod browser_native {
    include!("../src/commands/browser_native.rs");
    #[cfg(test)]
    mod tests {
        use super::*;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            CWP_SKIPINVISIBLE, ChildWindowFromPointEx,
        };

        #[test]
        fn webview2_creation_failure_rolls_back_and_hidden_view_releases_its_area() {
            let profile = tempfile::tempdir().unwrap();
            let app = tauri::Builder::<tauri::Wry>::default()
                .any_thread()
                .build(tauri::generate_context!())
                .unwrap();
            let mut ran = false;
            let exit = app.run_return(move |app, event| {
                if ran || !matches!(event, tauri::RunEvent::Ready) {
                    return;
                }
                ran = true;
                let window = tauri::window::WindowBuilder::new(app, "browser-native-test")
                    .visible(false)
                    .build()
                    .unwrap();
                let parent = window.hwnd().unwrap().0 as HWND;
                let builder = |label: &str, args: &str| {
                    tauri::webview::WebviewBuilder::new(
                        label,
                        tauri::WebviewUrl::External("about:blank".parse().unwrap()),
                    )
                    .data_directory(profile.path().into())
                    .additional_browser_args(args)
                };
                let baseline = child_containers(parent);
                let view =
                    add_child(&window, "working", builder("working", "--lang=en-US")).unwrap();
                let working = child_containers(parent);
                let hwnd = *working.difference(&baseline).next().unwrap();
                let result = add_child(&window, "failing", builder("failing", "--lang=fr-FR"));
                assert!(result.unwrap_err().contains("0x8007139F"));
                assert_eq!(child_containers(parent), working);

                let hit = |x, y| unsafe {
                    ChildWindowFromPointEx(parent, POINT { x, y }, CWP_SKIPINVISIBLE)
                };
                let assert_released = || {
                    for (x, y) in [(32, 32), (128, 80), (128, 160)] {
                        assert_eq!(hit(x, y), parent);
                    }
                };
                assert_released();
                show(
                    &view,
                    tauri::Rect {
                        position: tauri::PhysicalPosition::new(16, 16).into(),
                        size: tauri::PhysicalSize::new(256, 192).into(),
                    },
                    1.,
                    false,
                )
                .unwrap();
                assert_eq!(hit(128, 80), hwnd);
                show(
                    &view,
                    tauri::Rect {
                        position: tauri::PhysicalPosition::new(0, 0).into(),
                        size: window.inner_size().unwrap().into(),
                    },
                    1.,
                    true,
                )
                .unwrap();
                for (x, y) in [(2, 32), (128, 80), (128, 300)] {
                    assert_eq!(hit(x, y), hwnd);
                }
                hide(&view).unwrap();
                assert_released();
                assert_eq!(hit(2, 32), parent);
                assert_eq!(hit(128, 300), parent);
                view.close().unwrap();
                assert_eq!(child_containers(parent), baseline);
                app.exit(0);
            });
            assert_eq!(exit, 0);
        }
    }
}

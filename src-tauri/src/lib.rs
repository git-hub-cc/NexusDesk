pub mod commands;
pub mod core;
pub mod state;
mod logging;
mod profiles;
mod capture_service;
mod speech_input;

use state::AppState;
use std::sync::{Arc, Mutex};
use tauri::Manager;

fn is_project_window(label: &str) -> bool {
    label == "main" || label.strip_prefix("window-")
        .is_some_and(|suffix| !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit()))
}

#[cfg(test)]
mod lifecycle_tests {
    use super::is_project_window;

    #[test]
    fn only_project_windows_keep_app_alive() {
        assert!(is_project_window("main"));
        assert!(is_project_window("window-1720000000000"));
        for utility in ["nexusdesk-native-menu", "window-snapshot-123", "browser-popup-123",
            "window-1720000000000-browser-popup-123", "window-", "main-browser-popup-123"] {
            assert!(!is_project_window(utility), "{utility}");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    logging::init().expect("Cannot initialize application logs");
    if std::env::args_os().any(|arg| arg == "--capture-service") {
        capture_service::run();
        return;
    }
    let project = commands::project_cmds::project_argument(std::env::args_os());
    let profile_root = dirs::home_dir().expect("Cannot find home directory").join(".nexus/profiles");
    let profile = profiles::allocate(&profile_root, project.as_deref()).expect("Cannot create project profile");
    let window_state_file = format!("window-state-{}.json",
        profiles::profile_key(project.as_deref()).expect("Cannot identify project"));
    log::info!("Project WebView2 profile: {}", profile.directory.display());
    tauri::Builder::default()
        .manage(commands::project_cmds::StartupProject(project))
        .manage(profile)
        // Let WebView2 manage TSF focus and composition. Detaching the host's
        // IMM context on activation can make input methods fall back to IMM32.
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Normalize the hidden, undecorated HWND's client area before window-state
        // measures its frame offsets in set_size. The initial WM_NCCALCSIZE can
        // still include a native caption, which would inflate the restored height.
        .plugin(tauri::plugin::Builder::<tauri::Wry>::new("window-frame")
            .on_window_ready(|window| {
                #[cfg(windows)]
                if window.label() == "main" && !window.is_decorated().unwrap_or(true) {
                    use windows_sys::Win32::UI::WindowsAndMessaging::{
                        SetWindowPos, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE,
                        SWP_NOSIZE, SWP_NOZORDER,
                    };
                    if let Ok(hwnd) = window.hwnd() {
                        // Recalculate the nonclient area without showing or resizing.
                        if unsafe { SetWindowPos(hwnd.0 as _, std::ptr::null_mut(), 0, 0, 0, 0,
                            SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER) } == 0 {
                            log::warn!("Cannot initialize window frame: {}", std::io::Error::last_os_error());
                        }
                    }
                }
                #[cfg(not(windows))]
                let _ = window;
            })
            .build())
        .plugin(tauri_plugin_window_state::Builder::default()
            .with_filename(window_state_file)
            .with_filter(|label| label == "main")
            .with_state_flags(tauri_plugin_window_state::StateFlags::SIZE
                | tauri_plugin_window_state::StateFlags::POSITION
                | tauri_plugin_window_state::StateFlags::MAXIMIZED)
            .build())
        .manage(commands::android_mirror::MirrorState::default())
        .manage(commands::capture_cmds::CaptureState::default())
        .manage(commands::codex_proxy::CodexProxyState::default())
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if window.label() == speech_input::WINDOW_LABEL {
                    commands::stt_cmds::stt_cancel();
                }
                commands::browser_cmds::close_window_popups(window);
                let app = window.app_handle();
                app.state::<commands::android_mirror::MirrorState>().close_window(window.label());
                app.state::<commands::terminal_cmds::TerminalState>().close_window(window.label());
                // Utility windows and snapshots must not keep the application alive.
                // Destroyed also respects any frontend cancellation of CloseRequested.
                if is_project_window(window.label())
                    // A project with child browser webviews is absent from
                    // webview_windows(); count native windows to include it.
                    && !app.windows().keys().any(|label| label != window.label() && is_project_window(label))
                {
                    app.exit(0);
                }
            }
        })
        .setup(|app| {
            if commands::settings_cmds::needs_migration()? {
                commands::settings_cmds::start_migration(app.handle())?;
            } else {
                profiles::create_main(app.handle())?;
            }
            commands::menu_cmds::warmup(app.handle())?;
            capture_service::connect(app.handle().clone());
            Ok(())
        })
        .manage(Arc::new(core::search::SearchState::default()))
        .manage(core::fs::WatcherState::default())
        .manage(commands::terminal_cmds::TerminalState::default())
        .manage(commands::remote_cmds::RemoteState::default())
        .manage(commands::preview_cmds::PreviewState::default())
        .manage(commands::http_cmds::HttpState::default())
        .manage(AppState {
            db_conn: Arc::new(Mutex::new(None)),
        })
        .invoke_handler(|invoke| {
            if invoke.message.webview().label().starts_with("window-snapshot-")
                && !commands::snapshot_cmds::allowed_command(invoke.message.command()) {
                invoke.resolver.reject("历史快照为只读，无法修改项目或运行终端");
                return true;
            }
            let handler: Box<dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool> = Box::new(tauri::generate_handler![
            commands::android_mirror::mirror_devices,
            commands::android_mirror::mirror_connect_wifi,
            commands::android_mirror::mirror_list_files,
            commands::android_mirror::mirror_push_file,
            commands::android_mirror::mirror_pull_file,
            commands::android_mirror::mirror_download_file,
            commands::android_mirror::mirror_read_file,
            commands::android_mirror::mirror_read_image,
            commands::android_mirror::mirror_delete_files,
            commands::android_mirror::mirror_create_folder,
            commands::android_mirror::mirror_copy_file,
            commands::android_mirror::mirror_start,
            commands::android_mirror::mirror_stop,
            commands::android_mirror::mirror_visible,
            commands::android_mirror::mirror_control,
            commands::snapshot_cmds::open_git_snapshot,
            commands::project_cmds::startup_project,
            commands::project_cmds::open_project_instance,
            commands::settings_cmds::read_global_settings,
            commands::settings_cmds::write_global_setting,
            commands::settings_cmds::import_global_settings,
            commands::capture_cmds::capture_shortcut_status,
            commands::capture_cmds::capture_start,
            commands::capture_cmds::capture_cancel,
            commands::capture_cmds::capture_copy_text,
            commands::browser_cmds::create_browser,
            commands::browser_extensions::browser_install_extension,
            commands::browser_extensions::browser_list_extensions,
            commands::browser_extensions::browser_remove_extension,
            commands::browser_extensions::browser_open_extension_page,
            commands::browser_cmds::browser_layout,
            commands::browser_cmds::browser_action,
            commands::browser_downloads::browser_downloads,
            commands::browser_downloads::browser_cancel_download,
            commands::browser_cmds::browser_suggestions,
            commands::browser_cmds::browser_can_go,
            commands::menu_cmds::native_menu_open,
            commands::menu_cmds::native_menu_close,
            commands::menu_cmds::native_menu_contains_pointer,
            commands::browser_passwords::browser_import_passwords,
            commands::browser_passwords::browser_password_stats,
            commands::browser_passwords::browser_export_passwords,
            commands::music_cmds::search_music,
            commands::music_cmds::music_service_resource,
            commands::music_cmds::music_cover_url,
            commands::music_cmds::download_music,
            commands::music_cmds::list_local_music,
            commands::media_import::import_media_files,
            commands::music_cmds::list_music_playlists,
            commands::music_cmds::save_music_playlists,
            commands::music_cmds::delete_local_music,
            commands::video_cmds::video_tool_status,
            commands::software_manager::managed_software_list,
            commands::software_manager::managed_software_status,
            commands::software_manager::managed_software_install,
            commands::software_manager::managed_software_uninstall,
            commands::video_cmds::list_local_videos,
            commands::video_cmds::download_video,
            commands::http_cmds::send_http_request,
            commands::http_cmds::cancel_http_request,
            commands::stt_cmds::stt_model_status,
            commands::stt_cmds::stt_download_model,
            commands::stt_cmds::stt_transcribe,
            commands::stt_cmds::stt_prepare,
            commands::stt_cmds::stt_cancel,
            commands::codex_network::codex_network_requests,
            commands::codex_proxy::codex_proxy_detect,
            commands::codex_proxy::codex_proxy_status,
            commands::codex_proxy::codex_proxy_start,
            commands::codex_proxy::codex_proxy_stop,
            commands::codex_proxy::codex_proxy_requests,
            logging::write_console_logs,
            commands::remote_cmds::connect_remote,
            commands::remote_cmds::reconnect_remote,
            commands::remote_cmds::remote_files,
            commands::remote_cmds::start_remote_terminal,
            commands::remote_cmds::write_remote_terminal,
            commands::remote_cmds::resize_remote_terminal,
            commands::remote_cmds::close_remote_terminal,
            commands::remote_cmds::close_remote,
            commands::graph_cmds::get_graph_categories,
            commands::graph_cmds::set_graph_category_color,
            commands::graph_cmds::create_graph_category,
            commands::graph_cmds::link_graph_files,
            commands::graph_cmds::edit_graph_category,
            commands::graph_cmds::remove_graph_file,
            commands::git_cmds::get_git_image_diff,
            commands::git_cmds::is_git_installed,
            commands::git_cmds::clone_git_repository,
            commands::git_cmds::list_git_repositories,
            commands::git_cmds::push_git_repository,
            commands::git_cmds::get_git_settings,
            commands::git_cmds::save_git_settings,
            commands::git_cmds::undo_git_commit,
            commands::git_cmds::init_git_repository,
            commands::git_cmds::is_git_repository,
            commands::preview_cmds::start_html_preview,
            commands::preview_cmds::stop_html_preview,
            commands::terminal_cmds::start_terminal,
            commands::terminal_cmds::check_terminal_command,
            commands::terminal_cmds::load_terminal_history,
            commands::terminal_cmds::save_terminal_history,
            commands::terminal_cmds::write_terminal,
            commands::terminal_cmds::resize_terminal,
            commands::terminal_cmds::close_terminal,
            core::search::search_everywhere,
            core::search::cancel_search,
            commands::fs_cmds::touch_file,
            commands::fs_cmds::recent_files,
            commands::fs_cmds::compare_text,
            commands::fs_cmds::is_directory,
            commands::fs_cmds::project_directory_exists,
            commands::fs_cmds::init_project_db,
            commands::fs_cmds::read_file,
            commands::fs_cmds::read_binary_file,
            commands::document_cmds::convert_legacy_office,
            commands::fs_cmds::write_binary_file,
            commands::fs_cmds::import_asset,
            commands::fs_cmds::write_file,
            commands::fs_cmds::list_local_history,
            commands::fs_cmds::local_history_content,
            commands::fs_cmds::get_file_links,
            commands::fs_cmds::read_directory,
            commands::fs_cmds::sync_project_index,
            commands::fs_cmds::get_logical_tree,
            commands::fs_cmds::prepare_logical_sandbox,
            commands::fs_cmds::create_logical_folder,
            commands::fs_cmds::edit_logical_folder,
            commands::fs_cmds::remove_logical_file,
            commands::fs_cmds::get_hidden_logical_files,
            commands::fs_cmds::update_file_frontmatter,
            commands::fs_cmds::copy_file_to_dir,
            commands::fs_cmds::move_entry,
            commands::fs_cmds::rename_entry,
            commands::clipboard_cmds::read_file_clipboard,
            commands::clipboard_cmds::write_file_clipboard,
            commands::clipboard_cmds::write_text_clipboard,
            commands::clipboard_cmds::paste_text,
            commands::clipboard_cmds::read_text_clipboard,
            commands::fs_cmds::delete_entry,
            commands::fs_cmds::stash_entry,
            commands::fs_cmds::create_physical_file,
            commands::fs_cmds::create_physical_dir,
            commands::git_cmds::get_git_status,
            commands::git_cmds::get_git_tree_status,
            commands::git_cmds::revert_git_file,
            commands::git_cmds::revert_git_files,
            commands::git_cmds::undo_git_revert,
            commands::git_cmds::ignore_git_file,
            commands::git_cmds::stage_git_file,
            commands::git_cmds::commit_git,
            commands::git_cmds::get_git_log,
            commands::git_cmds::get_git_path_history,
            commands::git_cmds::get_git_diff,
            commands::git_cmds::get_git_revision_files,
            commands::git_cmds::get_git_revision_content,
            commands::git_cmds::get_git_revision_changes,
            commands::git_cmds::get_git_revision_diff,
            commands::git_cmds::restore_git_revision_file,
            commands::git_cmds::restore_git_revision_directory,
        ]);
            handler(invoke)
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                use tauri::Manager;
                app.state::<commands::android_mirror::MirrorState>().shutdown();
                app.state::<commands::capture_cmds::CaptureState>().shutdown();
                app.state::<commands::terminal_cmds::TerminalState>().shutdown();
                app.state::<commands::remote_cmds::RemoteState>().shutdown();
            }
        });
}

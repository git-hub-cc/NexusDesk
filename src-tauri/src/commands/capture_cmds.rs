use image::RgbaImage;
use std::sync::{
    Mutex, OnceLock,
    atomic::{AtomicBool, Ordering},
};
use tauri::Manager;

#[derive(Default)]
pub struct CaptureState {
    ocr: Mutex<Option<crate::core::ocr::Ocr>>,
    pub shortcut_error: Mutex<Option<String>>,
    pub(crate) active: AtomicBool,
    pub(crate) proxy: OnceLock<winit::event_loop::EventLoopProxy<super::native_capture::Message>>,
}

impl CaptureState {
    pub fn shutdown(&self) {
        if let Some(proxy) = self.proxy.get() {
            let _ = proxy.send_event(super::native_capture::Message::Shutdown);
        }
    }
}

pub fn start(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<CaptureState>();
    if state.active.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let started = std::time::Instant::now();
        let result = (|| {
            let mut frames = Vec::new();
            // Freeze all monitors before displaying any overlay. No PNG or IPC transfer.
            for screen in screenshots::Screen::all().map_err(|e| e.to_string())? {
                let frame = screen.capture().map_err(|e| e.to_string())?;
                let image = RgbaImage::from_raw(frame.width(), frame.height(), frame.into_raw())
                    .ok_or("Invalid screen image")?;
                frames.push(super::native_capture::Frame {
                    x: screen.display_info.x,
                    y: screen.display_info.y,
                    image,
                });
            }
            if frames.is_empty() {
                return Err("No monitors available".into());
            }
            log::info!("Screen capture ready in {:?}", started.elapsed());
            app.state::<CaptureState>()
                .proxy
                .get()
                .ok_or("Native capture is unavailable")?
                .send_event(super::native_capture::Message::Start(frames))
                .map_err(|e| e.to_string())
        })();
        if let Err(error) = result {
            report_error(&app, error);
        }
    });
    Ok(())
}
pub(crate) fn pin_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("captures/latest.png"))
}

pub(crate) fn toggle_pin(app: &tauri::AppHandle) -> Result<(), String> {
    app.state::<CaptureState>().proxy.get().ok_or("Native capture is unavailable")?
        .send_event(super::native_capture::Message::TogglePin).map_err(|e| e.to_string())
}
pub(crate) fn report_error(app: &tauri::AppHandle, error: String) {
    app.state::<CaptureState>()
        .active
        .store(false, Ordering::SeqCst);
    log::error!("Screenshot: {error}");
    crate::capture_service::emit(app, "capture-error", serde_json::json!(error));
}
#[tauri::command]
pub async fn capture_start(app: tauri::AppHandle) -> Result<(), String> {
    crate::capture_service::request(&app, "start")
}
#[tauri::command]
pub fn capture_cancel(app: tauri::AppHandle) {
    if !crate::capture_service::is_service() {
        let _ = crate::capture_service::request(&app, "cancel");
        return;
    }
    if let Some(proxy) = app.state::<CaptureState>().proxy.get() {
        let _ = proxy.send_event(super::native_capture::Message::Cancel);
    }
}
pub(crate) fn complete(
    app: tauri::AppHandle,
    image: RgbaImage,
    action: &'static str,
    region: [i64; 4],
) {
    crate::capture_service::emit(&app, "capture-progress", serde_json::json!({"action":action}));
    std::thread::spawn(move || {
        let result = (|| -> Result<Option<String>, String> {
            let path = pin_path(&app)?;
            std::fs::create_dir_all(path.parent().ok_or("Invalid capture path")?).map_err(|e| e.to_string())?;
            let temporary = path.with_extension("tmp.png");
            image.save_with_format(&temporary, image::ImageFormat::Png).map_err(|e| e.to_string())?;
            std::fs::rename(&temporary, &path).map_err(|e| e.to_string())?;
            let _ = app.state::<CaptureState>().proxy.get().map(|proxy|
                proxy.send_event(super::native_capture::Message::RefreshPin));
            match action {
                "ocr" => {
                    let state = app.state::<CaptureState>();
                    let mut engine = state.ocr.lock().map_err(|e| e.to_string())?;
                    if engine.is_none() {
                        *engine = Some(crate::core::ocr::Ocr::load(
                            &app.path()
                                .resource_dir()
                                .map_err(|e| e.to_string())?
                                .join("resources/ocr"),
                        )?);
                    }
                    let text = engine
                        .as_mut()
                        .unwrap()
                        .recognize(&image::DynamicImage::ImageRgba8(image).to_rgb8())?;
                    arboard::Clipboard::new()
                        .and_then(|mut clipboard| clipboard.set_text(text.clone()))
                        .map_err(|e| e.to_string())?;
                    Ok(Some(text))
                }
                "save" => {
                    use tauri_plugin_dialog::DialogExt;
                    if let Some(path) = app
                        .dialog()
                        .file()
                        .set_file_name("screenshot.png")
                        .add_filter("PNG", &["png"])
                        .blocking_save_file()
                    {
                        image
                            .save_with_format(
                                path.into_path().map_err(|e| e.to_string())?,
                                image::ImageFormat::Png,
                            )
                            .map_err(|e| e.to_string())?;
                    } else { return Ok(None); }
                    Ok(Some(String::new()))
                }
                _ => {
                    arboard::Clipboard::new()
                        .and_then(|mut c| {
                            c.set_image(arboard::ImageData {
                                width: image.width() as usize,
                                height: image.height() as usize,
                                bytes: std::borrow::Cow::Owned(image.into_raw()),
                            })
                        })
                        .map_err(|e| e.to_string())?;
                    Ok(Some(String::new()))
                }
            }
        })();
        match result {
            Ok(text) => {
                if action == "copy_pin" {
                    if let Err(error) = toggle_pin(&app) {
                        report_error(&app, error);
                    }
                }
                crate::capture_service::emit(
                    &app, "capture-complete",
                    serde_json::json!({"action": action, "cancelled": text.is_none(), "text": text.unwrap_or_default(), "region": region}),
                );
            }
            Err(error) => report_error(&app, error),
        }
        app.state::<CaptureState>().active.store(false, Ordering::SeqCst);
    });
}

#[tauri::command]
pub async fn enable_terminal_file_drop(view: tauri::Webview) -> Result<(), String> {
    if !crate::is_project_window(view.label()) {
        return Err("仅项目窗口支持终端文件拖拽".into());
    }
    #[cfg(windows)]
    {
        use tauri::Emitter;
        use webview2_com::{Microsoft::Web::WebView2::Win32::*, WebMessageReceivedEventHandler};
        use windows::core::{Interface, PWSTR};

        let source = view.url().map_err(|error| error.to_string())?.to_string();
        let target = view.clone();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        view.with_webview(move |platform| unsafe {
            let result = (|| -> Result<(), String> {
                thread_local! {
                    static INSTALLED: std::cell::RefCell<std::collections::HashSet<String>> = std::cell::RefCell::default();
                }
                if INSTALLED.with(|installed| installed.borrow().contains(target.label())) {
                    return Ok(());
                }
                let core = platform.controller().CoreWebView2().map_err(|e| e.to_string())?;
                let destination = target.clone();
                let mut token = 0;
                core.add_WebMessageReceived(&WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()); };
                    let mut text = PWSTR::null();
                    if args.TryGetWebMessageAsString(&mut text).is_err() { return Ok(()); }
                    let text = webview2_com::take_pwstr(text);
                    let Some(message) = text.strip_prefix("nexusdesk-terminal-drop:") else { return Ok(()); };
                    let mut origin = PWSTR::null();
                    args.Source(&mut origin)?;
                    if webview2_com::take_pwstr(origin) != source { return Ok(()); }
                    let Ok(mut payload) = serde_json::from_str::<serde_json::Value>(message) else { return Ok(()); };
                    if payload["sessionId"].as_str().is_none() { return Ok(()); }
                    let result = (|| -> windows::core::Result<Vec<String>> {
                        let objects = args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>()?.AdditionalObjects()?;
                        let mut count = 0;
                        objects.Count(&mut count)?;
                        let mut paths = Vec::new();
                        for index in 0..count {
                            let file = objects.GetValueAtIndex(index)?.cast::<ICoreWebView2File>()?;
                            let mut path = PWSTR::null();
                            file.Path(&mut path)?;
                            paths.push(webview2_com::take_pwstr(path));
                        }
                        Ok(paths)
                    })();
                    match result {
                        Ok(paths) => payload["paths"] = serde_json::json!(paths),
                        Err(error) => payload["error"] = serde_json::json!(format!("无法获取拖入文件的完整路径：{error}")),
                    }
                    let _ = destination.emit("nexusdesk-terminal-native-drop", payload);
                    Ok(())
                })), &mut token).map_err(|e| e.to_string())?;
                INSTALLED.with(|installed| installed.borrow_mut().insert(target.label().to_string()));
                Ok(())
            })();
            let _ = sender.send(result);
        }).map_err(|error| error.to_string())?;
        receiver.await.map_err(|error| error.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = view;
        Ok(())
    }
}

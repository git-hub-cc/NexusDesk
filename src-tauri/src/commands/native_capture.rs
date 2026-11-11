use super::capture_cmds::{self, CaptureState};
use ab_glyph::FontArc;
use std::{num::NonZeroU32, rc::Rc, sync::atomic::Ordering};
use tauri::Manager;
use winit::{
    application::ApplicationHandler,
    dpi::{PhysicalPosition, PhysicalSize},
    event::{ElementState, MouseButton, WindowEvent},
    event_loop::{ActiveEventLoop, EventLoop},
    window::{Window, WindowId, WindowLevel},
};

#[cfg(target_os = "windows")]
mod native {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    #[link(name = "user32")]
    unsafe extern "system" {
        fn SetThreadDpiAwarenessContext(context: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
    }
    pub fn enable_per_monitor_dpi() -> Result<(), String> {
        // The capture event loop owns this thread for its entire lifetime.
        // A thread override also works when Tauri has already fixed process DPI awareness.
        const PER_MONITOR_AWARE_V2: isize = -4;
        let previous =
            unsafe { SetThreadDpiAwarenessContext(PER_MONITOR_AWARE_V2 as *mut std::ffi::c_void) };
        if previous.is_null() {
            return Err(format!(
                "Cannot enable capture PerMonitorV2 DPI awareness: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }
    #[link(name = "dwmapi")]
    unsafe extern "system" {
        fn DwmSetWindowAttribute(
            hwnd: *mut std::ffi::c_void,
            attribute: u32,
            value: *const std::ffi::c_void,
            size: u32,
        ) -> i32;
    }
    pub fn configure_overlay(window: &winit::window::Window) {
        if let Ok(handle) = window.window_handle() {
            if let RawWindowHandle::Win32(handle) = handle.as_raw() {
                let hwnd = handle.hwnd.get() as *mut std::ffi::c_void;
                // Disable DWM fade/zoom transitions before the capture overlay is shown.
                const DWMWA_TRANSITIONS_FORCEDISABLED: u32 = 3;
                let disabled: i32 = 1;
                unsafe {
                    DwmSetWindowAttribute(
                        hwnd,
                        DWMWA_TRANSITIONS_FORCEDISABLED,
                        &disabled as *const i32 as *const std::ffi::c_void,
                        std::mem::size_of_val(&disabled) as u32,
                    );
                }
            }
        }
    }
}

pub(crate) struct Frame {
    pub x: i32,
    pub y: i32,
    pub image: image::RgbaImage,
}
pub(crate) enum Message {
    Start(Vec<Frame>),
    Cancel,
    TogglePin,
    RefreshPin,
    Shutdown,
}
struct Pin {
    surface: softbuffer::Surface<Rc<Window>, Rc<Window>>,
    window: Rc<Window>,
    image: image::RgbaImage,
    visible: bool,
}
impl Pin {
    fn paint(&mut self) -> Result<(), String> {
        let size = self.window.inner_size();
        let (Some(w), Some(h)) = (NonZeroU32::new(size.width), NonZeroU32::new(size.height)) else {
            return Ok(());
        };
        self.surface.resize(w, h).map_err(|e| e.to_string())?;
        let image = image::imageops::resize(
            &self.image,
            size.width,
            size.height,
            image::imageops::FilterType::Triangle,
        );
        let mut buffer = self.surface.buffer_mut().map_err(|e| e.to_string())?;
        for (target, pixel) in buffer.iter_mut().zip(image.pixels()) {
            *target = (pixel[0] as u32) << 16 | (pixel[1] as u32) << 8 | pixel[2] as u32;
        }
        buffer.present().map_err(|e| e.to_string())
    }
}
struct Overlay {
    surface: softbuffer::Surface<Rc<Window>, Rc<Window>>,
    window: Rc<Window>,
    frame: Frame,
    pixels: Vec<u32>,
    cursor: (u32, u32),
    anchor: Option<(u32, u32)>,
    rect: Option<[u32; 4]>,
    dragging: bool,
    font: Rc<FontArc>,
    canvas: Vec<u32>,
    previous_rect: Option<[u32; 4]>,
    previous_ui: Vec<[u32; 4]>,
    pressed: Option<u32>,
    resize_edge: Option<(usize, [u32; 4])>,
    last_click: Option<(std::time::Instant, (u32, u32))>,
    modifiers: winit::keyboard::ModifiersState,
}
// All geometry is in physical screenshot pixels.
impl Overlay {
    fn toolbar(&self) -> (u32, u32) {
        let [x, y, _, h] = self.rect.unwrap_or_default();
        (
            x.min(self.frame.image.width().saturating_sub(480)),
            if y + h + 56 < self.frame.image.height() {
                y + h + 10
            } else {
                y.saturating_sub(54)
            },
        )
    }
    fn button_at_cursor(&self) -> Option<u32> {
        if self.dragging || self.rect.is_none() {
            return None;
        }
        let (x, y) = self.cursor;
        let (tx, ty) = self.toolbar();
        (x >= tx && x < tx + 480 && y >= ty && y < ty + 44).then(|| (x - tx) / 120)
    }
    fn handles(&self) -> Vec<(u32, u32)> {
        self.rect
            .map(|[x, y, w, h]| {
                vec![
                    (x, y),
                    (x + w / 2, y),
                    (x + w, y),
                    (x + w, y + h / 2),
                    (x + w, y + h),
                    (x + w / 2, y + h),
                    (x, y + h),
                    (x, y + h / 2),
                ]
            })
            .unwrap_or_default()
    }
    fn handle_at_cursor(&self) -> Option<usize> {
        self.handles()
            .iter()
            .position(|&(x, y)| x.abs_diff(self.cursor.0) <= 6 && y.abs_diff(self.cursor.1) <= 6)
    }
    fn update_cursor(&self) {
        use winit::window::CursorIcon::*;
        self.window
            .set_cursor(if self.button_at_cursor().is_some() {
                Pointer
            } else {
                match self.handle_at_cursor() {
                    Some(0 | 4) => NwseResize,
                    Some(2 | 6) => NeswResize,
                    Some(1 | 5) => NsResize,
                    Some(3 | 7) => EwResize,
                    _ => Crosshair,
                }
            });
    }
    fn paint(&mut self) -> Result<(), String> {
        let w = self.frame.image.width();
        let h = self.frame.image.height();
        if self.canvas.is_empty() {
            self.surface
                .resize(
                    NonZeroU32::new(w).ok_or("Empty screen")?,
                    NonZeroU32::new(h).ok_or("Empty screen")?,
                )
                .map_err(|e| e.to_string())?;
            self.canvas = self
                .pixels
                .iter()
                .map(|p| ((p & 0xfefefe) >> 1) & 0x7f7f7f)
                .collect();
        }
        let mut regions = Vec::new();
        if let Some(r) = self.previous_rect {
            regions.push([r[0], r[1], r[2] + 1, r[3] + 1]);
        }
        if let Some(r) = self.rect {
            regions.push([r[0], r[1], r[2] + 1, r[3] + 1]);
        }
        regions.extend(self.previous_ui.iter().copied());
        let mut ui = Vec::new();
        if let Some([x, y, _, _]) = self.rect {
            let (tx, ty) = self.toolbar();
            ui.push([tx.saturating_sub(12), ty.saturating_sub(12), 504, 68]);
            ui.push([x.saturating_sub(8), y.saturating_sub(34), 240, 40]);
            for (hx, hy) in self.handles() {
                ui.push([hx.saturating_sub(8), hy.saturating_sub(8), 17, 17]);
            }
        }
        let (mx, my) = self.magnifier_position();
        ui.push([mx, my, 180, 174]);
        regions.extend(ui.iter().copied());
        for &[x, y, rw, rh] in &regions {
            for py in y..y.saturating_add(rh).min(h) {
                for px in x..x.saturating_add(rw).min(w) {
                    let i = (py * w + px) as usize;
                    let p = self.pixels[i];
                    self.canvas[i] = if self.rect.is_some_and(|[rx, ry, rw, rh]| {
                        px >= rx && px < rx + rw && py >= ry && py < ry + rh
                    }) {
                        p
                    } else {
                        ((p & 0xfefefe) >> 1) & 0x7f7f7f
                    };
                }
            }
        }
        if let Some([x, y, rw, rh]) = self.rect {
            self.box_fill(x, y, rw, 1, 0x62a9ef);
            self.box_fill(x, y + rh, rw, 1, 0x62a9ef);
            self.box_fill(x, y, 1, rh, 0x62a9ef);
            self.box_fill(x + rw, y, 1, rh + 1, 0x62a9ef);
            for (hx, hy) in self.handles() {
                self.panel(
                    hx.saturating_sub(4),
                    hy.saturating_sub(4),
                    9,
                    9,
                    2,
                    0x91caff,
                );
            }
            self.panel(x, y.saturating_sub(28), 210, 24, 5, 0x24272d);
            self.mono_label(
                x + 8,
                y.saturating_sub(26),
                &format!("{rw} \u{00d7} {rh} px"),
                14.0,
            );
            if !self.dragging {
                let (tx, ty) = self.toolbar();
                // Match native-menu.css: panel border, compact corners and blue selection.
                self.panel(tx, ty, 480, 44, 6, 0x1e1f22);
                self.panel(tx + 1, ty + 1, 478, 42, 5, 0x2b2d30);
                for (i, name) in [
                    "\u{6587}\u{5b57}\u{8bc6}\u{522b}",
                    "\u{590d}\u{5236}\u{56fe}\u{7247}",
                    "\u{4fdd}\u{5b58}\u{56fe}\u{7247}",
                    "\u{53d6}\u{6d88}",
                ]
                .iter()
                .enumerate()
                {
                    let bx = tx + i as u32 * 120;
                    let pressed = self.pressed == Some(i as u32);
                    let hovered = self.button_at_cursor() == Some(i as u32);
                    if hovered {
                        self.panel(
                            bx + 4,
                            ty + 5,
                            112,
                            34,
                            3,
                            if pressed { 0x2f65ca } else { 0x3574f0 },
                        );
                    }
                    let color = if hovered { 0xffffff } else { 0xa9b7c6 };
                    self.icon(bx + 12, ty + 14, i, color);
                    self.colored_label(bx + 36, ty + 13, name, 13.0, color);
                }
            }
        }
        {
            let (mx, my) = self.magnifier_position();
            self.panel(mx, my, 180, 174, 7, 0x252830);
            let (cx, cy) = self.cursor;
            for gy in 0..11u32 {
                for gx in 0..11u32 {
                    let sx = (cx as i64 + gx as i64 - 5).clamp(0, w as i64 - 1) as u32;
                    let sy = (cy as i64 + gy as i64 - 5).clamp(0, h as i64 - 1) as u32;
                    self.box_fill(
                        mx + 35 + gx * 10,
                        my + 8 + gy * 10,
                        9,
                        9,
                        self.pixels[(sy * w + sx) as usize],
                    );
                }
            }
            self.box_fill(mx + 84, my + 8, 1, 110, 0x62a9ef);
            self.box_fill(mx + 35, my + 57, 110, 1, 0x62a9ef);
            let color = self.pixels[(cy.min(h - 1) * w + cx.min(w - 1)) as usize];
            self.label(mx + 10, my + 122, &format!("#{color:06X}"), 15.0);
            self.label(
                mx + 10,
                my + 146,
                &format!(
                    "{}, {}",
                    self.frame.x as i64 + cx as i64,
                    self.frame.y as i64 + cy as i64
                ),
                13.0,
            );
        }
        let mut buffer = self.surface.buffer_mut().map_err(|e| e.to_string())?;
        if buffer.age() != 1 {
            buffer.copy_from_slice(&self.canvas);
        } else {
            for &[x, y, rw, rh] in &regions {
                for py in y..y.saturating_add(rh).min(h) {
                    let start = (py * w + x.min(w)) as usize;
                    let end = (py * w + x.saturating_add(rw).min(w)) as usize;
                    buffer[start..end].copy_from_slice(&self.canvas[start..end]);
                }
            }
        }
        self.previous_rect = self.rect;
        self.previous_ui = ui;
        buffer.present().map_err(|e| e.to_string())
    }
    fn magnifier_position(&self) -> (u32, u32) {
        let w = self.frame.image.width();
        let h = self.frame.image.height();
        let x = (self.cursor.0 + 24).min(w.saturating_sub(180));
        let y = (self.cursor.1 + 24).min(h.saturating_sub(174));
        if self.rect.is_some() && !self.dragging {
            let (tx, ty) = self.toolbar();
            if x < tx + 480 && x + 180 > tx && y < ty + 44 && y + 174 > ty {
                // Keep the precision preview clear of the action buttons.
                return (
                    x,
                    if ty >= 184 {
                        ty - 184
                    } else {
                        (ty + 54).min(h.saturating_sub(174))
                    },
                );
            }
        }
        (x, y)
    }
    fn icon(&mut self, x: u32, y: u32, kind: usize, color: u32) {
        // Lucide-style ScanText, Copy, Download and X strokes in the native renderer.
        let lines: Vec<(u32, u32, u32, u32)> = match kind {
            0 => vec![
                (0, 4, 0, 0),
                (0, 0, 4, 0),
                (12, 0, 16, 0),
                (16, 0, 16, 4),
                (0, 12, 0, 16),
                (0, 16, 4, 16),
                (12, 16, 16, 16),
                (16, 12, 16, 16),
                (4, 6, 12, 6),
                (4, 10, 12, 10),
            ],
            1 => vec![
                (5, 5, 15, 5),
                (15, 5, 15, 16),
                (15, 16, 5, 16),
                (5, 16, 5, 5),
                (1, 11, 1, 1),
                (1, 1, 11, 1),
            ],
            2 => vec![
                (8, 0, 8, 11),
                (4, 7, 8, 11),
                (8, 11, 12, 7),
                (1, 12, 1, 16),
                (1, 16, 15, 16),
                (15, 16, 15, 12),
            ],
            _ => vec![(2, 2, 14, 14), (2, 14, 14, 2)],
        };
        for (ax, ay, bx, by) in lines {
            let steps = ax.abs_diff(bx).max(ay.abs_diff(by)).max(1);
            for t in 0..=steps {
                let px = ax as i32 + (bx as i32 - ax as i32) * t as i32 / steps as i32;
                let py = ay as i32 + (by as i32 - ay as i32) * t as i32 / steps as i32;
                self.box_fill(x + px as u32, y + py as u32, 1, 1, color);
            }
        }
    }
    fn box_fill(&mut self, x: u32, y: u32, w: u32, h: u32, color: u32) {
        let width = self.frame.image.width();
        for py in y..y.saturating_add(h).min(self.frame.image.height()) {
            for px in x..x.saturating_add(w).min(width) {
                self.canvas[(py * width + px) as usize] = color;
            }
        }
    }
    fn panel(&mut self, x: u32, y: u32, w: u32, h: u32, r: u32, color: u32) {
        for dy in 0..h {
            let inset = if dy < r {
                r - dy
            } else if dy >= h.saturating_sub(r) {
                dy + r + 1 - h
            } else {
                0
            };
            self.box_fill(x + inset, y + dy, w.saturating_sub(inset * 2), 1, color);
        }
    }
    fn mono_label(&mut self, x: u32, y: u32, text: &str, size: f32) {
        for (i, c) in text.chars().enumerate() {
            self.label(x + i as u32 * 9, y, &c.to_string(), size);
        }
    }
    fn label(&mut self, x: u32, y: u32, text: &str, size: f32) {
        self.colored_label(x, y, text, size, 0xe1e5ed);
    }
    fn colored_label(&mut self, x: u32, y: u32, text: &str, size: f32, color: u32) {
        let mut glyphs = image::RgbaImage::new(
            (text.chars().count() as u32 * 20 + 8).min(self.frame.image.width()),
            24,
        );
        imageproc::drawing::draw_text_mut(
            &mut glyphs,
            image::Rgba([225, 229, 237, 255]),
            0,
            0,
            size,
            self.font.as_ref(),
            text,
        );
        let w = self.frame.image.width();
        for (dx, dy, p) in glyphs.enumerate_pixels() {
            if x + dx >= w || y + dy >= self.frame.image.height() || p[3] == 0 {
                continue;
            }
            let target = &mut self.canvas[((y + dy) * w + x + dx) as usize];
            let a = p[3] as u32;
            let blend = |shift: u32, c: u32| (((*target >> shift) & 255) * (255 - a) + c * a) / 255;
            *target = (blend(16, (color >> 16) & 255) << 16)
                | (blend(8, (color >> 8) & 255) << 8)
                | blend(0, color & 255);
        }
    }
}
struct CaptureApp {
    app: tauri::AppHandle,
    overlays: Vec<Overlay>,
    font: Rc<FontArc>,
    pin: Option<Pin>,
}
impl CaptureApp {
    fn toggle_pin(&mut self, event_loop: &ActiveEventLoop) -> Result<(), String> {
        if !self.overlays.is_empty() {
            return Ok(());
        }
        if let Some(pin) = &mut self.pin {
            pin.visible = !pin.visible;
            pin.window.set_visible(pin.visible);
            if pin.visible {
                pin.window.request_redraw();
            }
            return Ok(());
        }
        let path = capture_cmds::pin_path(&self.app)?;
        if !path.exists() {
            return Ok(());
        }
        let image = image::open(path).map_err(|e| e.to_string())?.to_rgba8();
        let monitor = event_loop
            .primary_monitor()
            .or_else(|| event_loop.available_monitors().next());
        let mut width = image.width();
        let mut height = image.height();
        if let Some(monitor) = &monitor {
            let size = monitor.size();
            let scale = (size.width as f64 * 0.9 / width as f64)
                .min(size.height as f64 * 0.9 / height as f64)
                .min(1.0);
            width = (width as f64 * scale).max(1.0) as u32;
            height = (height as f64 * scale).max(1.0) as u32;
        }
        let mut attributes = Window::default_attributes()
            .with_title("贴图 · F3 隐藏 · 拖动移动 · 右键关闭")
            .with_decorations(false)
            .with_window_level(WindowLevel::AlwaysOnTop)
            .with_visible(false)
            .with_inner_size(PhysicalSize::new(width, height));
        if let Some(monitor) = monitor {
            let pos = monitor.position();
            let size = monitor.size();
            attributes = attributes.with_position(PhysicalPosition::new(
                pos.x + (size.width.saturating_sub(width) / 2) as i32,
                pos.y + (size.height.saturating_sub(height) / 2) as i32,
            ));
        }
        #[cfg(target_os = "windows")]
        let attributes = {
            use winit::platform::windows::WindowAttributesExtWindows;
            attributes.with_skip_taskbar(true)
        };
        let window = Rc::new(
            event_loop
                .create_window(attributes)
                .map_err(|e| e.to_string())?,
        );
        let context = softbuffer::Context::new(window.clone()).map_err(|e| e.to_string())?;
        let surface =
            softbuffer::Surface::new(&context, window.clone()).map_err(|e| e.to_string())?;
        let mut pin = Pin {
            surface,
            window,
            image,
            visible: true,
        };
        pin.paint()?;
        pin.window.set_visible(true);
        pin.window.request_redraw();
        self.pin = Some(pin);
        Ok(())
    }
    fn cancel(&mut self) {
        self.overlays.clear();
        self.app
            .state::<CaptureState>()
            .active
            .store(false, Ordering::SeqCst);
    }
    fn finish(&mut self, index: usize, action: &'static str) {
        let o = &self.overlays[index];
        if let Some([x, y, w, h]) = o.rect {
            let image = image::imageops::crop_imm(&o.frame.image, x, y, w, h).to_image();
            let region = [
                o.frame.x as i64 + x as i64,
                o.frame.y as i64 + y as i64,
                w as i64,
                h as i64,
            ];
            for overlay in &self.overlays {
                overlay.window.set_visible(false);
            }
            self.overlays.clear();
            capture_cmds::complete(self.app.clone(), image, action, region);
        }
    }
}
impl ApplicationHandler<Message> for CaptureApp {
    fn resumed(&mut self, _: &ActiveEventLoop) {}
    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: Message) {
        match event {
            Message::TogglePin => {
                if !self.overlays.is_empty() {
                    if let Some(index) = self
                        .overlays
                        .iter()
                        .position(|o| o.rect.is_some() && !o.dragging)
                    {
                        self.finish(index, "copy_pin");
                    }
                    return;
                }
                if let Err(error) = self.toggle_pin(event_loop) {
                    capture_cmds::report_error(&self.app, error);
                }
            }
            Message::RefreshPin => {
                self.pin = None;
            }
            Message::Shutdown => {
                self.cancel();
                event_loop.exit();
            }
            Message::Cancel => self.cancel(),
            Message::Start(frames) => {
                let started = std::time::Instant::now();
                let result = (|| -> Result<(), String> {
                    for frame in frames {
                        let attributes = Window::default_attributes()
                            .with_title("截图 / 文字识别")
                            .with_decorations(false)
                            .with_window_level(WindowLevel::AlwaysOnTop)
                            .with_resizable(false)
                            .with_visible(false)
                            .with_active(false)
                            .with_position(PhysicalPosition::new(frame.x, frame.y))
                            .with_inner_size(PhysicalSize::new(
                                frame.image.width(),
                                frame.image.height(),
                            ));
                        #[cfg(target_os = "windows")]
                        let attributes = {
                            use winit::platform::windows::WindowAttributesExtWindows;
                            attributes.with_skip_taskbar(true)
                        };
                        let window = Rc::new(
                            event_loop
                                .create_window(attributes)
                                .map_err(|e| e.to_string())?,
                        );
                        #[cfg(target_os = "windows")]
                        native::configure_overlay(&window);
                        window.set_outer_position(PhysicalPosition::new(frame.x, frame.y));
                        let _ = window.request_inner_size(PhysicalSize::new(
                            frame.image.width(),
                            frame.image.height(),
                        ));
                        window.set_cursor(winit::window::CursorIcon::Crosshair);
                        let context =
                            softbuffer::Context::new(window.clone()).map_err(|e| e.to_string())?;
                        let surface = softbuffer::Surface::new(&context, window.clone())
                            .map_err(|e| e.to_string())?;
                        let pixels = frame
                            .image
                            .pixels()
                            .map(|p| (p[0] as u32) << 16 | (p[1] as u32) << 8 | p[2] as u32)
                            .collect();
                        let mut overlay = Overlay {
                            surface,
                            window,
                            frame,
                            pixels,
                            cursor: (0, 0),
                            anchor: None,
                            rect: None,
                            dragging: false,
                            font: self.font.clone(),
                            canvas: Vec::new(),
                            previous_rect: None,
                            previous_ui: Vec::new(),
                            pressed: None,
                            last_click: None,
                            resize_edge: None,
                            modifiers: winit::keyboard::ModifiersState::empty(),
                        };
                        overlay.paint()?;
                        self.overlays.push(overlay);
                    }
                    for o in &self.overlays {
                        o.window.set_visible(true);
                        o.window.request_redraw();
                    }
                    if let Some(o) = self.overlays.first() {
                        o.window.focus_window();
                    }

                    log::info!(
                        "Native screenshot overlays ready in {:?}",
                        started.elapsed()
                    );
                    Ok(())
                })();
                if let Err(error) = result {
                    self.cancel();
                    capture_cmds::report_error(&self.app, error);
                }
            }
        }
    }
    fn window_event(&mut self, _: &ActiveEventLoop, id: WindowId, event: WindowEvent) {
        if let Some(pin) = self.pin.as_mut().filter(|pin| pin.window.id() == id) {
            match event {
                WindowEvent::CloseRequested
                | WindowEvent::MouseInput {
                    state: ElementState::Pressed,
                    button: MouseButton::Right,
                    ..
                } => {
                    pin.visible = false;
                    pin.window.set_visible(false);
                }
                WindowEvent::KeyboardInput { event, .. }
                    if event.state == ElementState::Pressed
                        && event.logical_key
                            == winit::keyboard::Key::Named(winit::keyboard::NamedKey::Escape) =>
                {
                    pin.visible = false;
                    pin.window.set_visible(false);
                }
                WindowEvent::MouseInput {
                    state: ElementState::Pressed,
                    button: MouseButton::Left,
                    ..
                } => {
                    let _ = pin.window.drag_window();
                }
                WindowEvent::Resized(_) => pin.window.request_redraw(),
                WindowEvent::RedrawRequested => {
                    if let Err(error) = pin.paint() {
                        log::error!("Pin screenshot: {error}");
                    }
                }
                _ => {}
            }
            return;
        }
        let Some(index) = self.overlays.iter().position(|o| o.window.id() == id) else {
            return;
        };
        let o = &mut self.overlays[index];
        match event {
            WindowEvent::CloseRequested => self.cancel(),
            WindowEvent::ModifiersChanged(modifiers) => o.modifiers = modifiers.state(),
            WindowEvent::Focused(false) => o.modifiers = winit::keyboard::ModifiersState::empty(),
            WindowEvent::KeyboardInput { event, .. }
                if event.state == ElementState::Pressed && !event.repeat =>
            {
                use winit::keyboard::{Key, NamedKey};
                if event.logical_key == Key::Named(NamedKey::Escape) {
                    self.cancel();
                } else if o.rect.is_some()
                    && !o.dragging
                    && o.modifiers == winit::keyboard::ModifiersState::CONTROL
                {
                    if let Key::Character(key) = &event.logical_key {
                        match key.to_lowercase().as_str() {
                            "c" => self.finish(index, "copy"),
                            "s" => self.finish(index, "save"),
                            "t" => self.finish(index, "ocr"),
                            _ => {}
                        }
                    }
                }
            }
            WindowEvent::CursorMoved { position, .. } => {
                o.cursor = (
                    position.x.max(0.0).min(o.frame.image.width() as f64) as u32,
                    position.y.max(0.0).min(o.frame.image.height() as f64) as u32,
                );
                if o.dragging {
                    if let Some((ax, ay)) = o.anchor {
                        let (mut x, mut y) = o.cursor;
                        let (mut ax, mut ay) = (ax, ay);
                        if let Some((edge, [rx, ry, rw, rh])) = o.resize_edge {
                            if edge == 1 || edge == 5 {
                                ax = rx;
                                x = rx + rw;
                            }
                            if edge == 3 || edge == 7 {
                                ay = ry;
                                y = ry + rh;
                            }
                        }
                        let w = x.abs_diff(ax);
                        let h = y.abs_diff(ay);
                        o.rect = if w > 0 && h > 0 {
                            Some([x.min(ax), y.min(ay), w, h])
                        } else {
                            None
                        };
                    }
                }
                o.window.request_redraw();
                o.update_cursor();
            }
            WindowEvent::MouseInput { state, button, .. } => {
                if button == MouseButton::Right {
                    self.cancel();
                    return;
                }
                if button != MouseButton::Left {
                    return;
                }
                if state == ElementState::Pressed {
                    o.window.focus_window();
                    if let Some(button) = o.button_at_cursor() {
                        o.pressed = Some(button);
                        o.window.request_redraw();
                    } else if let Some(handle) = o.handle_at_cursor() {
                        let points = o.handles();
                        o.anchor = Some(points[(handle + 4) % 8]);
                        o.dragging = true;
                        // Edge handles keep the other axis fixed.
                        o.resize_edge = Some((handle, o.rect.unwrap()));
                    } else if o.rect.is_some_and(|[x, y, w, h]| {
                        o.cursor.0 > x && o.cursor.0 < x + w && o.cursor.1 > y && o.cursor.1 < y + h
                    }) {
                        let now = std::time::Instant::now();
                        if o.last_click.is_some_and(|(t, p)| {
                            now.duration_since(t).as_millis() < 500
                                && p.0.abs_diff(o.cursor.0) < 5
                                && p.1.abs_diff(o.cursor.1) < 5
                        }) {
                            self.finish(index, "copy");
                            return;
                        }
                        o.last_click = Some((now, o.cursor));
                    } else {
                        o.anchor = Some(o.cursor);
                        o.rect = None;
                        o.dragging = true;
                        o.resize_edge = None;
                        o.last_click = None;
                        o.window.request_redraw();
                    }
                } else {
                    if let Some(button) = o.pressed.take() {
                        if o.button_at_cursor() == Some(button) {
                            match button {
                                0 => self.finish(index, "ocr"),
                                1 => self.finish(index, "copy"),
                                2 => self.finish(index, "save"),
                                _ => self.cancel(),
                            }
                            return;
                        }
                    }
                    o.dragging = false;
                    o.update_cursor();
                    o.window.request_redraw();
                }
            }
            WindowEvent::RedrawRequested => {
                if let Err(error) = o.paint() {
                    self.cancel();
                    capture_cmds::report_error(&self.app, error);
                }
            }
            _ => {}
        }
    }
}
pub(crate) fn init(app: tauri::AppHandle) -> Result<(), String> {
    // Load a CJK font once, before the first screenshot, keeping font I/O off the hot path.
    let font = [
        "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/simhei.ttf",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/System/Library/Fonts/PingFang.ttc",
    ]
    .iter()
    .find_map(|path| {
        std::fs::read(path)
            .ok()
            .and_then(|bytes| FontArc::try_from_vec(bytes).ok())
    })
    .ok_or("无法加载中文字体")?;
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("native-capture".into())
        .spawn(move || {
            #[cfg(target_os = "windows")]
            if let Err(error) = native::enable_per_monitor_dpi() {
                let _ = sender.send(Err(error));
                return;
            }
            let mut builder = EventLoop::<Message>::with_user_event();
            #[cfg(target_os = "windows")]
            {
                use winit::platform::windows::EventLoopBuilderExtWindows;
                builder.with_any_thread(true);
            }
            #[cfg(target_os = "linux")]
            {
                use winit::platform::x11::EventLoopBuilderExtX11;
                builder.with_any_thread(true);
            }
            match builder.build() {
                Ok(event_loop) => {
                    let _ = app
                        .state::<CaptureState>()
                        .proxy
                        .set(event_loop.create_proxy());
                    let _ = sender.send(Ok(()));
                    let mut handler = CaptureApp {
                        app: app.clone(),
                        overlays: Vec::new(),
                        font: Rc::new(font),
                        pin: None,
                    };
                    if let Err(error) = event_loop.run_app(&mut handler) {
                        capture_cmds::report_error(&app, error.to_string());
                    }
                }
                Err(error) => {
                    let _ = sender.send(Err(error.to_string()));
                }
            }
        })
        .map_err(|e| e.to_string())?;
    receiver.recv().map_err(|e| e.to_string())?
}

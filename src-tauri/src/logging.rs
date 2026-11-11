use chrono::Local;
use std::{
    fs::{File, OpenOptions},
    io::{self, Write},
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

const MAX_BYTES: u64 = 10 * 1024 * 1024;
static LOGGER: OnceLock<Logger> = OnceLock::new();

struct Output {
    day: String,
    file: Option<File>,
    bytes: u64,
    sequence: u64,
}

struct Logger {
    root: PathBuf,
    session: String,
    rust: Mutex<Output>,
    console: Mutex<Output>,
}

impl Logger {
    fn write(&self, console: bool, level: &str, target: &str, message: &str) -> io::Result<()> {
        let now = Local::now();
        let day = now.format("%Y-%m-%d").to_string();
        let line = format!(
            "{} [{level}] [{target}] {}\n",
            now.to_rfc3339(),
            message.replace('\r', "\\r").replace('\n', "\\n")
        );
        let mut output = (if console { &self.console } else { &self.rust })
            .lock()
            .map_err(|_| io::Error::other("Log lock poisoned"))?;
        if output.file.is_none()
            || output.day != day
            || output.bytes + line.len() as u64 > MAX_BYTES
        {
            let directory = self.root.join(&day);
            std::fs::create_dir_all(&directory)?;
            let file = loop {
                output.sequence += 1;
                let path = directory.join(format!(
                    "{}-{}-{:04}.log",
                    if console { "console" } else { "rust" },
                    self.session,
                    output.sequence
                ));
                match OpenOptions::new().write(true).create_new(true).open(path) {
                    Ok(file) => break file,
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(error) => return Err(error),
                }
            };
            output.file = Some(file);
            output.day = day;
            output.bytes = 0;
        }
        let file = output.file.as_mut().unwrap();
        file.write_all(line.as_bytes())?;
        file.flush()?;
        output.bytes += line.len() as u64;
        Ok(())
    }
}

impl log::Log for Logger {
    fn enabled(&self, _: &log::Metadata<'_>) -> bool {
        true
    }
    fn log(&self, record: &log::Record<'_>) {
        if let Err(error) = self.write(
            false,
            record.level().as_str(),
            record.target(),
            &record.args().to_string(),
        ) {
            eprintln!("Cannot write Rust log: {error}");
        }
    }
    fn flush(&self) {}
}

pub fn init() -> Result<(), Box<dyn std::error::Error>> {
    let root = dirs::home_dir()
        .ok_or("Cannot find home directory")?
        .join(".nexus/logs");
    std::fs::create_dir_all(&root)?;
    let output = || {
        Mutex::new(Output {
            day: String::new(),
            file: None,
            bytes: 0,
            sequence: 0,
        })
    };
    let logger = LOGGER.get_or_init(|| Logger {
        root,
        session: format!(
            "{}-{}",
            Local::now().format("%H%M%S-%f"),
            std::process::id()
        ),
        rust: output(),
        console: output(),
    });
    logger.write(false, "INFO", "app", "Application starting")?;
    log::set_logger(logger)?;
    log::set_max_level(log::LevelFilter::Info);
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::error!(target: "panic", "{info}");
        previous(info);
    }));
    Ok(())
}

#[derive(serde::Deserialize)]
pub struct ConsoleEntry {
    level: String,
    message: String,
}

#[tauri::command]
pub fn write_console_logs(entries: Vec<ConsoleEntry>) -> Result<(), String> {
    let logger = LOGGER.get().ok_or("Logger is not initialized")?;
    for entry in entries.into_iter().take(100) {
        let level = match entry.level.as_str() {
            "debug" => "DEBUG",
            "info" => "INFO",
            "warn" => "WARN",
            "error" => "ERROR",
            _ => "LOG",
        };
        logger
            .write(true, level, "webview", &entry.message)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn separates_sources_and_rotates_without_overwriting() {
        let root = std::env::temp_dir().join(format!(
            "nexusdesk-logs-{}-{}",
            std::process::id(),
            Local::now().timestamp_nanos_opt().unwrap()
        ));
        let output = || {
            Mutex::new(Output {
                day: String::new(),
                file: None,
                bytes: 0,
                sequence: 0,
            })
        };
        let logger = Logger {
            root: root.clone(),
            session: "test".into(),
            rust: output(),
            console: output(),
        };
        logger.write(false, "INFO", "test", "first").unwrap();
        logger
            .write(true, "ERROR", "webview", "console failure")
            .unwrap();
        logger.rust.lock().unwrap().bytes = MAX_BYTES;
        logger.write(false, "WARN", "test", "second").unwrap();
        logger.rust.lock().unwrap().day = "previous-day".into();
        logger.write(false, "INFO", "test", "third").unwrap();
        let day = root.join(Local::now().format("%Y-%m-%d").to_string());
        assert_eq!(std::fs::read_dir(&day).unwrap().count(), 4);
        assert!(
            std::fs::read_to_string(day.join("rust-test-0001.log"))
                .unwrap()
                .contains("first")
        );
        assert!(
            std::fs::read_to_string(day.join("rust-test-0002.log"))
                .unwrap()
                .contains("second")
        );
        assert!(
            std::fs::read_to_string(day.join("console-test-0001.log"))
                .unwrap()
                .contains("console failure")
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}

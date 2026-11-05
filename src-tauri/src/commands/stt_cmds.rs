use serde::Serialize;
use sherpa_onnx::{OfflineRecognizer, OfflineRecognizerConfig, OfflineSenseVoiceModelConfig};
use std::path::{Path, PathBuf};
use std::sync::{
    Mutex, OnceLock,
    atomic::{AtomicU64, Ordering},
};
use tauri::Manager;

const MODEL_ID: &str = "sensevoice-small";
const MODEL_REVISION: &str = "2365baeacb507f821a0c8120fcee3d484dba7a07";
const MODEL_FILES: &[(&str, u64)] = &[("model.int8.onnx", 239_233_841), ("tokens.txt", 315_894)];
const SAMPLE_RATE: usize = 16_000;
static CANCEL_GENERATION: AtomicU64 = AtomicU64::new(0);
static ENGINE: Mutex<Option<Engine>> = Mutex::new(None);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SttRuntime {
    backend: String,
    device: String,
    threads: i32,
    reason: Option<String>,
}

#[derive(Serialize)]
pub struct SttTranscription {
    text: String,
    runtime: SttRuntime,
}

struct Engine {
    path: PathBuf,
    language: String,
    recognizer: OfflineRecognizer,
    runtime: SttRuntime,
}

fn normalize_language(language: Option<&str>) -> Result<&str, String> {
    match language.unwrap_or("") {
        "" | "auto" => Ok("auto"),
        value @ ("zh" | "en" | "ja" | "ko" | "yue") => Ok(value),
        _ => Err("SenseVoice 不支持此识别语言".into()),
    }
}

fn model_ready(path: &Path) -> bool {
    MODEL_FILES.iter().all(|(name, size)| {
        path.join(name)
            .metadata()
            .is_ok_and(|metadata| metadata.is_file() && metadata.len() == *size)
    })
}

fn load_engine(path: PathBuf, language: &str) -> Result<Engine, String> {
    if !model_ready(&path) {
        return Err("SenseVoice 模型文件不完整，请重新下载".into());
    }
    let threads = std::thread::available_parallelism()
        .map_or(2, |count| (count.get() / 2).clamp(1, 4)) as i32;
    let mut config = OfflineRecognizerConfig::default();
    config.model_config.sense_voice = OfflineSenseVoiceModelConfig {
        model: Some(
            path.join("model.int8.onnx")
                .to_str()
                .ok_or("模型路径不是 UTF-8")?
                .into(),
        ),
        language: Some(language.into()),
        use_itn: true,
    };
    config.model_config.tokens = Some(
        path.join("tokens.txt")
            .to_str()
            .ok_or("词表路径不是 UTF-8")?
            .into(),
    );
    config.model_config.num_threads = threads;
    config.model_config.provider = Some("cpu".into());
    config.model_config.model_type = Some("sense_voice".into());
    config.decoding_method = Some("greedy_search".into());
    let recognizer = OfflineRecognizer::create(&config)
        .ok_or("无法加载 SenseVoice 模型，请检查模型和词表文件")?;
    Ok(Engine {
        path,
        language: language.into(),
        recognizer,
        runtime: SttRuntime {
            backend: "cpu".into(),
            device: "CPU".into(),
            threads,
            reason: None,
        },
    })
}

fn engine_for<'a>(
    cache: &'a mut Option<Engine>,
    path: PathBuf,
    language: &str,
) -> Result<&'a mut Engine, String> {
    if !cache
        .as_ref()
        .is_some_and(|engine| engine.path == path && engine.language == language)
    {
        // 先释放旧模型，避免切换语言时同时占用两份模型内存。
        *cache = None;
        *cache = Some(load_engine(path, language)?);
    }
    cache.as_mut().ok_or_else(|| "识别引擎未就绪".into())
}

#[tauri::command]
pub async fn stt_prepare(
    app: tauri::AppHandle,
    model: String,
    language: Option<String>,
) -> Result<SttRuntime, String> {
    let path = model_path(&app, &model)?;
    let language = normalize_language(language.as_deref())?.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        // 等待上一段推理结束，避免关闭后立即重开时出现忙碌错误。
        let mut cache = ENGINE.lock().map_err(|_| "语音识别引擎状态不可用")?;
        Ok(engine_for(&mut cache, path, &language)?.runtime.clone())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn stt_cancel() {
    CANCEL_GENERATION.fetch_add(1, Ordering::SeqCst);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SttModelStatus {
    model: String,
    ready: bool,
    path: String,
}

fn model_path(app: &tauri::AppHandle, model: &str) -> Result<PathBuf, String> {
    if model != MODEL_ID {
        return Err("不支持的 SenseVoice 模型".into());
    }
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("models")
        .join(MODEL_ID)
        .join(MODEL_REVISION))
}

#[tauri::command]
pub fn stt_model_status(app: tauri::AppHandle, model: String) -> Result<SttModelStatus, String> {
    let path = model_path(&app, &model)?;
    Ok(SttModelStatus {
        model,
        ready: model_ready(&path),
        path: path.to_string_lossy().into_owned(),
    })
}

async fn download_file(
    client: &reqwest::Client,
    root: &Path,
    name: &str,
    size: u64,
) -> Result<(), String> {
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    let path = root.join(name);
    if path
        .metadata()
        .is_ok_and(|metadata| metadata.is_file() && metadata.len() == size)
    {
        return Ok(());
    }
    let url = format!(
        "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/{MODEL_REVISION}/{name}"
    );
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?;
    let expected = response.content_length();
    let temporary = path.with_extension("partial");
    let result = async {
        let mut file = tokio::fs::File::create(&temporary)
            .await
            .map_err(|error| error.to_string())?;
        let mut stream = response.bytes_stream();
        let mut downloaded = 0_u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| error.to_string())?;
            file.write_all(&chunk)
                .await
                .map_err(|error| error.to_string())?;
            downloaded += chunk.len() as u64;
        }
        if downloaded != size || expected.is_some_and(|length| length != downloaded) {
            return Err("SenseVoice 模型下载不完整，请重试".into());
        }
        file.sync_all().await.map_err(|error| error.to_string())?;
        drop(file);
        // Windows 重命名不覆盖已有文件，先移除不完整的旧文件。
        if path.exists() {
            tokio::fs::remove_file(&path)
                .await
                .map_err(|error| error.to_string())?;
        }
        tokio::fs::rename(&temporary, &path)
            .await
            .map_err(|error| error.to_string())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    result
}

#[tauri::command]
pub async fn stt_download_model(app: tauri::AppHandle, model: String) -> Result<(), String> {
    let path = model_path(&app, &model)?;
    static DOWNLOAD_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    let _guard = DOWNLOAD_LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    if model_ready(&path) {
        return Ok(());
    }
    tokio::fs::create_dir_all(&path)
        .await
        .map_err(|error| error.to_string())?;
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(1800))
        .build()
        .map_err(|error| error.to_string())?;
    for (name, size) in MODEL_FILES {
        download_file(&client, &path, name, *size)
            .await
            .map_err(|error| format!("下载 {name} 失败：{error}"))?;
    }
    Ok(())
}

fn validate_samples(samples: &[f32]) -> Result<(), String> {
    if samples.is_empty()
        || samples.len() > SAMPLE_RATE * 12
        || samples.iter().any(|sample| !sample.is_finite())
    {
        return Err("音频必须为 16 kHz 单声道有限数值，且长度不超过 12 秒".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn stt_transcribe(
    app: tauri::AppHandle,
    model: String,
    samples: Vec<f32>,
    filter_noise: Option<bool>,
    language: Option<String>,
    request_id: Option<String>,
) -> Result<SttTranscription, String> {
    let request_id = request_id.unwrap_or_else(|| "unknown".to_owned());
    let rms = (samples.iter().map(|sample| sample * sample).sum::<f32>()
        / samples.len().max(1) as f32)
        .sqrt();
    log::info!(target: "speech", "recognize-start request_id={request_id} samples={} rms={rms:.5} model={model}", samples.len());
    validate_samples(&samples)?;
    let path = model_path(&app, &model)?;
    let language = normalize_language(language.as_deref())?.to_owned();
    let generation = CANCEL_GENERATION.load(Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || {
        let mut cache = ENGINE.lock().map_err(|_| "语音识别引擎状态不可用")?;
        check_cancelled(generation)?;
        let engine = engine_for(&mut cache, path, &language)?;
        let filter_noise = filter_noise.unwrap_or(true);
        let rms = (samples.iter().map(|sample| sample * sample).sum::<f32>()
            / samples.len() as f32)
            .sqrt();
        let text = if filter_noise && rms < 0.008 {
            String::new()
        } else {
            transcribe(engine, &samples, generation)?
        };
        check_cancelled(generation)?;
        let text = filter_transcription(&text, filter_noise);
        let mut hash = 2166136261u32;
        for byte in text.as_bytes() { hash = hash.wrapping_mul(16777619) ^ u32::from(*byte); }
        log::info!(target: "speech", "recognize-result request_id={request_id} text_length={} text_hash={hash:08x}", text.len());
        Ok(SttTranscription {
            text,
            runtime: engine.runtime.clone(),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

fn check_cancelled(generation: u64) -> Result<(), String> {
    if CANCEL_GENERATION.load(Ordering::SeqCst) != generation {
        return Err("识别已取消".into());
    }
    Ok(())
}

fn transcribe(engine: &Engine, samples: &[f32], generation: u64) -> Result<String, String> {
    check_cancelled(generation)?;
    let stream = engine.recognizer.create_stream();
    stream.accept_waveform(SAMPLE_RATE as i32, samples);
    // sherpa-onnx 的离线推理没有中断接口，取消后的结果必须丢弃。
    engine.recognizer.decode(&stream);
    check_cancelled(generation)?;
    stream
        .get_result()
        .map(|result| result.text)
        .ok_or_else(|| "SenseVoice 未返回识别结果".into())
}

fn filter_transcription(text: &str, filter_noise: bool) -> String {
    static TAGS: OnceLock<regex::Regex> = OnceLock::new();
    let text = TAGS
        .get_or_init(|| regex::Regex::new(r"<\|[^|<>]*\|>").expect("valid SenseVoice tag pattern"))
        .replace_all(text, "");
    if !filter_noise {
        return text.trim().to_string();
    }
    // 只移除已知的声音标记，保留正常的括号文字。
    static NOISE: OnceLock<regex::Regex> = OnceLock::new();
    let noise = NOISE.get_or_init(|| {
        regex::Regex::new(
            r"(?i)[\[\(（【]\s*(?:blank[ _-]*audio|no[ _-]*speech|silence|silent|motor|engine|music|background[ _-]*(?:music|noise)|noise|applause|clapping|laughter|laughing|inaudible|拍摄|拍攝|攝影|字幕\s*[:：]?[^\]）】)]*|翻译\s*[:：]?[^\]）】)]*|后期|静音|无声|空白音频|杂音|噪音|背景噪音|音乐|背景音乐|掌声|笑声|马达声|引擎声)[^\]）】)]*[\]\)）】]",
        )
        .expect("valid noise annotation pattern")
    });
    if !noise.is_match(&text) {
        return text.trim().to_string();
    }
    let filtered = noise.replace_all(&text, "");
    static SPACES: OnceLock<regex::Regex> = OnceLock::new();
    SPACES
        .get_or_init(|| regex::Regex::new(r"[ \t]{2,}").expect("valid whitespace pattern"))
        .replace_all(&filtered, " ")
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noise_annotations_are_filtered_without_losing_speech() {
        assert_eq!(
            filter_transcription("[Motor] [BLANK_AUDIO] [BLANK_AUDIO] [BLANK_AUDIO]", true),
            ""
        );
        assert_eq!(
            filter_transcription("你好[Motor]，世界。 [BLANK_AUDIO]", true),
            "你好，世界。"
        );
        assert_eq!(
            filter_transcription("Hello [music] [APPLAUSE] world", true),
            "Hello world"
        );
        assert_eq!(
            filter_transcription("[ blank_audio ] [背景噪音] [no speech]", true),
            ""
        );
        assert_eq!(
            filter_transcription("保留[项目名称]和正常文字", true),
            "保留[项目名称]和正常文字"
        );
        assert_eq!(filter_transcription("(拍攝) (字幕:J Chong)", true), "");
        assert_eq!(
            filter_transcription("正常文字（字幕：某某）继续", true),
            "正常文字继续"
        );
        assert_eq!(
            filter_transcription("[Motor] [BLANK_AUDIO]", false),
            "[Motor] [BLANK_AUDIO]"
        );
    }

    #[test]
    fn sensevoice_tags_are_hidden_even_without_noise_filtering() {
        let text = "<|zh|><|NEUTRAL|><|Speech|><|withitn|>你好，世界。";
        assert_eq!(filter_transcription(text, true), "你好，世界。");
        assert_eq!(filter_transcription(text, false), "你好，世界。");
        assert_eq!(filter_transcription("<|nospeech|><|Event_UNK|>", true), "");
    }

    #[test]
    fn validates_audio_and_supported_languages() {
        assert!(validate_samples(&[]).is_err());
        assert!(validate_samples(&[f32::NAN]).is_err());
        assert!(validate_samples(&[f32::INFINITY]).is_err());
        assert!(validate_samples(&vec![0.0; SAMPLE_RATE * 12 + 1]).is_err());
        assert!(validate_samples(&vec![0.0; SAMPLE_RATE * 12]).is_ok());
        assert_eq!(normalize_language(None).unwrap(), "auto");
        assert_eq!(normalize_language(Some("yue")).unwrap(), "yue");
        assert!(normalize_language(Some("fr")).is_err());
    }

    // 手动集成验证：模型目录和 16 kHz 单声道小端 float32 音频。
    #[test]
    #[ignore = "requires NEXUSDESK_STT_MODEL and NEXUSDESK_STT_AUDIO"]
    fn hardware_transcription() {
        let path = PathBuf::from(std::env::var("NEXUSDESK_STT_MODEL").unwrap());
        let bytes = std::fs::read(std::env::var("NEXUSDESK_STT_AUDIO").unwrap()).unwrap();
        assert_eq!(bytes.len() % 4, 0);
        let samples: Vec<f32> = bytes
            .chunks_exact(4)
            .map(|bytes| f32::from_le_bytes(bytes.try_into().unwrap()))
            .collect();
        let engine = load_engine(path, "auto").unwrap();
        let generation = CANCEL_GENERATION.load(Ordering::SeqCst);
        for _ in 0..2 {
            let text = transcribe(&engine, &samples, generation).unwrap();
            eprintln!("{text}");
            assert!(!text.trim().is_empty());
            if let Ok(expected) = std::env::var("NEXUSDESK_STT_EXPECT") {
                assert!(
                    text.to_lowercase().contains(&expected.to_lowercase()),
                    "{text}"
                );
            }
        }
        assert!(transcribe(&engine, &samples, generation.wrapping_add(1)).is_err());
    }
}

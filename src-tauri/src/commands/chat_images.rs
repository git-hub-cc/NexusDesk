use base64::{Engine, prelude::BASE64_STANDARD};
use serde::{Deserialize, Serialize};
use std::time::Duration;

const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

#[derive(Deserialize, Serialize)]
pub struct ChatImage {
    name: String,
    url: String,
}

#[derive(Default, Deserialize)]
pub struct ImageOverrides {
    api: Option<String>,
    key: Option<String>,
    model: Option<String>,
}

fn image_endpoint(base: &str, editing: bool) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(base).map_err(|_| "图片 API 地址无效")?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("图片 API 地址必须是 HTTP 或 HTTPS URL".into());
    }
    let path = url.path().trim_end_matches('/');
    let base = [
        "/images/generations",
        "/images/edits",
        "/chat/completions",
        "/responses",
    ]
    .iter()
    .find_map(|suffix| path.strip_suffix(suffix))
    .unwrap_or(path);
    let operation = if editing { "edits" } else { "generations" };
    url.set_path(&format!("{base}/images/{operation}"));
    Ok(url)
}

fn parse_images(payload: serde_json::Value) -> Result<Vec<ChatImage>, String> {
    let data = payload
        .get("data")
        .and_then(|value| value.as_array())
        .ok_or("图片接口响应格式无效")?;
    let images: Vec<_> = data
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            let url = item
                .get("b64_json")
                .and_then(|value| value.as_str())
                .filter(|value| !value.is_empty())
                .map(|value| format!("data:image/png;base64,{value}"))
                .or_else(|| {
                    item.get("url")
                        .and_then(|value| value.as_str())
                        .filter(|value| {
                            value.starts_with("https://") || value.starts_with("http://")
                        })
                        .map(str::to_owned)
                })?;
            Some(ChatImage {
                name: format!("生成图片-{}.png", index + 1),
                url,
            })
        })
        .collect();
    if images.is_empty() {
        return Err("图片接口未返回有效图片".into());
    }
    Ok(images)
}

async fn image_part(
    client: &reqwest::Client,
    image: ChatImage,
) -> Result<reqwest::multipart::Part, String> {
    let (bytes, mime) = if let Some(data) = image.url.strip_prefix("data:") {
        let (mime, encoded) = data.split_once(";base64,").ok_or("参考图片格式无效")?;
        if encoded.len() > MAX_IMAGE_BYTES.div_ceil(3) * 4 {
            return Err("参考图片不能超过 20 MB".into());
        }
        (
            BASE64_STANDARD
                .decode(encoded)
                .map_err(|_| "参考图片编码无效")?,
            mime.to_owned(),
        )
    } else {
        let url = reqwest::Url::parse(&image.url).map_err(|_| "参考图片地址无效")?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err("参考图片地址无效".into());
        }
        let mut response = client
            .get(url)
            .send()
            .await
            .map_err(|_| "下载参考图片失败")?
            .error_for_status()
            .map_err(|_| "下载参考图片失败")?;
        let mime = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("image/png")
            .split(';')
            .next()
            .unwrap_or("")
            .to_owned();
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "读取参考图片失败")? {
            if bytes.len() + chunk.len() > MAX_IMAGE_BYTES {
                return Err("参考图片不能超过 20 MB".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        (bytes, mime)
    };
    if bytes.is_empty()
        || bytes.len() > MAX_IMAGE_BYTES
        || !matches!(mime.as_str(), "image/png" | "image/jpeg" | "image/webp")
    {
        return Err("请选择不超过 20 MB 的 PNG、JPEG 或 WebP 图片".into());
    }
    reqwest::multipart::Part::bytes(bytes)
        .file_name(image.name)
        .mime_str(&mime)
        .map_err(|_| "参考图片类型无效".into())
}

#[tauri::command]
pub async fn chat_images(
    prompt: String,
    images: Vec<ChatImage>,
    overrides: ImageOverrides,
    size: String,
) -> Result<Vec<ChatImage>, String> {
    if prompt.trim().is_empty() || prompt.chars().count() > 32_000 {
        return Err("请输入不超过 32000 字的图片描述".into());
    }
    if images.len() > 4 {
        return Err("最多上传 4 张参考图片".into());
    }
    if !matches!(
        size.as_str(),
        "1024x1024" | "1536x1024" | "1024x1536" | "auto"
    ) {
        return Err("图片尺寸无效".into());
    }
    let config = super::codex_settings::api_config().ok();
    let base = overrides
        .api
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| config.as_ref().map(|value| value.base_url.as_str()))
        .ok_or("请设置图片 API 地址")?;
    let model = overrides
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("gpt-image-2.5");
    let key = overrides
        .key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| config.as_ref().and_then(|value| value.api_key.as_deref()));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|_| "无法创建图片请求")?;
    let mut request = client.post(image_endpoint(base, !images.is_empty())?);
    if let Some(key) = key {
        request = request.bearer_auth(key);
    }
    if images.is_empty() {
        request = request.json(&serde_json::json!({"model": model, "prompt": prompt, "size": size, "n": 1, "response_format": "url"}));
    } else {
        let mut form = reqwest::multipart::Form::new()
            .text("model", model.to_owned())
            .text("prompt", prompt)
            .text("size", size)
            .text("n", "1")
            .text("response_format", "url");
        for image in images {
            form = form.part("image", image_part(&client, image).await?);
        }
        request = request.multipart(form);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "图片请求失败，请检查地址和网络，或稍后重试")?;
    let status = response.status();
    if !status.is_success() {
        let detail = response
            .text()
            .await
            .unwrap_or_default()
            .chars()
            .take(300)
            .collect::<String>();
        return Err(format!("图片 API 请求失败（HTTP {status}）：{detail}"));
    }
    let payload = response.json().await.map_err(|_| "图片接口响应格式无效")?;
    parse_images(payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switches_existing_endpoints() {
        for suffix in [
            "",
            "/",
            "/responses",
            "/chat/completions",
            "/images/generations",
            "/images/edits",
        ] {
            let base = format!("https://example.com/v1{suffix}");
            assert_eq!(
                image_endpoint(&base, true).unwrap().as_str(),
                "https://example.com/v1/images/edits"
            );
            assert_eq!(
                image_endpoint(&base, false).unwrap().as_str(),
                "https://example.com/v1/images/generations"
            );
        }
        assert!(image_endpoint("file:///image.png", false).is_err());
    }

    #[test]
    fn accepts_url_and_base64_results() {
        let images = parse_images(serde_json::json!({"data": [{"url": "https://example.com/image.png"}, {"b64_json": "aGVsbG8="}]})).unwrap();
        assert_eq!(images.len(), 2);
        assert!(images[1].url.starts_with("data:image/png;base64,"));
        assert!(parse_images(serde_json::json!({"data": []})).is_err());
        assert!(
            parse_images(serde_json::json!({"data": [{"url": "javascript:alert(1)"}]})).is_err()
        );
    }

    #[tokio::test]
    async fn sends_generation_json_and_multiple_edit_parts() {
        use axum::{Json, Router, body::Bytes, http::HeaderMap, routing::post};
        use std::sync::{Arc, Mutex};

        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let router = Router::new().route(
            "/v1/images/{operation}",
            post(move |headers: HeaderMap, body: Bytes| {
                let captured = captured.clone();
                async move {
                    captured.lock().unwrap().push((headers, body));
                    Json(serde_json::json!({"data": [{"url": "https://example.com/result.png"}]}))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let overrides = || ImageOverrides {
            api: Some(format!("http://{address}/v1/images/generations")),
            key: Some("test-key".into()),
            model: Some("test-image-model".into()),
        };
        let generated = chat_images("生成测试".into(), vec![], overrides(), "1024x1024".into())
            .await
            .unwrap();
        assert_eq!(generated.len(), 1);
        let references = (0..2)
            .map(|index| ChatImage {
                name: format!("reference-{index}.png"),
                url: "data:image/png;base64,aGVsbG8=".into(),
            })
            .collect();
        chat_images(
            "修改测试".into(),
            references,
            overrides(),
            "1024x1024".into(),
        )
        .await
        .unwrap();
        server.abort();

        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].0["authorization"], "Bearer test-key");
        let payload: serde_json::Value = serde_json::from_slice(&requests[0].1).unwrap();
        assert_eq!(payload["model"], "test-image-model");
        assert_eq!(payload["prompt"], "生成测试");
        assert_eq!(payload["response_format"], "url");
        assert!(
            requests[1].0["content-type"]
                .to_str()
                .unwrap()
                .starts_with("multipart/form-data; boundary=")
        );
        let body = String::from_utf8_lossy(&requests[1].1);
        assert_eq!(body.matches("name=\"image\";").count(), 2);
        assert!(body.contains("修改测试"));
        assert!(body.contains("reference-1.png"));
    }
}

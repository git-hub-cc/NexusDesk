use std::path::PathBuf;

fn main() {
    // 图标变化时重新嵌入应用资源。
    println!("cargo:rerun-if-changed=icons");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        prepare_speech_runtime();
    }
    tauri_build::build()
}

fn prepare_speech_runtime() {
    let out_dir = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"));
    let profile_dir = out_dir.ancestors().nth(3).expect("Cargo profile directory");
    let resources =
        PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"))
            .join("resources/stt-runtime");
    std::fs::create_dir_all(&resources).expect("create speech runtime resources");
    let deps = profile_dir.join("deps");
    std::fs::create_dir_all(&deps).expect("create Cargo test directory");
    // 动态库随安装包放到主程序旁，同时为 Cargo 测试提供独立的 DLL 搜索路径。
    for name in [
        "sherpa-onnx-c-api.dll",
        "onnxruntime.dll",
        "onnxruntime_providers_shared.dll",
    ] {
        let source = profile_dir.join(name);
        println!("cargo:rerun-if-changed={}", source.display());
        for destination in [resources.join(name), deps.join(name)] {
            let content = std::fs::read(&source)
                .unwrap_or_else(|error| panic!("read {}: {error}", source.display()));
            if std::fs::read(&destination).ok().as_deref() != Some(content.as_slice()) {
                std::fs::write(&destination, content)
                    .unwrap_or_else(|error| panic!("write {}: {error}", destination.display()));
            }
        }
    }
}

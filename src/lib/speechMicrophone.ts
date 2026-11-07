export async function openSpeechMicrophone(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("当前环境无法访问麦克风，请在桌面应用中使用语音转文字");
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (error) {
    if (!(error instanceof Error)
      || !["NotReadableError", "OverconstrainedError"].includes(error.name)) throw error;
    // 部分 Windows 驱动无法开启音频处理，回退到设备默认配置后由采集流程重采样。
    return navigator.mediaDevices.getUserMedia({ audio: true });
  }
}

export function speechStartupError(error: unknown): string {
  if (error instanceof Error) {
    switch (error.name) {
      case "NotReadableError":
      case "AbortError":
        return "无法启动麦克风。请关闭可能独占麦克风的录音或通话软件，在 Windows 声音设置中确认输入设备可用后重试。";
      case "NotAllowedError":
      case "SecurityError":
        return "无法访问麦克风。请在 Windows 设置 → 隐私和安全性 → 麦克风中允许麦克风访问及桌面应用访问，然后重试。";
      case "NotFoundError":
        return "未找到麦克风。请连接麦克风，并在 Windows 声音设置中选择可用的输入设备后重试。";
      case "OverconstrainedError":
        return "麦克风不支持当前音频配置，请在 Windows 声音设置中检查输入设备后重试。";
    }
  }
  return `启动失败：${String(error)}`;
}

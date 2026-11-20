export async function resumeSpeechAudio(context: AudioContext): Promise<void> {
  if (context.state === "running") return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      context.resume(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("音频引擎未能启动，请点击重试以启用麦克风音频。")), 5000);
      }),
    ]);
    if ((context.state as AudioContextState) !== "running") throw new Error("音频引擎未运行，请点击重试以启用麦克风音频。");
  } finally {
    clearTimeout(timer);
  }
}

export async function listSpeechMicrophones(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter(device => device.kind === "audioinput" && device.deviceId && device.deviceId !== "default" && device.deviceId !== "communications");
}

export async function openSpeechMicrophone(inputDeviceId = ""): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("当前环境无法访问麦克风，请在桌面应用中使用语音转文字");
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(inputDeviceId ? { deviceId: { exact: inputDeviceId } } : {}),
        channelCount: 1,
        // 识别直接使用麦克风原始声音，避免通话降噪把输入抑制为静音。
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
  } catch (error) {
    if (!(error instanceof Error)
      || !["NotReadableError", "OverconstrainedError"].includes(error.name)) throw error;
    // 部分 Windows 驱动无法开启音频处理，回退到设备默认配置后由采集流程重采样。
    return navigator.mediaDevices.getUserMedia({
      audio: inputDeviceId ? { deviceId: { exact: inputDeviceId } } : true,
    });
  }
}

export function speechStartupError(error: unknown, inputDeviceId = ""): string {
  if (error instanceof Error) {
    const constraint = "constraint" in error ? error.constraint : undefined;
    if (inputDeviceId && (error.name === "NotFoundError"
      || (error.name === "OverconstrainedError" && (!constraint || constraint === "deviceId")))) {
      return "已选的麦克风不可用，请在下方重新选择麦克风或切换到系统默认输入设备。";
    }
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

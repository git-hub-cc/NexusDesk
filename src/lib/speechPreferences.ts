import { settingsStorage } from "./globalSettings";

export const speechModels = [
  { id: "sensevoice-small", label: "SenseVoice Small", detail: "本地识别 · INT8 量化" },
];
export const speechLanguages = [
  { id: "", label: "自动检测" }, { id: "zh", label: "中文" },
  { id: "yue", label: "粤语" }, { id: "en", label: "英语" },
  { id: "ja", label: "日语" }, { id: "ko", label: "韩语" },
];
export type SpeechPreferences = {
  model: string;
  filterNoise: boolean;
  language: string;
  minVolume: number;
  minDurationSeconds: number;
  minTextLength: number;
};
export const speechPreferencesKey = "noteide-ui:speech-to-text";

const defaults = {
  minVolume: 0.018,
  minDurationSeconds: 0.5,
  minTextLength: 2,
};

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

export function readSpeechPreferences(): SpeechPreferences {
  try {
    const parsed = JSON.parse(settingsStorage.getItem(speechPreferencesKey) || "null");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        // 旧版 Whisper 模型自动迁移，保留仍受支持的语言与过滤偏好。
        model: "sensevoice-small",
        filterNoise: parsed.filterNoise !== false,
        language: speechLanguages.some(item => item.id === parsed.language) ? parsed.language : "",
        minVolume: boundedNumber(parsed.minVolume, defaults.minVolume, 0.005, 0.1),
        minDurationSeconds: boundedNumber(parsed.minDurationSeconds, defaults.minDurationSeconds, 0.1, 5),
        minTextLength: boundedNumber(parsed.minTextLength, defaults.minTextLength, 1, 20),
      };
    }
  } catch { /* 损坏的配置使用默认值。 */ }
  return { model: "sensevoice-small", filterNoise: true, language: "", ...defaults };
}

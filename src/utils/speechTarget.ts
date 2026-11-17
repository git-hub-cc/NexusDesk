export type SpeechTarget =
  | { kind: "editor"; pane: "left" | "right" }
  | { kind: "terminal" }
  | { kind: "git" };

let activeSpeechTarget: SpeechTarget | null = null;

export function setSpeechTarget(target: SpeechTarget | null) {
  activeSpeechTarget = target;
}

export function getSpeechTarget() {
  return activeSpeechTarget;
}

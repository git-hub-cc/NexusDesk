export type InspectionRecord = Record<string, unknown>;
export const asRecord = (value: unknown): InspectionRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as InspectionRecord)
    : {};

export function decodeJson(source: string): unknown {
  let value: unknown = source;
  for (let layer = 0; layer < 8 && typeof value === "string"; layer++) {
    try {
      value = JSON.parse(value);
    } catch {
      break;
    }
  }
  return value;
}

export type StreamEvent = {
  index: number;
  type: string;
  data: string;
  value: InspectionRecord;
  incomplete: boolean;
};
export function inspectMessage(message: string) {
  let text = message;
  if (!/\r?\n\r?\n/.test(text)) {
    const decoded = decodeJson(text);
    if (typeof decoded === "string") text = decoded;
  }
  const separator = /\r?\n\r?\n/.exec(text);
  const head = separator ? text.slice(0, separator.index) : "";
  const body = separator
    ? text.slice(separator.index + separator[0].length)
    : text;
  const [startLine = "", ...lines] = head.split(/\r?\n/);
  const headers = lines.flatMap((line) => {
    const colon = line.indexOf(":");
    return colon < 0
      ? []
      : [{ name: line.slice(0, colon), value: line.slice(colon + 1).trim() }];
  });
  const isStream =
    headers.some(
      (h) =>
        h.name.toLowerCase() === "content-type" &&
        /text\/event-stream/i.test(h.value),
    ) || /^(?:event|data):/m.test(body);
  const events: StreamEvent[] = [];
  if (isStream) {
    const blocks = body.replace(/\r\n?/g, "\n").split(/\n\n+/);
    for (let i = 0; i < blocks.length; i++) {
      const lines = blocks[i].split("\n");
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) continue;
      const value = asRecord(decodeJson(data));
      const event = lines
        .find((line) => line.startsWith("event:"))
        ?.slice(6)
        .trim();
      events.push({
        index: events.length,
        type:
          event ||
          String(value.type || (data === "[DONE]" ? "done" : "message")),
        data,
        value,
        incomplete:
          i === blocks.length - 1 &&
          !/\n\n$/.test(body.replace(/\r\n?/g, "\n")),
      });
    }
  }
  const json = asRecord(decodeJson(body));
  let response = json;
  for (const event of events) {
    if (event.value.response)
      response = { ...response, ...asRecord(event.value.response) };
  }
  const usage = asRecord(response.usage);
  return { startLine, headers, body, json, isStream, events, response, usage };
}

export type ReadableItem = {
  role: string;
  type: string;
  text: string;
  value: unknown;
};
export function readableItems(value: unknown): ReadableItem[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = asRecord(item);
    const content = record.content;
    const parts = Array.isArray(content)
      ? content
      : Array.isArray(record.summary)
        ? record.summary
        : [];
    const text =
      typeof content === "string"
        ? content
        : parts
            .map((part) => {
              const p = asRecord(part);
              return typeof p.text === "string"
                ? p.text
                : typeof p.refusal === "string"
                  ? p.refusal
                  : JSON.stringify(part, null, 2);
            })
            .join("\n\n") ||
          String(record.arguments ?? record.output ?? record.text ?? "");
    return {
      role: String(record.role || record.name || record.type || "message"),
      type: String(record.type || "message"),
      text,
      value: item,
    };
  });
}

export function responseItems(
  message: ReturnType<typeof inspectMessage>,
): ReadableItem[] {
  const final = readableItems(message.response.output);
  if (final.length) return final;
  // Group deltas by output item and content part so concurrent outputs remain distinct.
  const deltas = new Map<string, ReadableItem>();
  const completed = new Map<string, ReadableItem>();
  for (const event of message.events) {
    if (event.type === "response.output_item.done") {
      const record = asRecord(event.value.item);
      const item = readableItems([record])[0];
      const id = String(record.id ?? event.value.output_index ?? 0);
      completed.set(id, item);
      continue;
    }
    if (
      !/\.(?:delta|done)$/.test(event.type) ||
      !/(?:output_text|refusal|reasoning.*text|function_call_arguments)\./.test(
        event.type,
      )
    )
      continue;
    const key = `${event.value.item_id ?? event.value.output_index ?? 0}/${event.value.content_index ?? event.value.summary_index ?? 0}/${event.type.replace(/\.(delta|done)$/, "")}`;
    const item = deltas.get(key) ?? {
      role: "assistant",
      type: event.type.replace(/\.(delta|done)$/, ""),
      text: "",
      value: {},
    };
    if (typeof event.value.delta === "string") item.text += event.value.delta;
    else if (typeof event.value.text === "string") item.text = event.value.text;
    deltas.set(key, item);
  }
  return [
    ...completed.values(),
    ...[...deltas.entries()]
      .filter(([key]) => !completed.has(key.split("/")[0]))
      .map(([, item]) => item),
  ];
}

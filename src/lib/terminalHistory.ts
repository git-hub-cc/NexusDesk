export const HISTORY_THRESHOLD = 2;
export const HISTORY_LIMIT = 8;

export function matchTerminalHistory(history: string[], input: string) {
  const query = input.trim().toLowerCase();
  if (Array.from(query).length < HISTORY_THRESHOLD) return [];
  return history.flatMap((command, recency) => {
    const text = command.toLowerCase();
    const indices: number[] = [];
    let cursor = 0;
    for (const char of query) {
      const index = text.indexOf(char, cursor);
      if (index < 0) return [];
      indices.push(index);
      cursor = index + char.length;
    }
    const substring = text.indexOf(query);
    if (substring >= 0) indices.splice(0, indices.length, ...Array.from({ length: query.length }, (_, i) => substring + i));
    const rank = text.startsWith(query) ? 0 : substring >= 0 ? 1 : 2;
    const gap = indices[indices.length - 1] - indices[0] - query.length + 1;
    return [{ command, indices, rank, gap, recency }];
  }).sort((a, b) => a.rank - b.rank || a.gap - b.gap || a.recency - b.recency).slice(0, HISTORY_LIMIT);
}

// Only recognize shell prompts, never collect arbitrary interactive program input.
export function terminalPromptInput(line: string): string | undefined {
  const prompt = /^(?:PS [^\r\n]*?> |[A-Za-z]:\\[^\r\n]*?> |[^\r\n]*?[$#%] )/.exec(line);
  return prompt ? line.slice(prompt[0].length) : undefined;
}

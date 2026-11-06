function shellWords(input: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let quote = "";
  let started = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === "\\" && quote !== "'") {
      const next = input[++i];
      if (next === undefined) return null;
      if (next === "\n") continue;
      if (next === "\r" && input[i + 1] === "\n") { i++; continue; }
      if (quote === '"' && !['"', "\\", "$", "`"].includes(next)) word += "\\";
      word += next;
      started = true;
    } else if (quote !== "'" && (char === "`" || (char === "$" && input[i + 1] === "("))) {
      return null;
    } else if (quote) {
      if (char === quote) quote = "";
      else word += char;
      started = true;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) { words.push(word); word = ""; started = false; }
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) return null;
  if (started) words.push(word);
  return words;
}

export function curlToHttp(input: string): string | null {
  const words = shellWords(input.trim());
  if (!words || words[0] !== "curl") return null;
  let url = "";
  let method = "";
  const headers: string[] = [];
  const data: string[] = [];
  let hasData = false;
  for (let i = 1; i < words.length; i++) {
    const arg = words[i];
    const equal = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const option = equal > 0 ? arg.slice(0, equal) : arg;
    const takesValue = ["-X", "--request", "-H", "--header", "-d", "--data", "--data-raw", "--data-binary", "--url"].includes(option);
    if (takesValue) {
      const value = equal > 0 ? arg.slice(equal + 1) : words[++i];
      if (value === undefined) return null;
      if (option === "-X" || option === "--request") method = value;
      else if (option === "-H" || option === "--header") {
        if (!/^[^:\s]+:\s*[^\r\n]*$/.test(value)) return null;
        headers.push(value);
      } else if (option === "--url") {
        if (url) return null;
        url = value;
      } else {
        if (option !== "--data-raw" && value.startsWith("@")) return null;
        hasData = true;
        data.push(value);
      }
    } else if (arg.startsWith("-")) return null;
    else if (url) return null;
    else url = arg;
  }
  if (!/^https?:\/\/\S+$/i.test(url) || (method && !/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|TRACE)$/i.test(method))) return null;
  if (hasData && !headers.some(header => /^content-type\s*:/i.test(header))) headers.push("Content-Type: application/x-www-form-urlencoded");
  const request = [`${(method || (hasData ? "POST" : "GET")).toUpperCase()} ${url}`, ...headers].join("\n");
  return hasData ? `${request}\n\n${data.join("&")}` : request;
}

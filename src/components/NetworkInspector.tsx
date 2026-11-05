import { useMemo, useState } from "react";
import {
  asRecord,
  inspectMessage,
  readableItems,
  responseItems,
  type ReadableItem,
} from "@/lib/networkInspection";
import type { NetworkRequest } from "@/lib/networkMonitor";
import { NetworkMessage } from "./NetworkMessage";

const pretty = (value: unknown) => JSON.stringify(value, null, 2) ?? "";
const buttonClass =
  "rounded px-2 py-1 text-gray-400 transition-colors hover:bg-ide-tab-hover hover:text-white aria-pressed:bg-[#244a80] aria-pressed:text-white aria-pressed:font-medium focus-visible:outline focus-visible:outline-ide-accent";
const inputClass =
  "min-w-0 rounded border border-ide-panel-border bg-ide-bg px-2 py-1 text-xs text-gray-200 outline-none focus:border-ide-accent";
const messageLabels: Record<string, string> = {
  developer: "开发者", system: "系统", user: "用户", assistant: "助手",
  tool: "工具", message: "消息", reasoning: "推理", function_call: "工具调用",
  function_call_output: "工具结果", input_text: "输入文本", output_text: "输出文本",
  "response.output_text": "输出文本", "response.reasoning_summary_text": "推理摘要",
  "response.function_call_arguments": "工具调用参数",
};
const messageLabel = (value: string) => messageLabels[value] ?? value;

function TextContent({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 1600;
  return (
    <>
      <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-gray-200">
        {long && !expanded ? `${text.slice(0, 1600)}…` : text}
      </pre>
      {long && (
        <button
          type="button"
          className={`${buttonClass} mt-2`}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded
            ? "收起长文本"
            : `展开全文（${text.length.toLocaleString()} 字符）`}
        </button>
      )}
    </>
  );
}

function ItemCards({
  items,
  filter = "",
  sticky = false,
}: {
  items: ReadableItem[];
  filter?: string;
  sticky?: boolean;
}) {
  const [role, setRole] = useState("all");
  const roles = [...new Set(items.map((item) => item.role))];
  const visible = items
    .map((item, index) => ({ item, index }))
    .filter(
      ({ item }) =>
        (role === "all" || item.role === role) &&
        `${item.role} ${messageLabel(item.role)} ${item.type} ${messageLabel(item.type)} ${item.text} ${pretty(item.value)}`
          .toLowerCase()
          .includes(filter.toLowerCase()),
    );
  return (
    <div className="space-y-3">
      {!!items.length && (
        <div className={`flex flex-wrap items-center gap-1 bg-ide-bg text-xs ${sticky ? "sticky -top-3 z-10 -mx-3 px-3 pt-3 pb-2" : "py-1"}`}>
          <button
            className={buttonClass}
            type="button"
            aria-pressed={role === "all"}
            onClick={() => setRole("all")}
          >
            全部消息 · {items.length}
          </button>
          {roles.map((value) => (
            <button
              className={buttonClass}
              type="button"
              key={value}
              aria-pressed={role === value}
              onClick={() => setRole(value)}
            >
              {messageLabel(value)} · {items.filter((item) => item.role === value).length}
            </button>
          ))}
        </div>
      )}
      {visible.map(({ item, index }) => (
        <article
          key={index}
          className="rounded border border-ide-panel-border overflow-hidden"
        >
          <div className="flex items-center gap-2 border-b border-ide-panel-border bg-ide-panel-bg px-3 py-2">
            <span className="text-gray-500">#{index + 1}</span>
            <strong
              className={
                item.role === "user"
                  ? "text-blue-300"
                  : item.role === "assistant"
                    ? "text-green-300"
                    : "text-amber-300"
              }
            >
              {messageLabel(item.role)}
            </strong>
            <span className="text-gray-500">{messageLabel(item.type)}</span>
          </div>
          <div className="p-3">
            <TextContent text={item.text || pretty(item.value)} />
            {item.text && (
              <details className="mt-2 text-gray-500">
                <summary className="cursor-pointer">完整消息字段</summary>
                <TextContent text={pretty(item.value)} />
              </details>
            )}
          </div>
        </article>
      ))}
      {!visible.length && <p className="p-3 text-gray-500">没有匹配的消息</p>}
    </div>
  );
}

function Fields({ entries }: { entries: [string, unknown][] }) {
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-5 gap-y-2 text-xs">
      {entries
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([name, value]) => (
          <div className="contents" key={name}>
            <dt className="text-gray-500">{name}</dt>
            <dd className="break-all text-gray-200">
              {typeof value === "object" ? pretty(value) : String(value)}
            </dd>
          </div>
        ))}
    </dl>
  );
}

function MessagePane({
  message,
  label,
  request = false,
  copy,
}: {
  message: string;
  label: string;
  request?: boolean;
  copy: (label: string, text: string) => void;
}) {
  const parsed = useMemo(() => inspectMessage(message), [message]);
  const items = useMemo(
    () =>
      request
        ? readableItems(parsed.json.input ?? parsed.json.messages)
        : responseItems(parsed),
    [parsed, request],
  );
  const [view, setView] = useState("read");
  const [filter, setFilter] = useState("");
  const [eventType, setEventType] = useState("all");
  const [limit, setLimit] = useState(100);
  const eventTypes = [...new Set(parsed.events.map((event) => event.type))];
  const events = parsed.events.filter(
    (event) =>
      (eventType === "all" || event.type === eventType) &&
      `${event.type} ${event.data}`
        .toLowerCase()
        .includes(filter.toLowerCase()),
  );
  const tabs = [
    ["read", "阅读"],
    [
      "body",
      parsed.isStream ? `流式事件 · ${parsed.events.length}` : "正文",
    ],
    ["headers", `报文头 · ${parsed.headers.length}`],
    ["raw", "原始报文"],
  ];
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded border border-ide-panel-border">
      <div className="flex flex-wrap items-center gap-2 border-b border-ide-panel-border bg-ide-panel-bg px-3 py-2 text-xs shrink-0">
        <h3 className="font-semibold mr-auto">{label}</h3>
        <button
          type="button"
          className={buttonClass}
          onClick={() => copy(label, message)}
        >
          复制报文
        </button>
        <button
          type="button"
          className={buttonClass}
          onClick={() =>
            copy(
              `${label}正文`,
              view === "read" && items.length
                ? items
                    .map((item) => item.text || pretty(item.value))
                    .join("\n\n")
                : parsed.body,
            )
          }
        >
          复制正文
        </button>
      </div>
      <div className="flex flex-wrap gap-1 border-b border-ide-panel-border px-2 py-1 text-xs shrink-0">
        {tabs.map(([key, title]) => (
          <button
            type="button"
            className={buttonClass}
            key={key}
            aria-pressed={view === key}
            onClick={() => setView(key)}
          >
            {title}
          </button>
        ))}
      </div>
      {(view === "read" || (view === "body" && parsed.isStream)) && (
        <div className="flex flex-wrap gap-2 border-b border-ide-panel-border p-2 shrink-0">
          <input
            aria-label={`${label}内容搜索`}
            placeholder="搜索消息或事件内容"
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
              setLimit(100);
            }}
            className={`${inputClass} flex-1`}
          />
          {view === "body" && parsed.isStream && (
            <select
              aria-label="事件类型"
              className={`${inputClass} max-w-full`}
              value={eventType}
              onChange={(event) => {
                setEventType(event.target.value);
                setLimit(100);
              }}
            >
              <option value="all">全部事件类型</option>
              {eventTypes.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      {view === "raw" ? (
        <NetworkMessage message={message} label={label} />
      ) : view === "body" && !parsed.isStream ? (
        <NetworkMessage message={message} label={label} formatJson />
      ) : (
        <div
          tabIndex={0}
          aria-label={`${label}${view === "read" ? "阅读" : view === "headers" ? "报文头" : "事件"}`}
          className="ide-content-surface flex-1 min-h-0 overflow-auto bg-ide-bg p-3 text-xs select-text"
        >
          {view === "headers" ? (
            <>
              <pre className="mb-4 whitespace-pre-wrap break-all text-blue-300">
                {parsed.startLine}
              </pre>
              <div className="space-y-2">
                {parsed.headers.map((header, index) => (
                  <div
                    key={index}
                    className="grid grid-cols-[minmax(90px,30%)_minmax(0,1fr)] gap-3 border-b border-ide-panel-border pb-2"
                  >
                    <span className="break-all text-blue-300">
                      {header.name}
                    </span>
                    <span className="whitespace-pre-wrap break-all text-gray-200">
                      {header.value}
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : view === "body" ? (
            <div className="space-y-2">
              <p className="text-gray-500">
                匹配 {events.length} / {parsed.events.length}{" "}
                个事件；点击展开数据
              </p>
              {events.slice(0, limit).map((event) => (
                <details
                  key={event.index}
                  className="rounded border border-ide-panel-border p-2"
                >
                  <summary className="cursor-pointer break-all text-blue-300">
                    #{event.index + 1} · {event.type}
                    {event.value.sequence_number !== undefined &&
                      ` · 序号 ${event.value.sequence_number}`}
                    {event.incomplete && (
                      <span className="text-amber-400"> · 帧尚未结束</span>
                    )}
                  </summary>
                  <div className="mt-2">
                    <TextContent
                      text={
                        Object.keys(event.value).length
                          ? pretty(event.value)
                          : event.data
                      }
                    />
                  </div>
                </details>
              ))}
              {events.length > limit && (
                <button
                  type="button"
                  className={buttonClass}
                  onClick={() => setLimit((value) => value + 100)}
                >
                  显示更多事件（剩余 {events.length - limit}）
                </button>
              )}
              {!events.length && (
                <p className="text-gray-500">没有匹配的事件</p>
              )}
            </div>
          ) : items.length ? (
            <ItemCards items={items} filter={filter} sticky />
          ) : (
            <>
              <p className="mb-3 text-gray-500">
                {parsed.isStream
                  ? "暂未收到可阅读的输出，可切换到流式事件查看详情。"
                  : "正文预览"}
              </p>
              <TextContent
                text={
                  Object.keys(parsed.json).length
                    ? pretty(parsed.json)
                    : parsed.body || "（正文为空）"
                }
              />
            </>
          )}
        </div>
      )}
    </section>
  );
}

export function NetworkInspector({
  item,
  copy,
}: {
  item: NetworkRequest;
  copy: (label: string, text: string) => void;
}) {
  const [tab, setTab] = useState("overview");
  const request = useMemo(
    () => inspectMessage(item.requestMessage),
    [item.requestMessage],
  );
  const response = useMemo(
    () => inspectMessage(item.responseMessage),
    [item.responseMessage],
  );
  const input = useMemo(
    () => readableItems(request.json.input ?? request.json.messages),
    [request],
  );
  const output = useMemo(() => responseItems(response), [response]);
  const usage = response.usage;
  const requestMetadata = asRecord(request.json.client_metadata);
  return (
    <div className="flex flex-1 min-h-0 flex-col gap-3">
      <nav
        aria-label="请求详情视图"
        className="flex gap-1 border-b border-ide-panel-border pb-2 text-xs shrink-0"
      >
        {[
          ["overview", "概览"],
          ["request", "请求"],
          ["response", "响应"],
          ["split", "并排对照"],
        ].map(([key, title]) => (
          <button
            type="button"
            key={key}
            className={buttonClass}
            aria-pressed={tab === key}
            onClick={() => setTab(key)}
          >
            {title}
          </button>
        ))}
      </nav>
      {tab === "overview" ? (
        <div className="flex-1 min-h-0 overflow-auto space-y-4 bg-ide-bg p-4 select-text rounded border border-ide-panel-border">
          <Fields
            entries={[
              ["模型", request.json.model ?? response.response.model],
              [
                "状态",
                response.response.status ??
                  (item.inFlight
                    ? "接收中"
                    : item.failed
                      ? "失败"
                      : item.status),
              ],
              ["开始时间", new Date(item.startedAt).toLocaleString()],
              [
                "耗时",
                item.metricsUnavailable
                  ? "未记录"
                  : `${item.timeMs.toLocaleString()} ms`,
              ],
              ["输入消息", input.length || undefined],
              [
                "流式响应",
                request.json.stream === undefined
                  ? response.isStream
                    ? "是"
                    : undefined
                  : request.json.stream
                    ? "是"
                    : "否",
              ],
              ["推理强度", asRecord(request.json.reasoning).effort],
              [
                "服务等级",
                response.response.service_tier ?? request.json.service_tier,
              ],
              ["响应 ID", response.response.id],
              ["会话 ID", requestMetadata.session_id],
            ]}
          />
          {Object.keys(usage).length > 0 && (
            <section className="border-t border-ide-panel-border pt-4">
              <h3 className="mb-3 text-xs font-semibold">Token 用量</h3>
              <Fields
                entries={[
                  ["输入", usage.input_tokens ?? usage.prompt_tokens],
                  ["输出", usage.output_tokens ?? usage.completion_tokens],
                  ["总计", usage.total_tokens],
                  [
                    "缓存命中",
                    asRecord(usage.input_tokens_details).cached_tokens,
                  ],
                  [
                    "推理",
                    asRecord(usage.output_tokens_details).reasoning_tokens,
                  ],
                ]}
              />
            </section>
          )}
          {!!(
            response.response.error || response.response.incomplete_details
          ) && (
            <section className="border border-amber-500/40 rounded p-3 text-amber-300">
              <h3 className="mb-2 text-xs">异常信息</h3>
              <TextContent
                text={pretty(
                  response.response.error ??
                    response.response.incomplete_details,
                )}
              />
            </section>
          )}
          <section className="border-t border-ide-panel-border pt-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold">响应正文</h3>
              <button
                type="button"
                className={`${buttonClass} text-xs`}
                onClick={() => setTab("response")}
              >
                查看完整响应 →
              </button>
            </div>
            {output.length ? (
              <ItemCards items={output} />
            ) : (
              <p className="text-xs text-gray-500">
                {item.inFlight
                  ? "正在等待输出…"
                  : "没有可提取的消息，请在响应中查看正文或事件。"}
              </p>
            )}
          </section>
          {input.length > 0 && (
            <section className="border-t border-ide-panel-border pt-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold">最近一条用户消息</h3>
                <button
                  type="button"
                  className={`${buttonClass} text-xs`}
                  onClick={() => setTab("request")}
                >
                  浏览全部 {input.length} 条输入 →
                </button>
              </div>
              <TextContent
                text={
                  [...input]
                    .reverse()
                    .find((message) => message.role === "user")?.text ||
                  "没有用户文本消息"
                }
              />
            </section>
          )}
          <details className="text-xs text-gray-500">
            <summary className="cursor-pointer">请求参数</summary>
            <div className="mt-3">
              <Fields
                entries={Object.entries(request.json).filter(
                  ([key]) =>
                    !["input", "messages", "tools", "instructions"].includes(
                      key,
                    ),
                )}
              />
            </div>
          </details>
        </div>
      ) : (
        <div
          className={`grid flex-1 min-h-0 gap-3 ${tab === "split" ? "grid-cols-1 md:grid-cols-2 grid-rows-2 md:grid-rows-1" : "grid-cols-1 grid-rows-1"}`}
        >
          {(tab === "request" || tab === "split") && (
            <MessagePane
              key="request"
              message={item.requestMessage}
              label="请求报文"
              request
              copy={copy}
            />
          )}
          {(tab === "response" || tab === "split") && (
            <MessagePane
              key="response"
              message={item.responseMessage}
              label="响应报文"
              copy={copy}
            />
          )}
        </div>
      )}
    </div>
  );
}

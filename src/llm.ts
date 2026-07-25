import { Agent } from "undici";
import { config } from "./config.js";

/**
 * ローカルLLMは生成に数分かかることがあり、undiciのデフォルトheadersTimeout(5分)を
 * 超えると HeadersTimeoutError で失敗するため、長めのタイムアウトを設定したdispatcherを使う。
 */
const dispatcher = new Agent({
  headersTimeout: 10 * 60 * 1000,
  bodyTimeout: 10 * 60 * 1000,
});

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** ツール名と引数(JSONパース済み)を受け取り、結果テキストを返す関数。 */
export type ToolExecutor = (name: string, args: unknown) => Promise<string>;

interface ResponseMessage {
  content?: string | null;
  tool_calls?: ToolCall[];
}

interface ChatCompletionChoice {
  message?: ResponseMessage;
}

interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
}

/**
 * LMStudio/llama.cppサーバーはスロット間でKVキャッシュを共有しているため、
 * リクエストを同時に送るとキャッシュ枯渇でコンテキスト超過エラーになる。
 * そのため呼び出しを1件ずつ直列化するキューを介す。
 */
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task, task);
  queue = result.catch(() => undefined);
  return result;
}

/**
 * OpenAI互換の /chat/completions を1回叩き、message オブジェクトを返す低レベル関数。
 * キューには入れない(呼び出し側でenqueueすること)。
 */
async function postChat(
  messages: ChatMessage[],
  tools?: ToolDefinition[],
  maxTokens?: number
): Promise<ResponseMessage> {
  const url = `${config.llmBaseUrl}/chat/completions`;

  const body: Record<string, unknown> = {
    model: config.llmModel,
    messages,
    stream: false,
    max_tokens: maxTokens ?? config.maxTokens,
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.llmApiKey}`,
    },
    body: JSON.stringify(body),
    dispatcher,
  } as RequestInit & { dispatcher: Agent });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => "");
    throw new Error(`LLM呼び出しに失敗しました (status=${res.status}): ${errorBody}`);
  }

  const bodyText = await res.text();
  console.log("[llm] 生レスポンス:", bodyText);

  const data = JSON.parse(bodyText) as ChatCompletionResponse;
  const message = data.choices?.[0]?.message;
  if (!message) {
    throw new Error("LLMから応答メッセージが返されませんでした。");
  }
  return message;
}

/**
 * ツールなし・非ストリーミングの単発補完。要約など内部処理用。
 * 応答が空なら空文字を返す(呼び出し側で扱う)。
 */
export async function completeOnce(
  messages: ChatMessage[],
  maxTokens?: number
): Promise<string> {
  return enqueue(async () => {
    const message = await postChat(messages, undefined, maxTokens);
    return message.content?.trim() ?? "";
  });
}

/** content の増分(delta)を逐次受け取るコールバック。 */
export type ContentHandler = (delta: string) => void;

/** 進捗ステータス(思考中・ツール実行)の通知イベント。 */
export type StatusEvent =
  | { kind: "thinking" }
  | { kind: "tool"; name: string; args: unknown };
export type StatusHandler = (event: StatusEvent) => void;

interface StreamRoundResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
}

/** ストリーミングのtool_call組み立て用(index毎に断片を連結する)。 */
interface PartialToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * /chat/completions を stream:true で1回叩き、content の delta を onContent へ流しつつ、
 * このラウンドの content 全体・組み立てたtool_calls・finish_reason を返す。
 * キューには入れない(呼び出し側でenqueueすること)。
 */
async function streamRound(
  messages: ChatMessage[],
  tools: ToolDefinition[] | undefined,
  onContent: ContentHandler,
  onStatus?: StatusHandler
): Promise<StreamRoundResult> {
  const url = `${config.llmBaseUrl}/chat/completions`;

  const body: Record<string, unknown> = {
    model: config.llmModel,
    messages,
    stream: true,
    max_tokens: config.maxTokens,
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.llmApiKey}`,
    },
    body: JSON.stringify(body),
    dispatcher,
  } as RequestInit & { dispatcher: Agent });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => "");
    throw new Error(`LLM呼び出しに失敗しました (status=${res.status}): ${errorBody}`);
  }
  if (!res.body) {
    throw new Error("LLMからストリーム応答が返されませんでした。");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";
  let content = "";
  const toolMap = new Map<number, PartialToolCall>();
  let finishReason: string | null = null;
  let thinkingNotified = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    sseBuffer += decoder.decode(value, { stream: true });

    const lines = sseBuffer.split("\n");
    sseBuffer = lines.pop() ?? ""; // 行またぎの断片は次回へ持ち越す

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;

      let json: unknown;
      try {
        json = JSON.parse(payload);
      } catch {
        continue; // 不完全/非JSONのdataは無視
      }

      const choice = (json as { choices?: unknown[] }).choices?.[0] as
        | {
            delta?: { content?: unknown; reasoning_content?: unknown; tool_calls?: unknown };
            finish_reason?: unknown;
          }
        | undefined;
      const delta = choice?.delta;

      // 思考(reasoning_content)が始まったら一度だけ「思考中」を通知する
      if (
        !thinkingNotified &&
        typeof delta?.reasoning_content === "string" &&
        delta.reasoning_content.length > 0
      ) {
        thinkingNotified = true;
        onStatus?.({ kind: "thinking" });
      }

      if (typeof delta?.content === "string" && delta.content.length > 0) {
        content += delta.content;
        onContent(delta.content);
      }

      if (Array.isArray(delta?.tool_calls)) {
        for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
          const index = typeof tc.index === "number" ? tc.index : 0;
          const fn = tc.function as { name?: unknown; arguments?: unknown } | undefined;
          const cur = toolMap.get(index) ?? { id: "", name: "", arguments: "" };
          if (typeof tc.id === "string") cur.id = tc.id;
          if (typeof fn?.name === "string") cur.name = fn.name;
          if (typeof fn?.arguments === "string") cur.arguments += fn.arguments;
          toolMap.set(index, cur);
        }
      }

      if (typeof choice?.finish_reason === "string") {
        finishReason = choice.finish_reason;
      }
    }
  }

  const toolCalls: ToolCall[] = [...toolMap.values()]
    .filter((c) => c.name.length > 0)
    .map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: c.arguments },
    }));

  return { content, toolCalls, finishReason };
}

/**
 * function calling 対応のストリーミング chat completion。
 * ツール往復を処理し、最終回答の content を delta 単位で onContent へ流す。
 */
export async function chatCompletionStream(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  executeTool: ToolExecutor,
  onContent: ContentHandler,
  onStatus?: StatusHandler
): Promise<void> {
  return enqueue(() => runStreamingToolLoop(messages, tools, executeTool, onContent, onStatus));
}

async function runStreamingToolLoop(
  baseMessages: ChatMessage[],
  tools: ToolDefinition[],
  executeTool: ToolExecutor,
  onContent: ContentHandler,
  onStatus?: StatusHandler
): Promise<void> {
  // baseMessages を破壊しないようコピーして往復の履歴を積む
  const messages: ChatMessage[] = [...baseMessages];
  const useTools = tools.length > 0;

  for (let round = 0; round < config.maxToolRounds; round++) {
    const { content, toolCalls } = await streamRound(
      messages,
      useTools ? tools : undefined,
      onContent,
      onStatus
    );

    // ツール呼び出しあり: 実行して結果を積み、次ラウンドへ
    if (toolCalls.length > 0) {
      messages.push({ role: "assistant", content, tool_calls: toolCalls });

      for (const call of toolCalls) {
        let args: unknown = {};
        try {
          if (call.function.arguments) {
            args = JSON.parse(call.function.arguments);
          }
        } catch {
          // 壊れたJSONは空引数扱いにして続行
          args = {};
        }

        console.log(`[tool] 呼び出し: ${call.function.name} args=${call.function.arguments}`);
        onStatus?.({ kind: "tool", name: call.function.name, args });
        let result: string;
        try {
          result = await executeTool(call.function.name, args);
        } catch (err) {
          console.error(`[tool] 実行失敗: ${call.function.name}`, err);
          result = `ツール実行に失敗しました: ${err instanceof Error ? err.message : String(err)}`;
        }
        console.log(`[tool] 結果: ${result.slice(0, 300)}`);

        messages.push({ role: "tool", content: result, tool_call_id: call.id });
      }
      continue;
    }

    // ツール呼び出しなし: content は既に onContent で流し終えているので終了
    return;
  }

  // ラウンド上限到達: tools を外して最終回答を1回で取得し流す
  const finalMessage = await postChat(messages);
  const finalContent = finalMessage.content?.trim();
  if (finalContent) {
    onContent(finalContent);
  }
}

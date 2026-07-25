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
  tools?: ToolDefinition[]
): Promise<ResponseMessage> {
  const url = `${config.llmBaseUrl}/chat/completions`;

  const body: Record<string, unknown> = {
    model: config.llmModel,
    messages,
    stream: false,
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
 * ツールなしの単純な chat completion。応答テキストを返す。
 */
export async function chatCompletion(messages: ChatMessage[]): Promise<string> {
  return enqueue(async () => {
    const message = await postChat(messages);
    const content = message.content?.trim();
    if (!content) {
      throw new Error("LLMから空の応答が返されました。");
    }
    return content;
  });
}

/**
 * function calling 対応の chat completion。
 * モデルが tool_calls を返す限りツールを実行して結果を積み、最終的なテキスト応答を返す。
 */
export async function chatCompletionWithTools(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  executeTool: ToolExecutor
): Promise<string> {
  return enqueue(() => runToolLoop(messages, tools, executeTool));
}

async function runToolLoop(
  baseMessages: ChatMessage[],
  tools: ToolDefinition[],
  executeTool: ToolExecutor
): Promise<string> {
  // baseMessages を破壊しないようコピーして往復の履歴を積む
  const messages: ChatMessage[] = [...baseMessages];

  for (let round = 0; round < config.maxToolRounds; round++) {
    const message = await postChat(messages, tools);
    const toolCalls = message.tool_calls;

    // ツール呼び出しあり: content が空でも正常系として扱う
    if (toolCalls && toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: message.content ?? "",
        tool_calls: toolCalls,
      });

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
        let result: string;
        try {
          result = await executeTool(call.function.name, args);
        } catch (err) {
          console.error(`[tool] 実行失敗: ${call.function.name}`, err);
          result = `ツール実行に失敗しました: ${err instanceof Error ? err.message : String(err)}`;
        }
        console.log(`[tool] 結果: ${result.slice(0, 300)}`);

        messages.push({
          role: "tool",
          content: result,
          tool_call_id: call.id,
        });
      }
      continue;
    }

    // ツール呼び出しなし: content があれば最終回答
    const content = message.content?.trim();
    if (content) {
      return content;
    }
    // content空 かつ tool_calls無し → ループを抜けて最終回答を強制取得
    break;
  }

  // ラウンド上限到達 or 空応答: tools を外して最終回答を強制的に得る
  const finalMessage = await postChat(messages);
  const finalContent = finalMessage.content?.trim();
  if (!finalContent) {
    throw new Error("LLMから空の応答が返されました。");
  }
  return finalContent;
}

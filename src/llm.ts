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

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

interface ChatCompletionChoice {
  message?: {
    content?: string | null;
  };
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
 * OpenAI互換の /chat/completions エンドポイントを直接fetchで叩く軽量クライアント。
 * Ollama (http://localhost:11434/v1) を想定しているが、OpenAI互換であれば汎用的に動作する。
 */
export async function chatCompletion(messages: ChatMessage[]): Promise<string> {
  return enqueue(() => chatCompletionRequest(messages));
}

async function chatCompletionRequest(messages: ChatMessage[]): Promise<string> {
  const url = `${config.llmBaseUrl}/chat/completions`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.llmApiKey}`,
    },
    body: JSON.stringify({
      model: config.llmModel,
      messages,
      stream: false,
      max_tokens: config.maxTokens,
    }),
    dispatcher,
  } as RequestInit & { dispatcher: Agent });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(`LLM呼び出しに失敗しました (status=${res.status}): ${bodyText}`);
  }

  const bodyText = await res.text();
  console.log("[llm] 生レスポンス:", bodyText);

  const data = JSON.parse(bodyText) as ChatCompletionResponse;
  const content = data.choices?.[0]?.message?.content;

  if (!content || content.trim() === "") {
    throw new Error("LLMから空の応答が返されました。");
  }

  return content.trim();
}

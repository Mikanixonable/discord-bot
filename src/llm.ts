import { config } from "./config.js";

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
 * OpenAI互換の /chat/completions エンドポイントを直接fetchで叩く軽量クライアント。
 * Ollama (http://localhost:11434/v1) を想定しているが、OpenAI互換であれば汎用的に動作する。
 */
export async function chatCompletion(messages: ChatMessage[]): Promise<string> {
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
    }),
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(`LLM呼び出しに失敗しました (status=${res.status}): ${bodyText}`);
  }

  const data = (await res.json()) as ChatCompletionResponse;
  const content = data.choices?.[0]?.message?.content;

  if (!content || content.trim() === "") {
    throw new Error("LLMから空の応答が返されました。");
  }

  return content.trim();
}

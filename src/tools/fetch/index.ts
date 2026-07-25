import { config } from "../../config.js";
import type { ToolDefinition } from "../../llm.js";

/** モデルに渡す fetch_url ツールの定義。 */
export const fetchUrlTool: ToolDefinition = {
  type: "function",
  function: {
    name: "fetch_url",
    description:
      "指定したURLのWebページを取得して本文テキストを読む。会話にURLが貼られていて内容が必要なときに使う。",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "読み込むURL(http/https)" },
      },
      required: ["url"],
    },
  },
};

/** args から url 文字列を取り出す(防御的)。 */
function extractUrl(args: unknown): string {
  if (typeof args === "object" && args !== null && "url" in args) {
    const url = (args as { url: unknown }).url;
    if (typeof url === "string") return url.trim();
  }
  return "";
}

/**
 * SSRF対策: 内部ネットワーク/ループバック/Dockerサービス名などへの到達を弾く。
 * 公開URLは必ずドットを含むため、ドット無しホスト名(内部サービス名)も遮断する。
 */
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "0.0.0.0") return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  const m = h.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  // ドットを含まないホスト名 = Dockerサービス名等の内部名
  if (!h.includes(".")) return true;
  return false;
}

/** HTMLからおおまかに本文テキストを抽出する(軽量・依存なし)。 */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * fetch_url ツールを実行する。URLを取得し本文テキストを返す。
 */
export async function executeFetchUrl(args: unknown): Promise<string> {
  const url = extractUrl(args);
  if (!url) return "URLが指定されていません。";

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "URLの形式が不正です。";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "http/httpsのURLのみ対応しています。";
  }
  if (isBlockedHost(parsed.hostname)) {
    return "そのURLにはアクセスできません(内部アドレス)。";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.fetchUrlTimeoutMs);
  try {
    const res = await fetch(parsed.toString(), {
      signal: controller.signal,
      headers: { "User-Agent": "namako-bot/1.0" },
      redirect: "follow",
    });
    if (!res.ok) {
      return `取得失敗: HTTP ${res.status}`;
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!/(text|html|json|xml)/i.test(contentType)) {
      return "テキストコンテンツではないため読めません。";
    }

    const raw = await res.text();
    const text = /html/i.test(contentType)
      ? htmlToText(raw)
      : raw.replace(/\s+/g, " ").trim();

    if (text === "") {
      return "ページから本文を取得できませんでした。";
    }
    return `${parsed.toString()} の内容:\n${text.slice(0, config.fetchUrlMaxChars)}`;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return "取得がタイムアウトしました。";
    }
    return `取得に失敗しました: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    clearTimeout(timer);
  }
}

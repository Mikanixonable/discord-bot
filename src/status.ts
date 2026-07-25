import type { StatusEvent } from "./llm.js";

// 各状態のユーモアあるステータス文候補(ランダムに選ぶ)
const THINKING = ["思考中", "うんうん唸ってる", "脳内会議中", "考えあぐねてる", "小考中", "熟考の海に潜ってる"];
const WEB = ["webを検索中", "ネットの海を漁ってる", "ぐぐってる", "インターネットに問い合わせ中", "世界の裏側を覗いてる"];
const MESSAGES = ["過去ログを検索中", "昔の発言を掘り返してる", "記憶の地層を掘ってる", "ログの海を漁ってる"];
const FETCH = ["ページを読みに行ってる", "リンク先を覗いてる", "URLの先へ旅立ち中", "そのページを読み込み中"];

function pick(list: string[]): string {
  return list[Math.floor(Math.random() * list.length)];
}

function argString(args: unknown, key: string): string | null {
  if (typeof args === "object" && args !== null && key in args) {
    const v = (args as Record<string, unknown>)[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** ステータスイベントを、Discordのsubtext(薄字)で表示する1行に変換する。 */
export function statusText(event: StatusEvent): string {
  if (event.kind === "thinking") {
    return `-# 🤔 ${pick(THINKING)}...`;
  }

  switch (event.name) {
    case "web_search": {
      const q = argString(event.args, "query");
      return `-# 🌐 ${pick(WEB)}...${q ? `「${q}」` : ""}`;
    }
    case "search_messages": {
      const q = argString(event.args, "query");
      return `-# 🔍 ${pick(MESSAGES)}...${q ? `「${q}」` : ""}`;
    }
    case "fetch_url": {
      const host = hostOf(argString(event.args, "url") ?? "");
      return `-# 📄 ${pick(FETCH)}...${host ? ` (${host})` : ""}`;
    }
    default:
      return `-# ⚙️ 作業中...`;
  }
}

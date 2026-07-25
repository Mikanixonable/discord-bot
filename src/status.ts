import type { StatusEvent } from "./llm.js";

// 各状態のユーモアあるステータス文候補(ランダムに選ぶ)
const THINKING = ["思考中", "思索中", "小考中", "熟考中", "脳内会議を招集", "考えあぐね中", "うねり中", "うめき中", "くねり中", "しぼみ中", "棘皮委員会に問い合わせ中", "", "", "marinating", "making things namako", "pona mute", "thinking", "pondering", "contemplating", "cogitating", "seeking star fishes", "becoming namako", "退嬰中"];
const WEB = ["ねこすい中", "さめすい中", "まくらすい中", "ふとんすい中", "検索中", "internet漁り中", "ぐぐり中", "電電公社に問い合わせ中", "ダークウェブ漁り中", "潜水中"];
const MESSAGES = ["過去ログを検索中", "昔の発言を掘り返し中", "記憶の地層を採掘中", "ログの海を漁り中"];
const FETCH = ["ページを閲覧中", "リンク先を覗き中", "URLの先へ旅立ち中", "そのページを読み込み中"];

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

/** ステータスイベントを、Discordのsubtext(薄字)で表示する1行に変換する。 */
export function statusText(event: StatusEvent): string {
  if (event.kind === "thinking") {
    return `-# :meow_atamakakae: ${pick(THINKING)}...`;
  }

  switch (event.name) {
    case "web_search": {
      const q = argString(event.args, "query");
      return `-# :meow_mac: ${pick(WEB)}...${q ? `「${q}」` : ""}`;
    }
    case "search_messages": {
      const q = argString(event.args, "query");
      return `-# :meow_enjoy:🔍 ${pick(MESSAGES)}...${q ? `「${q}」` : ""}`;
    }
    case "fetch_url": {
      // 読みに行ったリンクは記録として残すため、URL全体を表示する
      const url = argString(event.args, "url");
      return `-# 📄:meow_blahaj:  ${pick(FETCH)}...${url ? ` ${url}` : ""}`;
    }
    default:
      return `-# ⚙️ 作業中...`;
  }
}

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// dist/ もしくは src/ から実行される想定なので、プロジェクトルート基準で解決する
const PERSONA_PATH = path.resolve(__dirname, "..", "config", "persona.md");

let cachedPersona: string | null = null;

export function loadPersona(): string {
  if (cachedPersona !== null) return cachedPersona;
  try {
    cachedPersona = readFileSync(PERSONA_PATH, "utf-8");
  } catch (err) {
    console.error(`persona.md の読み込みに失敗しました (${PERSONA_PATH}):`, err);
    cachedPersona = "あなたはフレンドリーなDiscordボットです。";
  }
  return cachedPersona;
}

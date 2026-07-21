import { Client, GatewayIntentBits, Partials, type Message } from "discord.js";
import { config } from "./config.js";
import { generateReply, splitForDiscord } from "./chat.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

client.once("clientReady", (readyClient) => {
  console.log(`ログイン完了: ${readyClient.user.tag}`);
  console.log(`自動返信チャンネル: ${[...config.autoReplyChannelIds].join(", ") || "(なし)"}`);
});

function shouldRespond(message: Message): boolean {
  // bot自身や他のbotのメッセージは無視
  if (message.author.bot) return false;

  // allowlistに含まれるチャンネル/スレッドでは全メッセージに応答
  if (config.autoReplyChannelIds.has(message.channelId)) return true;

  // それ以外はbotへのメンション時のみ応答
  // @everyone やロールメンションでは反応しない(bot個人への直接メンションのみ)
  if (
    client.user &&
    message.mentions.has(client.user, { ignoreEveryone: true, ignoreRoles: true })
  ) {
    return true;
  }

  return false;
}

client.on("messageCreate", async (message) => {
  try {
    if (!shouldRespond(message)) return;

    if (!("sendTyping" in message.channel)) return;

    await message.channel.sendTyping();

    const reply = await generateReply(message);
    const chunks = splitForDiscord(reply);

    for (let i = 0; i < chunks.length; i++) {
      if (i === 0) {
        await message.reply(chunks[i]);
      } else if ("send" in message.channel) {
        await message.channel.send(chunks[i]);
      }
    }
  } catch (err) {
    console.error("メッセージ処理中にエラーが発生しました:", err);
    try {
      if ("send" in message.channel) {
        await message.channel.send("ごめん、ちょっとエラーが起きちゃった…もう一回試してみて。");
      }
    } catch (sendErr) {
      console.error("エラー通知の送信にも失敗しました:", sendErr);
    }
  }
});

client.login(config.discordToken);

function setupGracefulShutdown(): void {
  const shutdown = async (signal: string) => {
    console.log(`${signal} を受信しました。シャットダウンします...`);
    try {
      await client.destroy();
      console.log("クライアントを正常に破棄しました。");
    } catch (err) {
      console.error("シャットダウン処理中にエラーが発生しました:", err);
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

setupGracefulShutdown();

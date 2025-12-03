import { processMessage } from "./logic.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("Bot running");
  }

  const update = req.body;
  const msg = update.message;

  if (!msg) return res.status(200).send("OK");

  const result = await processMessage(msg);

  // SEND MESSAGE TO TELEGRAM
  await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: result.chatId,
        text: result.text,
        parse_mode: result.markdown ? "Markdown" : undefined,
      }),
    }
  );

  return res.status(200).send("OK");
}

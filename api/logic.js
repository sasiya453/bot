import { supabase } from "../lib/supabase.js";

export async function processMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text?.trim() || "";

  // COMMANDS
  if (text === "/start") {
    return {
      chatId,
      text: "Welcome to your Crypto Trade Tracker Bot! 🚀\n\nCommands:\n/add coin timeframe pnl\n/list\n/edit id newpnl\n/delete id"
    };
  }

  // ADD TRADE
  if (text.startsWith("/add")) {
    const parts = text.split(" ");
    if (parts.length < 4) {
      return { chatId, text: "❗ Usage: /add BTC 1h 5" };
    }

    const coin = parts[1];
    const timeframe = parts[2];
    const pnl = parseFloat(parts[3]);

    const { error } = await supabase.from("trades").insert({
      user_id: chatId,
      coin,
      timeframe,
      pnl
    });

    if (error) {
      return { chatId, text: "❌ Failed to add trade." };
    }

    return { chatId, text: "✅ Trade added successfully!" };
  }

  // LIST TRADES
  if (text === "/list") {
    const { data, error } = await supabase
      .from("trades")
      .select("*")
      .eq("user_id", chatId)
      .order("created_at", { ascending: false });

    if (error) return { chatId, text: "❌ Failed to fetch trades." };

    if (data.length === 0) {
      return { chatId, text: "📭 No trades found." };
    }

    let msgText = "📊 *Your Trades:*\n\n";

    data.forEach((t) => {
      msgText += `ID: ${t.id}\nCoin: ${t.coin}\nTimeframe: ${t.timeframe}\nPNL: ${t.pnl}%\n\n`;
    });

    return { chatId, text: msgText, markdown: true };
  }

  // EDIT TRADE (PNL)
  if (text.startsWith("/edit")) {
    const parts = text.split(" ");

    if (parts.length < 3) {
      return { chatId, text: "❗ Usage: /edit tradeId newPNL" };
    }

    const tradeId = parts[1];
    const newpnl = parseFloat(parts[2]);

    const { error } = await supabase
      .from("trades")
      .update({ pnl: newpnl })
      .eq("id", tradeId)
      .eq("user_id", chatId);

    if (error) return { chatId, text: "❌ Failed to update." };

    return { chatId, text: "✏️ Trade updated!" };
  }

  // DELETE TRADE
  if (text.startsWith("/delete")) {
    const id = text.split(" ")[1];

    const { error } = await supabase
      .from("trades")
      .delete()
      .eq("id", id)
      .eq("user_id", chatId);

    if (error) return { chatId, text: "❌ Failed to delete trade." };

    return { chatId, text: "🗑️ Trade deleted!" };
  }

  return { chatId, text: "❗ Unknown command." };
}

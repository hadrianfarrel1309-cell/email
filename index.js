import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

app.get("/", (req, res) => {
  res.send("Market Bot V8 running");
});

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("Telegram ENV belum diisi");
    return;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text
    })
  });
}

setInterval(async () => {
  try {
    const msg = `📈 Market Update

BBCA dipantau
BBRI dipantau
Bitcoin dipantau
USD/IDR dipantau

Bot aktif realtime 🔥`;

    console.log("Kirim Telegram...");
    await sendTelegram(msg);
  } catch (e) {
    console.error(e);
  }
}, 600000);

app.listen(PORT, () => {
  console.log(`Server hidup di port ${PORT}`);
});
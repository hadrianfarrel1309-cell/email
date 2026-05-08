import express from "express";
import Parser from "rss-parser";

const app = express();
const parser = new Parser();

const PORT = process.env.PORT || 3000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const NEWS_POLL_MINUTES = Number(process.env.NEWS_POLL_MINUTES || 10);
const TIMEZONE = process.env.TIMEZONE || "Asia/Jakarta";

const sentLinks = new Set();

const KEYWORDS = [
  "BBCA",
  "BBRI",
  "IHSG",
  "Bitcoin",
  "USD IDR",
  "saham Indonesia",
  "bank BCA",
  "bank BRI"
];

async function getPrice(symbol) {
  try {
    if (symbol === "BTC-USD") {
      const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd");
      const data = await res.json();
      return data?.bitcoin?.usd || "N/A";
    }

    if (symbol === "IDR=X") {
      const res = await fetch("https://open.er-api.com/v6/latest/USD");
      const data = await res.json();
      return data?.rates?.IDR || "N/A";
    }

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m`;

    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    const data = await res.json();
    const result = data?.chart?.result?.[0];

    const metaPrice =
      result?.meta?.regularMarketPrice ||
      result?.meta?.previousClose;

    const closes = result?.indicators?.quote?.[0]?.close || [];
    const lastClose = closes.filter((x) => typeof x === "number").pop();

    return metaPrice || lastClose || "N/A";
  } catch (err) {
    console.log(`Gagal ambil harga ${symbol}: ${err.message}`);
    return "N/A";
  }
}


function formatNumber(num) {
  if (typeof num !== "number") return num;

  return new Intl.NumberFormat("id-ID").format(num);
}

function nowText() {
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: TIMEZONE,
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date());
}

function googleNewsRssUrl(query) {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(
    query
  )}&hl=id&gl=ID&ceid=ID:id`;
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID belum diisi");
    return;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: false
    })
  });

  const data = await res.json();

  if (!data.ok) {
    throw new Error(`Telegram gagal: ${JSON.stringify(data)}`);
  }
}

function cleanTitle(title = "") {
  return title.replace(/\s-\sGoogle News$/i, "").trim();
}

async function checkNews() {
  console.log(`[${nowText()}] Cek berita baru...`);

  for (const keyword of KEYWORDS) {
    try {
      const feed = await parser.parseURL(googleNewsRssUrl(keyword));
      const items = feed.items || [];

console.log(`Keyword ${keyword} -> ${items.length} berita`);
      
      for (const item of items.slice(0, 3)) {
        const link = item.link;
        const title = cleanTitle(item.title);

        if (!link || !title) continue;
        if (sentLinks.has(link)) continue;

        sentLinks.add(link);

        const message = `📰 BERITA MARKET BARU

Topik: ${keyword}

${title}

${link}

⏰ ${nowText()}`;

        await sendTelegram(message);
        console.log(`Terkirim: ${title}`);

        await new Promise((r) => setTimeout(r, 1500));
      }
    } catch (err) {
      console.log(`Gagal ambil berita ${keyword}: ${err.message}`);
    }
  }
}

async function sendStartupMessage() {
  const bbca = await getPrice("BBCA.JK");
  const bbri = await getPrice("BBRI.JK");
  const ihsg = await getPrice("^JKSE");
  const btc = await getPrice("BTC-USD");
  const usdidr = await getPrice("IDR=X");

  await sendTelegram(`✅ Market Bot aktif

Pantauan:
- BBCA: ${formatNumber(bbca)} IDR
- BBRI: ${formatNumber(bbri)} IDR
- IHSG: ${formatNumber(ihsg)}
- Bitcoin: $${formatNumber(btc)}
- USD/IDR: ${formatNumber(usdidr)} IDR

Cek berita tiap ${NEWS_POLL_MINUTES} menit.

⏰ ${nowText()}`);
}

app.get("/", (req, res) => {
  res.send("Market Telegram Bot V8 aktif");
});

app.get("/test", async (req, res) => {
  try {
    await sendTelegram(`✅ Test Telegram berhasil\n⏰ ${nowText()}`);
    res.send("Test Telegram terkirim");
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.listen(PORT, async () => {
  console.log(`Server jalan di port ${PORT}`);

  if (process.argv.includes("test")) {
    await sendTelegram(`✅ Test Telegram berhasil\n⏰ ${nowText()}`);
    process.exit(0);
  }

  try {
    await sendStartupMessage();
  } catch (err) {
    console.log(`Gagal kirim startup message: ${err.message}`);
  }

  await checkNews();

  setInterval(checkNews, NEWS_POLL_MINUTES * 60 * 1000);
});

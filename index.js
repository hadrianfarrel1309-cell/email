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
const lastPrices = {};
const lastPanicAlerts = {};
const lastBreakoutAlerts = {};

const KEYWORDS = [
  "BBCA",
  "BBRI",
  "IHSG",
  "Bitcoin",
  "USD IDR",
  "saham Indonesia",
  "bank BCA",
  "bank BRI",
  "asing beli BBCA",
  "asing jual BBCA",
  "asing beli BBRI",
  "asing jual BBRI",
  "foreign net buy BBCA",
  "foreign net sell BBRI",
  "net foreign IHSG"
];

async function getPrice(symbol) {
  try {
if (symbol === "BTC-USD") {
  const res = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot");
  const data = await res.json();

  return data?.data?.amount
    ? Number(data.data.amount).toFixed(0)
    : "N/A";
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

function newsSources() {
  return [
    "https://www.cnbcindonesia.com/market/rss",
    "https://rss.detik.com/index.php/finance",
    "https://www.coindesk.com/arc/outboundfeeds/rss/",
    "https://cointelegraph.com/rss",
    "https://rss.kontan.co.id/news/investasi",
    "https://market.bisnis.com/rss",
    "https://investor.id/rss",
    "https://www.bloombergtechnoz.com/feed"
  ];
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

function analyzeSentiment(title = "") {
  const text = title.toLowerCase();

  const positiveWords = [
    "naik", "menguat", "cuan", "laba naik", "profit naik", "positif",
    "rebound", "bullish", "akumulasi", "beli", "net buy", "asing beli",
    "dividen", "rekor", "tumbuh", "menghijau"
  ];

  const negativeWords = [
    "turun", "melemah", "anjlok", "rugi", "negatif", "bearish",
    "jual", "net sell", "asing jual", "koreksi", "tekanan",
    "panic", "krisis", "merosot", "memerah"
  ];

  const positive = positiveWords.some((word) => text.includes(word));
  const negative = negativeWords.some((word) => text.includes(word));

  if (positive && !negative) {
    return {
      label: "🟢 Positif",
      impact: "Potensi mendukung sentimen market."
    };
  }

  if (negative && !positive) {
    return {
      label: "🔴 Negatif",
      impact: "Waspada tekanan jual / koreksi harga."
    };
  }

  return {
    label: "🟡 Netral",
    impact: "Belum ada arah sentimen kuat."
  };
}

async function checkNews() {
  console.log(`[${nowText()}] Cek berita baru...`);

  const filters = [
    "BBCA",
    "BBRI",
    "IHSG",
    "Bitcoin",
    "BTC",
    "USD",
    "Rupiah",
    "BCA",
    "BRI",
    "asing"
    "BI Rate",
"suku bunga",
"The Fed",
"foreign flow",
"net foreign buy",
"net foreign sell",
"yield obligasi",
"rupiah melemah",
"rupiah menguat"
  ];

  for (const source of newsSources()) {
    try {
      const feed = await parser.parseURL(source);
      const items = feed.items || [];

      console.log(`Source ${source} -> ${items.length} berita`);

      for (const item of items.slice(0, 10)) {
        const link = item.link;
        const title = cleanTitle(item.title);

        if (!link || !title) continue;
        if (sentLinks.has(link)) continue;

        const match = filters.some((word) =>
          title.toLowerCase().includes(word.toLowerCase())
        );

        if (!match) continue;

        sentLinks.add(link);

        const sentiment = analyzeSentiment(title);

        const message = `📰 BERITA MARKET BARU

${title}

Sentiment: ${sentiment.label}
Impact: ${sentiment.impact}

${link}

⏰ ${nowText()}`;

        await sendTelegram(message);

        console.log(`Terkirim: ${title}`);

        await new Promise((r) => setTimeout(r, 5000));
      }
    } catch (err) {
      console.log(`Gagal ambil RSS ${source}: ${err.message}`);
    }
  }
}

async function checkPanicSell() {
  const assets = [
    { name: "BBCA", symbol: "BBCA.JK", limit: -2, unit: "IDR" },
    { name: "BBRI", symbol: "BBRI.JK", limit: -2, unit: "IDR" },
    { name: "IHSG", symbol: "^JKSE", limit: -1.5, unit: "" },
    { name: "Bitcoin", symbol: "BTC-USD", limit: -3, unit: "USD" }
  ];

  for (const asset of assets) {
    const current = await getPrice(asset.symbol);
    const currentNum = Number(String(current).replace(/[^\d.-]/g, ""));

    if (!currentNum || Number.isNaN(currentNum)) continue;

    const previous = lastPrices[asset.symbol];
    lastPrices[asset.symbol] = currentNum;

    if (!previous) continue;

    const changePct = ((currentNum - previous) / previous) * 100;

    if (changePct <= asset.limit) {
      const lastAlert = lastPanicAlerts[asset.symbol] || 0;
      const now = Date.now();

      if (now - lastAlert < 30 * 60 * 1000) continue;

      lastPanicAlerts[asset.symbol] = now;

      await sendTelegram(`🔴 PANIC SELL ALERT

${asset.name} turun ${changePct.toFixed(2)}%

Harga sebelumnya: ${formatNumber(previous)} ${asset.unit}
Harga sekarang: ${formatNumber(currentNum)} ${asset.unit}

Status:
Waspada tekanan jual besar.
Jangan FOMO sell, cek support dan volume dulu.

⏰ ${nowText()}`);
    }
  }
}

async function checkBreakout() {
  const assets = [
    { name: "BBCA", symbol: "BBCA.JK", limit: 2, unit: "IDR" },
    { name: "BBRI", symbol: "BBRI.JK", limit: 2, unit: "IDR" },
    { name: "IHSG", symbol: "^JKSE", limit: 1.2, unit: "" },
    { name: "Bitcoin", symbol: "BTC-USD", limit: 3, unit: "USD" }
  ];

  for (const asset of assets) {
    const current = await getPrice(asset.symbol);
    const currentNum = Number(String(current).replace(/[^\d.-]/g, ""));

    if (!currentNum || Number.isNaN(currentNum)) continue;

    const previous = lastPrices[`breakout_${asset.symbol}`];
    lastPrices[`breakout_${asset.symbol}`] = currentNum;

    if (!previous) continue;

    const changePct = ((currentNum - previous) / previous) * 100;

    if (changePct >= asset.limit) {
      const lastAlert = lastBreakoutAlerts[asset.symbol] || 0;
      const now = Date.now();

      if (now - lastAlert < 30 * 60 * 1000) continue;

      lastBreakoutAlerts[asset.symbol] = now;

      await sendTelegram(`🟢 BREAKOUT ALERT

${asset.name} naik ${changePct.toFixed(2)}%

Harga sebelumnya: ${formatNumber(previous)} ${asset.unit}
Harga sekarang: ${formatNumber(currentNum)} ${asset.unit}

Status:
Ada dorongan beli kuat.
Pantau volume dan jangan FOMO entry terlalu atas.

⏰ ${nowText()}`);
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

async function sendMorningBriefing() {
  const bbca = await getPrice("BBCA.JK");
  const bbri = await getPrice("BBRI.JK");
  const ihsg = await getPrice("^JKSE");
  const btc = await getPrice("BTC-USD");
  const usdidr = await getPrice("IDR=X");

  await sendTelegram(`📊 MORNING BRIEFING

IHSG: ${formatNumber(ihsg)}
BBCA: ${formatNumber(bbca)} IDR
BBRI: ${formatNumber(bbri)} IDR
Bitcoin: $${formatNumber(btc)}
USD/IDR: ${formatNumber(usdidr)} IDR

Sentimen market:
🟢 Pantau saham perbankan
🟡 Pantau foreign flow
🔴 Waspada volatilitas crypto

⏰ ${nowText()}`);
}

async function sendClosingRecap() {
  const bbca = await getPrice("BBCA.JK");
  const bbri = await getPrice("BBRI.JK");
  const ihsg = await getPrice("^JKSE");
  const btc = await getPrice("BTC-USD");
  const usdidr = await getPrice("IDR=X");

  await sendTelegram(`📉 MARKET CLOSE

IHSG: ${formatNumber(ihsg)}
BBCA: ${formatNumber(bbca)} IDR
BBRI: ${formatNumber(bbri)} IDR
Bitcoin: $${formatNumber(btc)}
USD/IDR: ${formatNumber(usdidr)} IDR

Summary:
🟢 Pantau saham big bank
🟡 IHSG masih bergerak dinamis
🔴 Crypto masih volatile

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

app.get("/keepalive", (req, res) => {
  console.log(`[${nowText()}] Keep alive ping`);
  res.send("OK");
});

function keepAliveLog() {
  console.log(`[${nowText()}] Bot market masih hidup`);
}

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

await checkPanicSell();
setInterval(checkPanicSell, 5 * 60 * 1000);
await checkBreakout();
setInterval(checkBreakout, 5 * 60 * 1000); 
// Cek tiap 1 menit untuk briefing
setInterval(async () => {
  const now = new Date();

  const jakarta = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(now);

  // Morning briefing 08:30
  if (jakarta === "08:30") {
    await sendMorningBriefing();
  }

  // Closing recap 16:15
  if (jakarta === "16:15") {
    await sendClosingRecap();
  }
}, 60 * 1000);

  // log tiap 3 jam
keepAliveLog();

setInterval(() => {
  keepAliveLog();
}, 3 * 60 * 60 * 1000);
  
});

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
  "BMRI",
  "IHSG",
  "Bitcoin",
  "USD IDR",
  "saham Indonesia",
  "bank BCA",
  "bank BRI",
  "bank Mandiri",
  "asing beli BMRI",
  "asing jual BMRI",
  "foreign net buy BMRI",
  "foreign net sell BMRI",
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

// BITCOIN
if (symbol === "BTC-USD") {

  // harga sekarang
  const nowRes = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot");
  const nowData = await nowRes.json();

  const current = Number(nowData?.data?.amount || 0);

  // tanggal WIB
  const now = new Date();

  const jakartaDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);

  // jam 00:00 WIB
  const start = new Date(`${jakartaDate}T00:00:00+07:00`);
  const end = new Date(start.getTime() + 60 * 60 * 1000);

  // ambil candle awal hari
  const candleUrl =
    `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600&start=${start.toISOString()}&end=${end.toISOString()}`;

  const candleRes = await fetch(candleUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0"
    }
  });

  const candles = await candleRes.json();

  // format: [time, low, high, open, close, volume]
  const open = Array.isArray(candles) && candles.length
    ? Number(candles[0][3])
    : current;

  return {
    current,
    open
  };
}

// USD IDR dari BCA e-Rate
if (symbol === "IDR=X") {

  const res = await fetch(
    "https://www.bca.co.id/id/informasi/kurs",
    {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    }
  );

  const html = await res.text();

  // ambil row USD
  const usdMatch = html.match(
  /USD[\s\S]*?Beli[\s\S]*?Jual[\s\S]*?([\d.]+,\d+)[\s\S]*?([\d.]+,\d+)/
  );

  if (!usdMatch) {
    throw new Error("Kurs USD BCA tidak ditemukan");
  }

  // ambil harga JUAL (kotak merah)
  const current = Number(
    usdMatch[2]
      .replace(/\./g, "")
      .replace(",", ".")
  );

  const jakartaDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());

  const key = `USDIDR_OPEN_${jakartaDate}`;

  if (!lastPrices[key]) {
    lastPrices[key] = current;
  }

  return {
    current,
    open: lastPrices[key]
  };
}
    // SAHAM / IHSG
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m`;

    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    const data = await res.json();

    const result = data?.chart?.result?.[0];

    const current =
      result?.meta?.regularMarketPrice ||
      result?.meta?.previousClose;

    const open =
      result?.meta?.regularMarketOpen ||
      result?.meta?.chartPreviousClose ||
      current;

    return {
      current: Number(current),
      open: Number(open)
    };

  } catch (err) {
    console.log(`Gagal ambil harga ${symbol}: ${err.message}`);

    return {
      current: 0,
      open: 0
    };
  }
}

function formatNumber(num) {
  if (typeof num !== "number") return num;

  return new Intl.NumberFormat("id-ID").format(num);
}

function getChange(current, open) {
  if (!open || !current) {
    return {
      arrow: "",
      pct: "0.00"
    };
  }

  const pct = ((current - open) / open) * 100;

  return {
    arrow: pct >= 0 ? "▲" : "▼",
    pct: Math.abs(pct).toFixed(2)
  };
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
    "https://www.bloombergtechnoz.com/feed",
     "https://emitennews.com/feed/",
    "https://www.idxchannel.com/rss",
    "https://stockwatch.id/feed/",
    "https://www.kabarbursa.com/feed/",
    "https://katadata.co.id/rss",
    "https://www.emitentrust.com/feed/"
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
    "BMRI",
    "BTC",
    "USD",
    "Rupiah",
    "BCA",
    "Bank Central Asia",
    "BRI",
    "Bank Rakyat Indonesia",
    "Mandiri",
    "Bank Mandiri",
    "asing",
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
    { name: "BMRI", symbol: "BMRI.JK", limit: -2, unit: "IDR" },
    { name: "BBRI", symbol: "BBRI.JK", limit: -2, unit: "IDR" },
    { name: "IHSG", symbol: "^JKSE", limit: -1.5, unit: "" },
    { name: "Bitcoin", symbol: "BTC-USD", limit: -3, unit: "USD" }
  ];

  for (const asset of assets) {
const data = await getPrice(asset.symbol);
const currentNum = data.current;

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
    { name: "BMRI", symbol: "BMRI.JK", limit: 2, unit: "IDR" },
    { name: "BBRI", symbol: "BBRI.JK", limit: 2, unit: "IDR" },
    { name: "IHSG", symbol: "^JKSE", limit: 1.2, unit: "" },
    { name: "Bitcoin", symbol: "BTC-USD", limit: 3, unit: "USD" }
  ];

  for (const asset of assets) {
const data = await getPrice(asset.symbol);
const currentNum = data.current;

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
  const bmri = await getPrice("BMRI.JK");
  const bbri = await getPrice("BBRI.JK");
  const ihsg = await getPrice("^JKSE");
  const btc = await getPrice("BTC-USD");
  const usdidr = await getPrice("IDR=X");

  const bbcaChange = getChange(bbca.current, bbca.open);
  const bmriChange = getChange(bmri.current, bmri.open);
  const bbriChange = getChange(bbri.current, bbri.open);
  const ihsgChange = getChange(ihsg.current, ihsg.open);
  const btcChange = getChange(btc.current, btc.open);
  const usdChange = getChange(usdidr.current, usdidr.open);

  await sendTelegram(`✅ Market Bot aktif

Pantauan:
- BBCA: ${formatNumber(bbca.current)} IDR ${bbcaChange.arrow}(${bbcaChange.pct}%)
- BMRI: ${formatNumber(bmri.current)} IDR ${bmriChange.arrow}(${bmriChange.pct}%)
- BBRI: ${formatNumber(bbri.current)} IDR ${bbriChange.arrow}(${bbriChange.pct}%)
- IHSG: ${formatNumber(ihsg.current)} ${ihsgChange.arrow}(${ihsgChange.pct}%)
- Bitcoin: $${formatNumber(btc.current)} ${btcChange.arrow}(${btcChange.pct}%)
- USD/IDR: ${formatNumber(usdidr.current)} IDR ${usdChange.arrow}(${usdChange.pct}%)

Cek berita tiap ${NEWS_POLL_MINUTES} menit.

⏰ ${nowText()}`);
}

async function sendMorningBriefing() {
  const bbca = await getPrice("BBCA.JK");
  const bmri = await getPrice("BMRI.JK");
  const bbri = await getPrice("BBRI.JK");
  const ihsg = await getPrice("^JKSE");
  const btc = await getPrice("BTC-USD");
  const usdidr = await getPrice("IDR=X");

  await sendTelegram(`📊 MORNING BRIEFING

IHSG: ${formatNumber(ihsg.current)}
BBCA: ${formatNumber(bbca.current)} IDR
BMRI: ${formatNumber(bmri.current)} IDR
BBRI: ${formatNumber(bbri.current)} IDR
Bitcoin: $${formatNumber(btc.current)}
USD/IDR: ${formatNumber(usdidr.current)} IDR

Sentimen market:
🟢 Pantau saham perbankan
🟡 Pantau foreign flow
🔴 Waspada volatilitas crypto

⏰ ${nowText()}`);
}

async function sendClosingRecap() {
  const bbca = await getPrice("BBCA.JK");
  const bmri = await getPrice("BMRI.JK");
  const bbri = await getPrice("BBRI.JK");
  const ihsg = await getPrice("^JKSE");
  const btc = await getPrice("BTC-USD");
  const usdidr = await getPrice("IDR=X");

  await sendTelegram(`📉 MARKET CLOSE

IHSG: ${formatNumber(ihsg.current)}
BBCA: ${formatNumber(bbca.current)} IDR
BMRI: ${formatNumber(bmri.current)} IDR
BBRI: ${formatNumber(bbri.current)} IDR
Bitcoin: $${formatNumber(btc.current)}
USD/IDR: ${formatNumber(usdidr.current)} IDR

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
setInterval(sendStartupMessage, NEWS_POLL_MINUTES * 60 * 1000);
  
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

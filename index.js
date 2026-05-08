import 'dotenv/config';
import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import yahooFinanceImport from 'yahoo-finance2';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { RSI, SMA } from 'technicalindicators';
import Parser from 'rss-parser';

dayjs.extend(utc);
dayjs.extend(timezone);

const yahooFinance = yahooFinanceImport?.default ?? yahooFinanceImport;

function getYahooMethod(name) {
  const method = yahooFinance?.[name] ?? yahooFinanceImport?.[name] ?? yahooFinanceImport?.default?.[name];
  if (typeof method !== 'function') {
    throw new Error(`Method yahoo-finance2 ${name} tidak tersedia. Cek versi package.`);
  }
  return method.bind(yahooFinance);
}

const rssParser = new Parser({
  timeout: 12000,
  headers: {
    'User-Agent': 'Mozilla/5.0 MarketNewsBot/1.0'
  }
});

const yfQuote = getYahooMethod('quote');
const yfHistorical = getYahooMethod('historical');
const yfSearch = typeof (yahooFinance?.search ?? yahooFinanceImport?.search ?? yahooFinanceImport?.default?.search) === 'function'
  ? (yahooFinance?.search ?? yahooFinanceImport?.search ?? yahooFinanceImport?.default?.search).bind(yahooFinance)
  : null;

const CONFIG = {
  timezone: process.env.TIMEZONE || 'Asia/Jakarta',
  port: Number(process.env.PORT || 3000),
  newsPollMinutes: Number(process.env.NEWS_POLL_MINUTES || 5),
  marketSummaryMinutes: Number(process.env.MARKET_SUMMARY_MINUTES || 60),
  sendMarketSummary: String(process.env.SEND_MARKET_SUMMARY || 'true').toLowerCase() !== 'false',
  sendStartupMessage: String(process.env.SEND_STARTUP_MESSAGE || 'true').toLowerCase() !== 'false',
  symbols: [
    { symbol: 'BBCA.JK', name: 'BCA', type: 'stock', currency: 'IDR' },
    { symbol: 'BBRI.JK', name: 'BRI', type: 'stock', currency: 'IDR' },
    { symbol: 'BTC-USD', name: 'Bitcoin', type: 'crypto', currency: 'USD' },
    { symbol: 'IDR=X', name: 'USD/IDR', type: 'currency', currency: 'IDR' }
  ],
  yahooNewsEnabled: String(process.env.YAHOO_NEWS_ENABLED || 'true').toLowerCase() !== 'false',
  rssNewsEnabled: String(process.env.RSS_NEWS_ENABLED || 'true').toLowerCase() !== 'false',
  newsQueries: [
    { query: 'BBCA.JK', label: 'BBCA', source: 'Yahoo' },
    { query: 'BCA bank Indonesia saham', label: 'BBCA', source: 'Yahoo' },
    { query: 'BBRI.JK', label: 'BBRI', source: 'Yahoo' },
    { query: 'BRI bank Indonesia saham', label: 'BBRI', source: 'Yahoo' },
    { query: 'BTC-USD', label: 'Bitcoin', source: 'Yahoo' },
    { query: 'Bitcoin crypto', label: 'Bitcoin', source: 'Yahoo' },
    { query: 'USD IDR Rupiah', label: 'USD/IDR', source: 'Yahoo' }
  ],
  rssNewsQueries: [
    { query: 'site:stockbit.com BBCA saham', label: 'BBCA', source: 'Stockbit' },
    { query: 'site:stockbit.com BBRI saham', label: 'BBRI', source: 'Stockbit' },
    { query: 'site:stockbit.com IHSG saham', label: 'IHSG', source: 'Stockbit' },
    { query: 'IHSG saham Indonesia', label: 'IHSG', source: 'IHSG' },
    { query: 'BBCA BBRI IHSG saham hari ini', label: 'IHSG', source: 'IHSG' },
    { query: 'USD IDR rupiah IHSG', label: 'USD/IDR', source: 'IHSG' },
    { query: 'Bitcoin USD market hari ini', label: 'Bitcoin', source: 'Crypto' }
  ],
  watchDropPercent: Number(process.env.WATCH_DROP_PERCENT || -2),
  rsiBuyLevel: Number(process.env.RSI_BUY_LEVEL || 35),
  rsiSellLevel: Number(process.env.RSI_SELL_LEVEL || 70)
};

const DATA_DIR = path.join(process.cwd(), 'data');
const SEEN_NEWS_FILE = path.join(DATA_DIR, 'seen-news.json');
let seenNews = new Set();
let lastMarketSummaryAt = 0;
let isNewsLoopRunning = false;
let isMarketLoopRunning = false;

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`ENV ${name} belum diisi`);
  return value;
}

function money(value, currency = 'IDR') {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
  return new Intl.NumberFormat(currency === 'USD' ? 'en-US' : 'id-ID', {
    style: 'currency',
    currency,
    maximumFractionDigits: currency === 'USD' ? 2 : 0
  }).format(Number(value));
}

function pct(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
  const sign = Number(value) > 0 ? '+' : '';
  return `${sign}${Number(value).toFixed(2)}%`;
}

function escapeHtml(str = '') {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function newsKey(item) {
  return String(item.link || item.uuid || item.title || '').trim().toLowerCase();
}

async function loadSeenNews() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const raw = await fs.readFile(SEEN_NEWS_FILE, 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) seenNews = new Set(arr.slice(-500));
  } catch {
    seenNews = new Set();
  }
}

async function saveSeenNews() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(SEEN_NEWS_FILE, JSON.stringify([...seenNews].slice(-500), null, 2));
}

async function getMarketData(asset) {
  const now = new Date();
  const start = dayjs(now).subtract(90, 'day').toDate();

  const [quote, historicalRaw] = await Promise.all([
    yfQuote(asset.symbol),
    yfHistorical(asset.symbol, { period1: start, period2: now, interval: '1d' }).catch(() => [])
  ]);

  const historical = Array.isArray(historicalRaw) ? historicalRaw : [];
  const closes = historical.map(item => Number(item.close)).filter(Number.isFinite);
  const rsiValues = closes.length >= 15 ? RSI.calculate({ values: closes, period: 14 }) : [];
  const sma20Values = closes.length >= 20 ? SMA.calculate({ values: closes, period: 20 }) : [];
  const sma50Values = closes.length >= 50 ? SMA.calculate({ values: closes, period: 50 }) : [];

  const price = Number(quote.regularMarketPrice ?? closes.at(-1));
  const previousClose = Number(quote.regularMarketPreviousClose ?? closes.at(-2));
  const changePercent = Number.isFinite(price) && Number.isFinite(previousClose) && previousClose !== 0
    ? ((price - previousClose) / previousClose) * 100
    : Number(quote.regularMarketChangePercent || 0);

  const rsi = rsiValues.at(-1) ?? null;
  const sma20 = sma20Values.at(-1) ?? null;
  const sma50 = sma50Values.at(-1) ?? null;
  const signal = buildSignal({ price, changePercent, rsi, sma20, sma50, type: asset.type });

  return { ...asset, price, previousClose, changePercent, rsi, sma20, sma50, signal };
}

function buildSignal({ price, changePercent, rsi, sma20, sma50, type }) {
  const reasons = [];
  let label = 'HOLD / PANTAU';
  let emoji = '🟡';

  if (type === 'currency') {
    label = Number.isFinite(changePercent) && changePercent >= 0 ? 'USD MENGUAT / RUPIAH MELEMAH' : 'USD MELEMAH / RUPIAH MENGUAT';
    emoji = Number.isFinite(changePercent) && changePercent >= 0 ? '🟠' : '🟢';
    reasons.push('pantau efek ke market Indonesia');
    return { label, emoji, reasons };
  }

  if (Number.isFinite(changePercent) && changePercent <= CONFIG.watchDropPercent && rsi !== null && rsi <= CONFIG.rsiBuyLevel) {
    label = 'AREA CICIL / BUY WATCH';
    emoji = '🟢';
    reasons.push(`turun ${pct(changePercent)}, RSI ${rsi.toFixed(1)} rendah`);
  } else if (rsi !== null && rsi >= CONFIG.rsiSellLevel) {
    label = 'WASPADA TAKE PROFIT';
    emoji = '🟠';
    reasons.push(`RSI ${rsi.toFixed(1)} tinggi`);
  } else if (sma20 && sma50 && price > sma20 && sma20 > sma50) {
    label = 'HOLD / TREND KUAT';
    emoji = '🔵';
    reasons.push('harga di atas SMA20, SMA20 di atas SMA50');
  } else if (sma20 && price < sma20 && Number.isFinite(changePercent) && changePercent < 0) {
    label = 'HATI-HATI / JANGAN FOMO';
    emoji = '🔴';
    reasons.push('harga di bawah SMA20 dan sedang melemah');
  }

  if (reasons.length === 0) reasons.push('belum ada sinyal kuat');
  return { label, emoji, reasons };
}

function cleanGoogleNewsTitle(title = '') {
  return String(title).replace(/\s+-\s+[^-]+$/u, '').trim();
}

function buildGoogleNewsRssUrl(query) {
  const encoded = encodeURIComponent(query);
  return `https://news.google.com/rss/search?q=${encoded}&hl=id&gl=ID&ceid=ID:id`;
}

async function fetchRssNewsBatch(newsCount = 5) {
  if (!CONFIG.rssNewsEnabled) return [];
  const allNews = [];

  for (const { query, label, source } of CONFIG.rssNewsQueries) {
    try {
      const feed = await rssParser.parseURL(buildGoogleNewsRssUrl(query));
      for (const item of (feed.items || []).slice(0, newsCount)) {
        allNews.push({
          title: cleanGoogleNewsTitle(item.title),
          publisher: source || item.creator || 'Google News',
          link: item.link,
          providerPublishTime: item.isoDate ? Math.floor(new Date(item.isoDate).getTime() / 1000) : Math.floor(Date.now() / 1000),
          related: label,
          sourceType: source || 'RSS'
        });
      }
    } catch (err) {
      console.warn(`Gagal ambil RSS ${source} (${query}):`, err.message);
    }
  }

  return allNews;
}

async function fetchYahooNewsBatch(newsCount = 5) {
  if (!CONFIG.yahooNewsEnabled || !yfSearch) return [];
  const allNews = [];

  for (const { query, label, source } of CONFIG.newsQueries) {
    try {
      const result = await yfSearch(query, { newsCount, quotesCount: 0 });
      for (const item of result.news || []) {
        allNews.push({
          title: item.title,
          publisher: item.publisher || source || 'Yahoo Finance',
          link: item.link,
          providerPublishTime: item.providerPublishTime,
          related: label,
          sourceType: source || 'Yahoo'
        });
      }
    } catch (err) {
      console.warn(`Gagal ambil berita Yahoo ${query}:`, err.message);
    }
  }

  return allNews;
}

async function fetchNewsBatch(newsCount = 5) {
  const [rssNews, yahooNews] = await Promise.all([
    fetchRssNewsBatch(newsCount),
    fetchYahooNewsBatch(newsCount)
  ]);

  const allNews = [...rssNews, ...yahooNews];
  const unique = [];
  const localSeen = new Set();

  for (const item of allNews) {
    const key = newsKey(item);
    if (!key || localSeen.has(key)) continue;
    localSeen.add(key);
    unique.push(item);
  }

  return unique.sort((a, b) => Number(b.providerPublishTime || 0) - Number(a.providerPublishTime || 0));
}

function buildTelegramMarketMessage(assets, news = []) {
  const generatedAt = dayjs().tz(CONFIG.timezone).format('DD MMM YYYY HH:mm');
  const lines = [];
  lines.push('📈 <b>Update Market Otomatis</b>');
  lines.push(`<i>${escapeHtml(generatedAt)} (${escapeHtml(CONFIG.timezone)})</i>`);
  lines.push('');

  for (const asset of assets) {
    lines.push(`${asset.signal.emoji} <b>${escapeHtml(asset.symbol)} - ${escapeHtml(asset.name)}</b>`);
    lines.push(`Harga: <b>${escapeHtml(money(asset.price, asset.currency))}</b>`);
    lines.push(`Harian: <b>${escapeHtml(pct(asset.changePercent))}</b>`);
    lines.push(`RSI: <b>${asset.rsi ? asset.rsi.toFixed(1) : '-'}</b>`);
    lines.push(`Sinyal: <b>${escapeHtml(asset.signal.label)}</b>`);
    lines.push(`Alasan: ${escapeHtml(asset.signal.reasons.join(', '))}`);
    lines.push('');
  }

  if (news.length) {
    lines.push('📰 <b>Berita Terbaru</b>');
    news.slice(0, 5).forEach((item, index) => {
      const title = escapeHtml(item.title || 'Tanpa judul');
      const publisher = item.publisher ? ` - ${escapeHtml(item.publisher)}` : '';
      const sourceType = item.sourceType ? ` / ${escapeHtml(item.sourceType)}` : '';
      const link = item.link ? `\n${escapeHtml(item.link)}` : '';
      lines.push(`${index + 1}. [${escapeHtml(item.related)}${sourceType}] ${title}${publisher}${link}`);
    });
    lines.push('');
  }

  lines.push('⚠️ <i>Disclaimer: ini alat bantu pantauan, bukan nasihat keuangan dan bukan jaminan profit.</i>');
  return lines.join('\n').slice(0, 3900);
}

function buildBreakingNewsMessage(newsItems) {
  const generatedAt = dayjs().tz(CONFIG.timezone).format('DD MMM YYYY HH:mm');
  const lines = [];
  lines.push('🚨 <b>Berita Market Baru</b>');
  lines.push(`<i>${escapeHtml(generatedAt)} (${escapeHtml(CONFIG.timezone)})</i>`);
  lines.push('');

  newsItems.slice(0, 5).forEach((item, index) => {
    const title = escapeHtml(item.title || 'Tanpa judul');
    const publisher = item.publisher ? ` - ${escapeHtml(item.publisher)}` : '';
    const sourceType = item.sourceType ? ` / ${escapeHtml(item.sourceType)}` : '';
    const link = item.link ? `\n${escapeHtml(item.link)}` : '';
    lines.push(`${index + 1}. <b>[${escapeHtml(item.related)}${sourceType}]</b> ${title}${publisher}${link}`);
    lines.push('');
  });

  lines.push('Catatan: bot cek berita secara polling, bukan push resmi dari bursa/news provider.');
  return lines.join('\n').slice(0, 3900);
}

async function sendTelegramMessage(text) {
  const botToken = requiredEnv('TELEGRAM_BOT_TOKEN');
  const chatId = requiredEnv('TELEGRAM_CHAT_ID');
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(`Telegram gagal kirim: ${data.description || res.statusText}`);
  }
}

async function seedSeenNews() {
  const currentNews = await fetchNewsBatch(5);
  for (const item of currentNews) {
    const key = newsKey(item);
    if (key) seenNews.add(key);
  }
  await saveSeenNews();
  console.log(`Seed berita selesai. ${seenNews.size} berita ditandai sudah pernah terlihat.`);
}

async function checkBreakingNews() {
  if (isNewsLoopRunning) return;
  isNewsLoopRunning = true;

  try {
    const latestNews = await fetchNewsBatch(5);
    const newItems = [];

    for (const item of latestNews) {
      const key = newsKey(item);
      if (!key || seenNews.has(key)) continue;
      seenNews.add(key);
      newItems.push(item);
    }

    if (newItems.length) {
      await saveSeenNews();
      await sendTelegramMessage(buildBreakingNewsMessage(newItems));
      console.log(`${newItems.length} berita baru terkirim ke Telegram.`);
    } else {
      console.log('Belum ada berita baru.');
    }
  } catch (err) {
    console.error('Gagal cek berita baru:', err.message);
  } finally {
    isNewsLoopRunning = false;
  }
}

async function sendMarketSummary() {
  if (isMarketLoopRunning || !CONFIG.sendMarketSummary) return;
  isMarketLoopRunning = true;

  try {
    const now = Date.now();
    if (now - lastMarketSummaryAt < CONFIG.marketSummaryMinutes * 60 * 1000) return;
    lastMarketSummaryAt = now;

    const [assets, news] = await Promise.all([
      Promise.all(CONFIG.symbols.map(getMarketData)),
      fetchNewsBatch(3)
    ]);

    await sendTelegramMessage(buildTelegramMarketMessage(assets, news));
    console.log('Ringkasan market terkirim ke Telegram.');
  } catch (err) {
    console.error('Gagal kirim ringkasan market:', err.message);
  } finally {
    isMarketLoopRunning = false;
  }
}

function startHealthServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      service: 'telegram-market-news-bot',
      time: new Date().toISOString(),
      newsPollMinutes: CONFIG.newsPollMinutes,
      marketSummaryMinutes: CONFIG.marketSummaryMinutes
    }));
  });

  server.listen(CONFIG.port, () => {
    console.log(`Health server jalan di port ${CONFIG.port}`);
  });
}

async function main() {
  requiredEnv('TELEGRAM_BOT_TOKEN');
  requiredEnv('TELEGRAM_CHAT_ID');
  startHealthServer();
  await loadSeenNews();

  if (process.argv.includes('--test-telegram')) {
    await sendTelegramMessage('✅ <b>Bot Telegram market aktif</b>\nKalau pesan ini masuk, ENV Telegram sudah benar.');
    console.log('Pesan test Telegram terkirim.');
    return;
  }

  if (seenNews.size === 0) {
    await seedSeenNews();
  }

  if (CONFIG.sendStartupMessage) {
    await sendTelegramMessage(`✅ <b>Bot market aktif</b>\nCek berita Stockbit/IHSG/Yahoo tiap ${CONFIG.newsPollMinutes} menit. Ringkasan market tiap ${CONFIG.marketSummaryMinutes} menit.`);
  }

  await sendMarketSummary();
  await checkBreakingNews();

  setInterval(checkBreakingNews, CONFIG.newsPollMinutes * 60 * 1000);
  setInterval(sendMarketSummary, 60 * 1000);
}

main().catch(err => {
  console.error('Bot gagal jalan:', err);
  process.exit(1);
});

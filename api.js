/**
 * api.js — Fetch stock quotes from local Node.js proxy (Yahoo Finance v8)
 */

const PROXY_URL = '/api/quotes';

let finnhubKey = null;

export function setFinnhubKey(key) {
  finnhubKey = key?.trim() || null;
}

/**
 * Fetch quotes for an array of symbols.
 * Uses local /api/quotes proxy (Yahoo Finance) by default,
 * or Finnhub if an API key is set.
 */
export async function fetchQuotes(symbols) {
  if (!symbols || symbols.length === 0) return [];

  if (finnhubKey) {
    return fetchFinnhubQuotes(symbols);
  }

  const res = await fetch(`${PROXY_URL}?symbols=${encodeURIComponent(symbols.join(','))}`);
  if (!res.ok) throw new Error(`Server error: HTTP ${res.status}`);
  const data = await res.json();

  const quotes = data?.quotes || [];
  if (quotes.length === 0) throw new Error('No quotes returned');
  return quotes;
}

// Optional: Finnhub real-time (no CORS, no proxy needed)
async function fetchFinnhubQuotes(symbols) {
  const results = await Promise.allSettled(symbols.map(async (symbol) => {
    const [qRes, pRes] = await Promise.allSettled([
      fetch(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${finnhubKey}`).then(r => r.json()),
      fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${symbol}&token=${finnhubKey}`).then(r => r.json()),
    ]);
    const q = qRes.status === 'fulfilled' ? qRes.value : {};
    const p = pRes.status === 'fulfilled' ? pRes.value : {};
    if (!q.c) return null;
    const change = q.c - q.pc;
    return {
      symbol,
      name: p.name || symbol,
      price: q.c, change,
      changePercent: q.pc ? (change / q.pc) * 100 : 0,
      open: q.o, high: q.h, low: q.l,
      marketState: 'REGULAR',
      timestamp: Date.now(),
    };
  }));
  return results.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean);
}

/**
 * Build a human-readable, expressive TTS string from a quote object.
 * e.g. "Apple Inc. is soaring today, up a fantastic 2.3 percent!"
 */
export function buildSpeechText(quote) {
  const pct = Math.abs(quote.changePercent);
  const isUp = quote.change >= 0;

  let emotion = "";
  if (isUp) {
    if (pct > 5) emotion = "is absolutely soaring today, up a massive";
    else if (pct > 2) emotion = "is having a great day, gaining";
    else if (pct > 0.5) emotion = "is showing a solid gain of";
    else emotion = "is slightly up, by";
  } else {
    if (pct > 5) emotion = "is taking a heavy hit today, dropping a staggering";
    else if (pct > 2) emotion = "is sliding down, losing";
    else if (pct > 0.5) emotion = "is taking a bit of a dip, down";
    else emotion = "is slightly lower today, by";
  }

  const dollars = Math.floor(Math.abs(quote.price));
  const cents = Math.round((Math.abs(quote.price) - dollars) * 100);
  const centsStr = cents > 0 ? ` and ${cents} cents` : '';

  let context = "";
  if (quote.high && Math.abs(quote.price - quote.high) < (quote.price * 0.001)) {
    context = ". It's actually trading near its daily high!";
  } else if (quote.low && Math.abs(quote.price - quote.low) < (quote.price * 0.001)) {
    context = ". It's currently near its daily low.";
  }

  return `${quote.name} ${emotion} ${pct.toFixed(1)} percent, sitting at ${dollars} dollars${centsStr}${context}`;
}


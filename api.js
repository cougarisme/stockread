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
 * Build a natural-language TTS string from a quote object.
 * e.g. "Apple Inc. is at 247 dollars and 99 cents, down 0.4 percent"
 */
export function buildSpeechText(quote) {
  const dir = quote.change >= 0 ? 'up' : 'down';
  const pct = Math.abs(quote.changePercent).toFixed(1);
  const dollars = Math.floor(Math.abs(quote.price));
  const cents = Math.round((Math.abs(quote.price) - dollars) * 100);
  const centsStr = cents > 0 ? ` and ${cents} cents` : '';
  return `${quote.name} is at ${dollars} dollars${centsStr}, ${dir} ${pct} percent`;
}

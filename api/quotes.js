/**
 * api/quotes.js — Vercel Serverless Function
 * Proxies Yahoo Finance v8 chart API (no CORS, no API key needed)
 *
 * Route: GET /api/quotes?symbols=AAPL,TSLA,NVDA
 */

const https = require('https');

const YAHOO_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
};

function fetchOneSymbol(symbol) {
    return new Promise((resolve, reject) => {
        const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
        https.get(yahooUrl, { headers: YAHOO_HEADERS }, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const meta = json?.chart?.result?.[0]?.meta;
                    if (!meta) return reject(new Error(`No data for ${symbol}`));

                    const prevClose = meta.chartPreviousClose ?? meta.regularMarketPrice;
                    const price = meta.regularMarketPrice;
                    const change = price - prevClose;

                    resolve({
                        symbol: meta.symbol,
                        name: meta.longName || meta.shortName || meta.symbol,
                        price,
                        change,
                        changePercent: prevClose ? (change / prevClose) * 100 : 0,
                        open: meta.regularMarketPrice,
                        high: meta.regularMarketDayHigh,
                        low: meta.regularMarketDayLow,
                        marketState: meta.marketState || 'CLOSED',
                    });
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

module.exports = async function handler(req, res) {
    // CORS headers (allows browser fetch from any domain)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }

    const symbolsParam = req.query.symbols || '';
    const symbols = symbolsParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

    if (symbols.length === 0) {
        res.status(400).json({ error: 'No symbols provided' });
        return;
    }

    try {
        const results = await Promise.allSettled(symbols.map(fetchOneSymbol));
        const quotes = results
            .map(r => r.status === 'fulfilled' ? r.value : null)
            .filter(Boolean);

        res.status(200).json({ quotes });
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
};

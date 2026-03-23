/**
 * api/search.js — Vercel Serverless Function
 * Proxies Yahoo Finance search API
 *
 * Route: GET /api/search?q=query
 */

const https = require('https');

const YAHOO_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
};

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }

    const query = req.query.q || '';
    if (!query) {
        res.status(400).json({ error: 'No query provided' });
        return;
    }

    try {
        const yahooUrl = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}`;
        const result = await new Promise((resolve, reject) => {
            https.get(yahooUrl, { headers: YAHOO_HEADERS }, (proxyRes) => {
                let data = '';
                proxyRes.on('data', c => { data += c; });
                proxyRes.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        const quotes = json?.quotes || [];
                        const results = quotes
                            .filter(q => q.quoteType === 'EQUITY' || q.quoteType === 'ETF')
                            .map(q => ({
                                symbol: q.symbol,
                                name: q.shortname || q.longname || q.symbol,
                                exchange: q.exchange,
                                type: q.quoteType
                            }));
                        resolve(results);
                    } catch (e) {
                        reject(e);
                    }
                });
            }).on('error', reject);
        });

        res.status(200).json({ results: result });
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
};

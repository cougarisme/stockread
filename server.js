/**
 * server.js — Local proxy server for Yahoo Finance (v8 chart endpoint)
 * Serves static files AND proxies Yahoo Finance — no CORS issues, no API key needed.
 *
 * Usage:  node server.js
 * Open:   http://localhost:3000
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3000;

const MIME = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.ico': 'image/x-icon',
};

const YAHOO_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
};

// Fetch a single symbol from Yahoo Finance v8 chart endpoint
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
                        open: meta.regularMarketPrice,   // v8 doesn't expose open directly
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

// API handler: GET /api/quotes?symbols=AAPL,TSLA,...
async function handleQuotes(reqUrl, res) {
    const parsed = url.parse(reqUrl, true);
    const symbols = (parsed.query.symbols || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

    if (symbols.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No symbols provided' }));
        return;
    }

    try {
        const results = await Promise.allSettled(symbols.map(fetchOneSymbol));
        const quotes = results
            .map(r => r.status === 'fulfilled' ? r.value : null)
            .filter(Boolean);

        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({ quotes }));
    } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
    }
}

// Static file handler
function serveStatic(reqPath, res) {
    const filePath = path.join(__dirname, reqPath === '/' ? 'index.html' : reqPath);
    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(err.code === 'ENOENT' ? 404 : 500);
            res.end(err.code === 'ENOENT' ? '404 Not Found' : '500 Error');
            return;
        }
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
        res.end(content);
    });
}

// Main server
const server = http.createServer((req, res) => {
    const parsed = url.parse(req.url);
    if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
        res.end();
        return;
    }
    if (parsed.pathname === '/api/quotes') {
        handleQuotes(req.url, res);
    } else {
        serveStatic(parsed.pathname, res);
    }
});

server.listen(PORT, () => {
    console.log(`\n✅  StockRead running at http://localhost:${PORT}`);
    console.log(`    Data source: Yahoo Finance (free, real-time)\n`);
});

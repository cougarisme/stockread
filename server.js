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
const os = require('os');
const { spawn } = require('child_process');

// Load .env if present (simple local helper)
if (fs.existsSync('.env')) {
    const dotenv = fs.readFileSync('.env', 'utf8');
    dotenv.split('\n').forEach(line => {
        const [k, v] = line.split('=');
        if (k && v) process.env[k.trim()] = v.trim();
    });
}

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

function fetchJson(urlToFetch) {
    return new Promise((resolve, reject) => {
        https.get(urlToFetch, { headers: YAHOO_HEADERS }, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => {
                try {
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        return reject(new Error(`HTTP ${res.statusCode}`));
                    }
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

function quoteFromChartJson(symbol, json) {
    const meta = json?.chart?.result?.[0]?.meta;
    if (!meta || typeof meta.regularMarketPrice !== 'number') return null;
    const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? meta.regularMarketPrice;
    const price = meta.regularMarketPrice;
    const change = price - prevClose;

    return {
        symbol: meta.symbol || symbol,
        name: meta.longName || meta.shortName || meta.symbol || symbol,
        price,
        change,
        changePercent: prevClose ? (change / prevClose) * 100 : 0,
        open: typeof meta.regularMarketOpen === 'number' ? meta.regularMarketOpen : price,
        high: meta.regularMarketDayHigh,
        low: meta.regularMarketDayLow,
        marketState: meta.marketState || 'CLOSED',
    };
}

function quoteFromV7Json(symbol, json) {
    const q = json?.quoteResponse?.result?.[0];
    if (!q || typeof q.regularMarketPrice !== 'number') return null;
    const prevClose = q.regularMarketPreviousClose ?? q.regularMarketPrice;
    const price = q.regularMarketPrice;
    const change = typeof q.regularMarketChange === 'number'
        ? q.regularMarketChange
        : (price - prevClose);
    const changePercent = typeof q.regularMarketChangePercent === 'number'
        ? q.regularMarketChangePercent
        : (prevClose ? (change / prevClose) * 100 : 0);

    return {
        symbol: q.symbol || symbol,
        name: q.longName || q.shortName || q.displayName || q.symbol || symbol,
        price,
        change,
        changePercent,
        open: q.regularMarketOpen ?? price,
        high: q.regularMarketDayHigh,
        low: q.regularMarketDayLow,
        marketState: q.marketState || 'CLOSED',
    };
}

// Fetch a single symbol from Yahoo, with endpoint/host fallback.
async function fetchOneSymbol(symbol) {
    const encoded = encodeURIComponent(symbol);
    const attempts = [
        {
            url: `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=1d`,
            parser: (json) => quoteFromChartJson(symbol, json),
        },
        {
            url: `https://query2.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=1d`,
            parser: (json) => quoteFromChartJson(symbol, json),
        },
        {
            url: `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encoded}`,
            parser: (json) => quoteFromV7Json(symbol, json),
        },
        {
            url: `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encoded}`,
            parser: (json) => quoteFromV7Json(symbol, json),
        },
    ];

    let lastError = null;
    for (const attempt of attempts) {
        try {
            const json = await fetchJson(attempt.url);
            const quote = attempt.parser(json);
            if (quote) return quote;
            lastError = new Error('No quote data in response');
        } catch (err) {
            lastError = err;
        }
    }
    throw new Error(`No data for ${symbol}: ${lastError?.message || 'unknown error'}`);
}

// Fetch search results from Yahoo Finance search endpoint
function fetchSearchResults(query) {
    return new Promise((resolve, reject) => {
        const yahooUrl = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}`;
        https.get(yahooUrl, { headers: YAHOO_HEADERS }, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => {
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

    const results = await Promise.allSettled(symbols.map(fetchOneSymbol));
    const quotes = results
        .map(r => r.status === 'fulfilled' ? r.value : null)
        .filter(Boolean);
    const errors = results
        .map((r, i) => r.status === 'rejected' ? `${symbols[i]}: ${r.reason?.message || 'fetch failed'}` : null)
        .filter(Boolean);

    if (quotes.length === 0) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: 'Unable to fetch quotes from upstream provider.',
            details: errors,
        }));
        return;
    }

    res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ quotes, errors }));
}

// API handler: GET /api/search?q=query
async function handleSearch(reqUrl, res) {
    const parsed = url.parse(reqUrl, true);
    const query = parsed.query.q || '';

    if (!query) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No query provided' }));
        return;
    }

    try {
        const results = await fetchSearchResults(query);
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({ results }));
    } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
    }
}

// API handler: GET /api/tts?text=...
function handleTTS(reqUrl, res) {
    const parsed = url.parse(reqUrl, true);
    const text = String(parsed.query.text || '').trim();

    if (!text) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No text provided' }));
        return;
    }

    const clippedText = text.slice(0, 500);
    const tmpFile = path.join(os.tmpdir(), `stockread-tts-${Date.now()}-${Math.random().toString(16).slice(2)}.aiff`);
    const sayArgs = ['-v', 'Samantha', '-o', tmpFile, clippedText];

    const sayProc = spawn('say', sayArgs);
    let stderr = '';

    sayProc.stderr.on('data', (chunk) => {
        stderr += String(chunk);
    });

    sayProc.on('error', (err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `TTS failed to start: ${err.message}` }));
    });

    sayProc.on('close', (code) => {
        if (code !== 0) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `TTS generation failed (${code})`, details: stderr.trim() }));
            return;
        }

        fs.readFile(tmpFile, (readErr, content) => {
            fs.unlink(tmpFile, () => { });
            if (readErr) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unable to read generated audio file' }));
                return;
            }

            res.writeHead(200, {
                'Content-Type': 'audio/aiff',
                'Content-Length': content.length,
                'Cache-Control': 'no-store',
                'Access-Control-Allow-Origin': '*',
            });
            res.end(content);
        });
    });
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
    } else if (parsed.pathname === '/api/search') {
        handleSearch(req.url, res);
    } else if (parsed.pathname === '/api/tts') {
        handleTTS(req.url, res);
    } else {
        serveStatic(parsed.pathname, res);
    }
});

server.listen(PORT, () => {
    console.log(`\n✅  StockRead running at http://localhost:${PORT}`);
    console.log(`    Data source: Yahoo Finance (free, real-time)\n`);
});

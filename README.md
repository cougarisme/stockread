# StockRead

A hands-free stock price webapp for driving. Reads your portfolio aloud via Text-to-Speech and accepts voice commands.

## How to Run Locally

```bash
node server.js
# Open: http://localhost:3000
```

## Deploy to Vercel (Free)

```bash
npm i -g vercel
vercel
```

Follow the prompts — your app will be live at a `*.vercel.app` URL in ~30 seconds.

## Voice Commands (Chrome / Edge)

| Say | Action |
|---|---|
| "read prices" | Read all stocks aloud |
| "how is AAPL doing" | Read one stock |
| "add GOOG" | Add to watchlist |
| "remove TSLA" | Remove from watchlist |
| "pause" / "resume" | Toggle auto-announce |

## Data Source

Yahoo Finance (free, no API key) via the v8 chart endpoint.

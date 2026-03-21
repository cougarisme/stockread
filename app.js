/**
 * app.js — Main orchestrator for StockRead driving mode app
 */

import { fetchQuotes, buildSpeechText, setFinnhubKey } from './api.js';
import {
    initTTS, speak, cancelSpeech, isSpeaking,
    initSTT, startListening, stopListening, isListening,
    isSpeechRecognitionSupported, parseCommand
} from './speech.js';

// ─── State ───────────────────────────────────────────────────────────────────

const DEFAULT_WATCHLIST = ['AAPL', 'TSLA', 'NVDA', 'MSFT', 'AMZN'];
const REFRESH_INTERVAL_MS = 60_000;   // refresh prices every 60s
const ANNOUNCE_INTERVAL_MS = 300_000; // auto-announce every 5 min

let watchlist = [];
let quotes = {};           // symbol → quote object
let autoPaused = false;
let refreshTimer = null;
let announceTimer = null;
let announceCountdown = ANNOUNCE_INTERVAL_MS / 1000;
let countdownTimer = null;

// ─── DOM refs ────────────────────────────────────────────────────────────────

const grid = document.getElementById('stock-grid');
const micBtn = document.getElementById('mic-btn');
const micIcon = document.getElementById('mic-icon');
const statusText = document.getElementById('status-text');
const countdownEl = document.getElementById('countdown');
const pauseBtn = document.getElementById('pause-btn');
const addForm = document.getElementById('add-form');
const addInput = document.getElementById('add-input');
const lastUpdateEl = document.getElementById('last-update');
const sttUnsupportedBanner = document.getElementById('stt-unsupported');
const loadingOverlay = document.getElementById('loading-overlay');
const apiKeyForm = document.getElementById('api-key-form');
const apiKeyInput = document.getElementById('api-key-input');
const apiKeyStatus = document.getElementById('api-key-status');

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
    loadWatchlist();

    // Load saved Finnhub key
    const savedKey = localStorage.getItem('stockread-finnhub-key');
    if (savedKey) {
        setFinnhubKey(savedKey);
        if (apiKeyInput) apiKeyInput.value = savedKey;
        if (apiKeyStatus) apiKeyStatus.textContent = '✓ Finnhub key active';
    }

    initTTS();

    const sttOk = initSTT({
        onCommand: handleVoiceCommand,
        onStart: () => {
            micBtn.classList.add('listening');
            micIcon.textContent = '🎙️';
            setStatus('Listening…');
            cancelSpeech();
        },
        onEnd: () => {
            micBtn.classList.remove('listening');
            micIcon.textContent = '🎤';
            setStatus(autoPaused ? '⏸ Paused' : '● Live');
        },
        onError: (err) => {
            micBtn.classList.remove('listening');
            micIcon.textContent = '🎤';
            setStatus('Mic error: ' + err);
        }
    });

    if (!isSpeechRecognitionSupported()) {
        sttUnsupportedBanner.style.display = 'flex';
        micBtn.disabled = true;
        micBtn.title = 'Speech recognition not supported in this browser';
    }

    // Mic button: click to start listening
    micBtn.addEventListener('click', () => {
        if (isListening()) {
            stopListening();
        } else {
            startListening();
        }
    });

    pauseBtn.addEventListener('click', () => {
        autoPaused = !autoPaused;
        pauseBtn.textContent = autoPaused ? '▶ Resume' : '⏸ Pause';
        setStatus(autoPaused ? '⏸ Paused' : '● Live');
        if (!autoPaused) resetAnnounceCountdown();
    });

    addForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const sym = addInput.value.trim().toUpperCase().replace(/[^A-Z.]/g, '');
        if (sym) addStock(sym);
        addInput.value = '';
    });

    // Finnhub API key form
    if (apiKeyForm) {
        apiKeyForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const key = apiKeyInput?.value?.trim();
            if (key) {
                setFinnhubKey(key);
                localStorage.setItem('stockread-finnhub-key', key);
                if (apiKeyStatus) apiKeyStatus.textContent = '✓ Key saved — refreshing…';
                refresh();
            } else {
                setFinnhubKey(null);
                localStorage.removeItem('stockread-finnhub-key');
                if (apiKeyStatus) apiKeyStatus.textContent = 'Key cleared — using Yahoo proxy';
            }
        });
    }

    await refresh();
    startTimers();

    speak('StockRead is ready. I will read your portfolio prices every 5 minutes. Tap the mic to give a voice command.', { priority: true });
}

// ─── Watchlist ────────────────────────────────────────────────────────────────

function loadWatchlist() {
    const saved = localStorage.getItem('stockread-watchlist');
    watchlist = saved ? JSON.parse(saved) : [...DEFAULT_WATCHLIST];
}

function saveWatchlist() {
    localStorage.setItem('stockread-watchlist', JSON.stringify(watchlist));
}

function addStock(symbol) {
    if (watchlist.includes(symbol)) {
        speak(`${symbol} is already in your watchlist.`, { priority: true });
        return;
    }
    watchlist.push(symbol);
    saveWatchlist();
    speak(`Added ${symbol} to your watchlist.`, { priority: true });
    refresh();
}

function removeStock(symbol) {
    const idx = watchlist.indexOf(symbol);
    if (idx === -1) {
        speak(`${symbol} is not in your watchlist.`, { priority: true });
        return;
    }
    watchlist.splice(idx, 1);
    saveWatchlist();
    delete quotes[symbol];
    renderGrid();
    speak(`Removed ${symbol} from your watchlist.`, { priority: true });
}

// ─── Data Refresh ─────────────────────────────────────────────────────────────

async function refresh() {
    if (watchlist.length === 0) return;
    try {
        const results = await fetchQuotes(watchlist);
        results.forEach(q => { quotes[q.symbol] = q; });
        renderGrid();
        const now = new Date();
        lastUpdateEl.textContent = `Updated ${now.toLocaleTimeString()}`;
    } catch (err) {
        console.error('Refresh error:', err);
        setStatus('⚠ Data error — retrying…');
    }

    if (loadingOverlay) loadingOverlay.style.display = 'none';
}

// ─── Timers ───────────────────────────────────────────────────────────────────

function startTimers() {
    clearInterval(refreshTimer);
    clearInterval(announceTimer);
    clearInterval(countdownTimer);

    refreshTimer = setInterval(refresh, REFRESH_INTERVAL_MS);

    resetAnnounceCountdown();
    countdownTimer = setInterval(() => {
        if (autoPaused) return;
        announceCountdown--;
        if (announceCountdown <= 0) {
            announceAll();
            resetAnnounceCountdown();
        }
        updateCountdownDisplay();
    }, 1000);
}

function resetAnnounceCountdown() {
    announceCountdown = ANNOUNCE_INTERVAL_MS / 1000;
    updateCountdownDisplay();
}

function updateCountdownDisplay() {
    const m = Math.floor(announceCountdown / 60);
    const s = announceCountdown % 60;
    countdownEl.textContent = `Next update in ${m}:${String(s).padStart(2, '0')}`;
}

// ─── Announce ─────────────────────────────────────────────────────────────────

function announceAll() {
    if (autoPaused || watchlist.length === 0) return;

    speak("Here's your portfolio update.", { priority: true });

    watchlist.forEach(symbol => {
        const q = quotes[symbol];
        if (!q) return;

        const text = buildSpeechText(q);
        const isUp = q.change >= 0;
        const pct = Math.abs(q.changePercent);

        // Dynamic emotions
        let pitch = 1.0;
        let rate = 0.93;

        if (isUp) {
            pitch = 1.05 + (Math.min(pct, 10) / 100); // 1.05 to 1.15
            rate = 0.95 + (Math.min(pct, 10) / 200);  // 0.95 to 1.0
        } else {
            pitch = 0.95 - (Math.min(pct, 10) / 100); // 0.95 down to 0.85
            rate = 0.90 - (Math.min(pct, 10) / 200);  // 0.90 down to 0.85
        }

        speak(text, { pitch, rate });
    });
}

function announceOne(symbol) {
    const q = quotes[symbol];
    if (!q) {
        speak(`I don't have data for ${symbol} yet.`, { priority: true });
        return;
    }

    const text = buildSpeechText(q);
    const isUp = q.change >= 0;
    const pct = Math.abs(q.changePercent);

    let pitch = 1.0;
    let rate = 0.93;

    if (isUp) {
        pitch = 1.05 + (Math.min(pct, 10) / 100);
        rate = 0.95 + (Math.min(pct, 10) / 200);
    } else {
        pitch = 0.95 - (Math.min(pct, 10) / 100);
        rate = 0.90 - (Math.min(pct, 10) / 200);
    }

    speak(text, { priority: true, pitch, rate });
}

// ─── Voice Command Handler ────────────────────────────────────────────────────

function handleVoiceCommand(transcript) {
    const cmd = parseCommand(transcript);
    if (!cmd) {
        speak("Sorry, I didn't catch that. Try saying: read prices, add AAPL, or remove TSLA.", { priority: true });
        return;
    }

    switch (cmd.type) {
        case 'READ_ALL':
            announceAll();
            break;
        case 'PAUSE':
            autoPaused = true;
            pauseBtn.textContent = '▶ Resume';
            setStatus('⏸ Paused');
            speak('Auto-announce paused.', { priority: true });
            break;
        case 'RESUME':
            autoPaused = false;
            pauseBtn.textContent = '⏸ Pause';
            setStatus('● Live');
            resetAnnounceCountdown();
            speak('Auto-announce resumed.', { priority: true });
            break;
        case 'ADD':
            addStock(cmd.payload);
            break;
        case 'REMOVE':
            removeStock(cmd.payload);
            break;
        case 'READ_ONE':
            announceOne(cmd.payload);
            break;
    }
}

// ─── Render ───────────────────────────────────────────────────────────────────

function renderGrid() {
    grid.innerHTML = '';
    watchlist.forEach(symbol => {
        const q = quotes[symbol];
        const card = document.createElement('div');
        card.className = 'stock-card';
        card.dataset.symbol = symbol;

        if (!q) {
            card.innerHTML = `
        <div class="card-symbol">${symbol}</div>
        <div class="card-price loading-pulse">—</div>
        <div class="card-change neutral">Loading…</div>
      `;
            card.addEventListener('click', () => announceOne(symbol));
            grid.appendChild(card);
            return;
        }

        const up = q.change >= 0;
        const changeClass = up ? 'positive' : 'negative';
        const arrow = up ? '▲' : '▼';
        const pct = q.changePercent.toFixed(2);
        const price = q.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const changeAbs = Math.abs(q.change).toFixed(2);

        card.classList.add(changeClass);
        card.innerHTML = `
      <button class="remove-btn" title="Remove ${symbol}" aria-label="Remove ${symbol}">✕</button>
      <div class="card-symbol">${symbol}</div>
      <div class="card-name">${q.name}</div>
      <div class="card-price">$${price}</div>
      <div class="card-change ${changeClass}">
        ${arrow} $${changeAbs} (${pct}%)
      </div>
      <div class="card-meta">
        <span>O: $${q.open?.toFixed(2) ?? '—'}</span>
        <span>H: $${q.high?.toFixed(2) ?? '—'}</span>
        <span>L: $${q.low?.toFixed(2) ?? '—'}</span>
      </div>
      <div class="card-market-state ${q.marketState === 'REGULAR' ? 'open' : 'closed'}">
        ${q.marketState === 'REGULAR' ? '● Market Open' : '○ After Hours'}
      </div>
    `;

        card.querySelector('.remove-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            removeStock(symbol);
        });
        card.addEventListener('click', () => announceOne(symbol));
        grid.appendChild(card);
    });
}

function setStatus(msg) {
    statusText.textContent = msg;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', init);

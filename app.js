/**
 * app.js — Main orchestrator for StockRead driving mode app
 */

import { fetchQuotes, buildSpeechText, setFinnhubKey, searchStocks, chatWithAI } from './api.js';
import {
    initTTS, speak, cancelSpeech, isSpeaking, setSpeechOutputMode,
    initSTT, startListening, stopListening, isListening,
    isSpeechRecognitionSupported, parseCommand, enableInterruptionMode
} from './speech.js';

// ─── State ───────────────────────────────────────────────────────────────────

const DEFAULT_WATCHLIST = ['AAPL', 'TSLA', 'NVDA', 'MSFT', 'AMZN'];
const REFRESH_INTERVAL_MS = 60_000;   // refresh prices every 60s
const DEFAULT_ANNOUNCE_INTERVAL_MIN = 5;
const ANNOUNCE_INTERVAL_STORAGE_KEY = 'stockread-announce-interval-min';
const SPEECH_OUTPUT_STORAGE_KEY = 'stockread-speech-output-mode';
const USER_ID_PARAM = 'u';
const ACTIVE_USER_STORAGE_KEY = 'stockread-active-user-id';
const WATCHLIST_STORAGE_PREFIX = 'stockread-watchlist-user-';

let watchlist = [];
let quotes = {};           // symbol → quote object
let autoPaused = false;
let refreshTimer = null;
let announceTimer = null;
let announceIntervalMs = DEFAULT_ANNOUNCE_INTERVAL_MIN * 60_000;
let announceCountdown = announceIntervalMs / 1000;
let countdownTimer = null;
let isEditMode = false;
let currentUserId = '';

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
const aiKeyForm = document.getElementById('ai-key-form');
const aiKeyInput = document.getElementById('ai-key-input');
const aiKeyStatus = document.getElementById('ai-key-status');
const searchResults = document.getElementById('search-results');
const editBtn = document.getElementById('edit-btn');
const intervalSelect = document.getElementById('interval-select');
const speechOutputSelect = document.getElementById('speech-output-select');
const editHint = document.getElementById('edit-hint');

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
    currentUserId = getOrCreateUserId();
    loadWatchlist();
    loadAnnounceInterval();
    loadSpeechOutputMode();

    // Load saved Finnhub key
    const savedKey = localStorage.getItem('stockread-finnhub-key');
    if (savedKey) {
        setFinnhubKey(savedKey);
        if (apiKeyInput) apiKeyInput.value = savedKey;
        if (apiKeyStatus) apiKeyStatus.textContent = '✓ Finnhub key active';
    }

    // Load saved Gemini key
    const savedAiKey = localStorage.getItem('stockread-ai-key');
    if (savedAiKey) {
        if (aiKeyInput) aiKeyInput.value = savedAiKey;
        if (aiKeyStatus) aiKeyStatus.textContent = '✓ AI Chatbot active';
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
    enableInterruptionMode();

    if (!isSpeechRecognitionSupported()) {
        sttUnsupportedBanner.style.display = 'flex';
        micBtn.disabled = true;
        micBtn.title = 'Speech recognition not supported in this browser';
    }

    micBtn.addEventListener('click', () => {
        if (isListening()) {
            stopListening();
        } else {
            startListening();
        }
    });

    if (editBtn) {
        editBtn.addEventListener('click', () => {
            isEditMode = !isEditMode;
            editBtn.classList.toggle('active', isEditMode);
            editBtn.textContent = isEditMode ? '✓ Done' : '✎ Edit List';
            grid.classList.toggle('edit-mode', isEditMode);
            if (addForm) {
                addForm.style.display = isEditMode ? 'flex' : 'none';
            }
            if (editHint) {
                editHint.style.display = isEditMode ? 'block' : 'none';
            }
            if (!isEditMode) {
                addInput.value = '';
                searchResults.style.display = 'none';
            } else {
                addInput.focus();
            }
            renderGrid();
        });
    }

    if (intervalSelect) {
        intervalSelect.value = String(announceIntervalMs / 60_000);
        intervalSelect.addEventListener('change', () => {
            const minutes = Number(intervalSelect.value);
            setAnnounceInterval(minutes);
            speak(`Read interval set to ${minutes} minute${minutes === 1 ? '' : 's'}.`, { priority: true, pitch: 1.08, rate: 1.0 });
        });
    }

    if (speechOutputSelect) {
        const savedMode = localStorage.getItem(SPEECH_OUTPUT_STORAGE_KEY) || 'browser';
        speechOutputSelect.value = savedMode;
        speechOutputSelect.addEventListener('change', () => {
            const mode = speechOutputSelect.value === 'stream' ? 'stream' : 'browser';
            setSpeechOutputMode(mode);
            localStorage.setItem(SPEECH_OUTPUT_STORAGE_KEY, mode);
            const label = mode === 'stream' ? 'audio stream mode' : 'browser voice mode';
            speak(`Switched to ${label}.`, { priority: true, pitch: 1.02, rate: 1.0 });
        });
    }

    pauseBtn.addEventListener('click', () => {
        autoPaused = !autoPaused;
        pauseBtn.textContent = autoPaused ? '▶ Resume' : '⏸ Pause';
        setStatus(autoPaused ? '⏸ Paused' : '● Live');
        if (!autoPaused) resetAnnounceCountdown();
    });

    addForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const sym = addInput.value.trim().toUpperCase().replace(/[^A-Z.]/g, '');
        if (sym) {
            addStock(sym);
            searchResults.style.display = 'none';
        }
        addInput.value = '';
    });

    // Search logic with debounce
    let searchDebounce = null;
    addInput.addEventListener('input', () => {
        const query = addInput.value.trim();
        clearTimeout(searchDebounce);
        if (query.length < 2) {
            searchResults.style.display = 'none';
            return;
        }

        searchDebounce = setTimeout(async () => {
            try {
                const results = await searchStocks(query);
                renderSearchResults(results);
            } catch (err) {
                console.warn('Search error:', err);
            }
        }, 300);
    });

    // Close search results when clicking outside
    document.addEventListener('click', (e) => {
        if (!addForm.contains(e.target)) {
            searchResults.style.display = 'none';
        }
    });

    // AI API key form
    if (aiKeyForm) {
        aiKeyForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const key = aiKeyInput?.value?.trim();
            if (key) {
                localStorage.setItem('stockread-ai-key', key);
                if (aiKeyStatus) aiKeyStatus.textContent = '✓ AI Key saved';
            } else {
                localStorage.removeItem('stockread-ai-key');
                if (aiKeyStatus) aiKeyStatus.textContent = 'AI Key cleared';
            }
        });
    }

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

    const initialMinutes = Math.round(announceIntervalMs / 60_000);
    speak(`StockRead is ready. I will read your portfolio every ${initialMinutes} minute${initialMinutes === 1 ? '' : 's'}. Tap the mic to give a voice command.`, { priority: true });
}

// ─── Watchlist ────────────────────────────────────────────────────────────────

function loadWatchlist() {
    const saved = localStorage.getItem(getUserWatchlistStorageKey());
    watchlist = saved ? JSON.parse(saved) : [...DEFAULT_WATCHLIST];
}

function saveWatchlist() {
    localStorage.setItem(getUserWatchlistStorageKey(), JSON.stringify(watchlist));
}

function getUserWatchlistStorageKey() {
    return `${WATCHLIST_STORAGE_PREFIX}${currentUserId}`;
}

function getOrCreateUserId() {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = sanitizeUserId(params.get(USER_ID_PARAM));
    const fromStorage = sanitizeUserId(localStorage.getItem(ACTIVE_USER_STORAGE_KEY));
    const userId = fromUrl || fromStorage || generateUserId();

    localStorage.setItem(ACTIVE_USER_STORAGE_KEY, userId);
    if (params.get(USER_ID_PARAM) !== userId) {
        params.set(USER_ID_PARAM, userId);
        const nextUrl = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
        history.replaceState({}, '', nextUrl);
    }
    return userId;
}

function sanitizeUserId(raw) {
    if (!raw) return '';
    const normalized = String(raw).trim();
    return /^[a-zA-Z0-9_-]{8,40}$/.test(normalized) ? normalized : '';
}

function generateUserId() {
    if (window.crypto?.randomUUID) {
        return window.crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    }
    return `u${Math.random().toString(36).slice(2, 14)}`;
}

function loadAnnounceInterval() {
    const saved = Number(localStorage.getItem(ANNOUNCE_INTERVAL_STORAGE_KEY));
    if (!Number.isFinite(saved)) return;
    setAnnounceInterval(saved, { persist: false, restart: false });
}

function loadSpeechOutputMode() {
    const mode = localStorage.getItem(SPEECH_OUTPUT_STORAGE_KEY) || 'browser';
    setSpeechOutputMode(mode);
}

function setAnnounceInterval(minutes, { persist = true, restart = true } = {}) {
    const clampedMinutes = Math.min(60, Math.max(1, Math.round(minutes || DEFAULT_ANNOUNCE_INTERVAL_MIN)));
    announceIntervalMs = clampedMinutes * 60_000;
    if (persist) {
        localStorage.setItem(ANNOUNCE_INTERVAL_STORAGE_KEY, String(clampedMinutes));
    }
    if (restart) {
        resetAnnounceCountdown();
    }
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
    let targetSymbol = symbol.toUpperCase();

    // Fuzzy match: if symbol not in list, check company names in our current quotes
    if (!watchlist.includes(targetSymbol)) {
        const found = Object.values(quotes).find(q =>
            q.name.toLowerCase().includes(symbol.toLowerCase()) ||
            q.symbol.toUpperCase() === targetSymbol
        );
        if (found && watchlist.includes(found.symbol)) {
            targetSymbol = found.symbol;
        }
    }

    const idx = watchlist.indexOf(targetSymbol);
    if (idx === -1) {
        speak(`I couldn't find ${symbol} in your watchlist.`, { priority: true });
        return;
    }
    watchlist.splice(idx, 1);
    saveWatchlist();
    delete quotes[targetSymbol];
    renderGrid();
    speak(`Removed ${targetSymbol} from your watchlist.`, { priority: true });
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
    announceCountdown = announceIntervalMs / 1000;
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
    if (transcript === "__WAKE_WORD__") {
        cancelSpeech();
        speak("Yes?", { priority: true, rate: 1.1 });
        setStatus('Listening (Wake-word)…');
        return;
    }
    const cmd = parseCommand(transcript);
    if (!cmd) {
        // Fallback to AI Chatbot if key is available
        const aiKey = localStorage.getItem('stockread-ai-key');
        if (aiKey) {
            handleAIChat(transcript, aiKey);
        } else {
            speak("Sorry, I didn't catch that. Try saying: read prices, add AAPL, or remove TSLA.", { priority: true });
        }
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

async function handleAIChat(message, apiKey) {
    setStatus('Thinking…');
    try {
        const context = watchlist.map(s => ({
            symbol: s,
            price: quotes[s]?.price,
            change: quotes[s]?.changePercent
        }));

        const response = await chatWithAI(message, context, apiKey);
        speak(response, { priority: true });
    } catch (err) {
        console.error('AI error:', err);
        speak("I'm sorry, I'm having trouble connecting to my brain right now.", { priority: true });
    } finally {
        setStatus(autoPaused ? '⏸ Paused' : '● Live');
    }
}

// ─── Render ───────────────────────────────────────────────────────────────────

function renderSearchResults(results) {
    if (results.length === 0) {
        searchResults.style.display = 'none';
        return;
    }

    searchResults.innerHTML = '';
    results.forEach(res => {
        const div = document.createElement('div');
        div.className = 'search-item';
        div.innerHTML = `
            <span class="search-item-symbol">${res.symbol}</span>
            <span class="search-item-name">${res.name}</span>
        `;
        div.addEventListener('click', () => {
            addStock(res.symbol);
            addInput.value = '';
            searchResults.style.display = 'none';
        });
        searchResults.appendChild(div);
    });
    searchResults.style.display = 'block';
}

function renderGrid() {
    grid.innerHTML = '';
    grid.classList.toggle('edit-mode', isEditMode);
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
            if (!isEditMode) {
                card.addEventListener('click', () => announceOne(symbol));
            }
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
        const removeButtonHtml = isEditMode
            ? `<button class="remove-btn" title="Remove ${symbol}" aria-label="Remove ${symbol}">✕</button>`
            : '';
        card.innerHTML = `
      ${removeButtonHtml}
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

        const removeBtn = card.querySelector('.remove-btn');
        if (removeBtn) {
            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                removeStock(symbol);
            });
        }
        if (!isEditMode) {
            card.addEventListener('click', () => announceOne(symbol));
        }
        grid.appendChild(card);
    });
}

function setStatus(msg) {
    statusText.textContent = msg;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', init);

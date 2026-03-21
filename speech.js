/**
 * speech.js — TTS (Text-to-Speech) + STT (Speech Recognition) module
 */

// ─── TTS ────────────────────────────────────────────────────────────────────

let ttsVoice = null;
let ttsPitch = 1;
let ttsRate = 0.93;
let ttsVolume = 1;

export function initTTS() {
    const loadVoices = () => {
        const voices = speechSynthesis.getVoices();
        // Prefer a natural English voice
        ttsVoice =
            voices.find(v => v.name.includes('Samantha')) ||
            voices.find(v => v.lang === 'en-US' && !v.localService === false) ||
            voices.find(v => v.lang === 'en-US') ||
            voices[0] || null;
    };
    loadVoices();
    speechSynthesis.onvoiceschanged = loadVoices;
}

export function speak(text, { priority = false } = {}) {
    if (!window.speechSynthesis) return;
    if (priority) speechSynthesis.cancel();

    const utter = new SpeechSynthesisUtterance(text);
    utter.voice = ttsVoice;
    utter.pitch = ttsPitch;
    utter.rate = ttsRate;
    utter.volume = ttsVolume;
    speechSynthesis.speak(utter);
    return utter;
}

export function cancelSpeech() {
    if (window.speechSynthesis) speechSynthesis.cancel();
}

export function isSpeaking() {
    return window.speechSynthesis?.speaking || false;
}

// ─── STT ────────────────────────────────────────────────────────────────────

const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

let recognition = null;
let sttActive = false;
let onCommandCallback = null;
let onStartCallback = null;
let onEndCallback = null;
let onErrorCallback = null;

export function isSpeechRecognitionSupported() {
    return !!SpeechRecognition;
}

export function initSTT({ onCommand, onStart, onEnd, onError } = {}) {
    if (!SpeechRecognition) return false;

    onCommandCallback = onCommand;
    onStartCallback = onStart;
    onEndCallback = onEnd;
    onErrorCallback = onError;

    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = 'en-US';

    recognition.onstart = () => {
        sttActive = true;
        onStartCallback?.();
    };

    recognition.onend = () => {
        sttActive = false;
        onEndCallback?.();
    };

    recognition.onerror = (e) => {
        sttActive = false;
        onErrorCallback?.(e.error);
    };

    recognition.onresult = (e) => {
        const transcript = e.results[e.results.length - 1][0].transcript.trim().toLowerCase();
        console.log('Voice input:', transcript);
        onCommandCallback?.(transcript);
    };

    return true;
}

export function startListening() {
    if (!recognition || sttActive) return;
    try {
        recognition.start();
    } catch (err) {
        console.warn('STT start error:', err);
    }
}

export function stopListening() {
    if (!recognition || !sttActive) return;
    recognition.stop();
}

export function isListening() {
    return sttActive;
}

// ─── Command Parser ──────────────────────────────────────────────────────────

/**
 * Parse a voice transcript into a structured command object.
 * Returns { type, payload } or null if unrecognized.
 */
export function parseCommand(transcript) {
    const t = transcript.toLowerCase().trim();

    // READ ALL
    if (/^(read|what('?s|\s+is)|tell me|how('?re|\s+are)|check|status|prices?|quotes?)/.test(t) ||
        t === 'report' || t === 'update') {
        return { type: 'READ_ALL' };
    }

    // PAUSE / STOP auto-announce
    if (/^(pause|stop|quiet|silence|mute|shut up)/.test(t)) {
        return { type: 'PAUSE' };
    }

    // RESUME / START auto-announce
    if (/^(resume|start|continue|go|unmute|turn on)/.test(t)) {
        return { type: 'RESUME' };
    }

    // ADD [TICKER]
    const addMatch = t.match(/^(?:add|watch|follow|track)\s+([a-z]{1,5})\b/i);
    if (addMatch) {
        return { type: 'ADD', payload: addMatch[1].toUpperCase() };
    }

    // REMOVE / DELETE [TICKER]
    const removeMatch = t.match(/^(?:remove|delete|drop|unfollow|stop watching)\s+([a-z]{1,5})\b/i);
    if (removeMatch) {
        return { type: 'REMOVE', payload: removeMatch[1].toUpperCase() };
    }

    // HOW IS [TICKER] DOING
    const singleMatch = t.match(/(?:how(?:'?s| is)?|what(?:'?s| is)?|price of|check)\s+([a-z]{1,5})(?:\s+doing|\s+today|\s+now)?/i);
    if (singleMatch) {
        return { type: 'READ_ONE', payload: singleMatch[1].toUpperCase() };
    }

    return null;
}

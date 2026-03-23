/**
 * speech.js — TTS (Text-to-Speech) + STT (Speech Recognition) module
 */

// ─── TTS ────────────────────────────────────────────────────────────────────

let ttsVoice = null;
let ttsPitch = 1;
let ttsRate = 0.93;
let ttsVolume = 1;
let speechOutputMode = 'browser';
let currentAudio = null;
let audioQueue = [];
let audioBusy = false;

export function initTTS() {
    const loadVoices = () => {
        const voices = speechSynthesis.getVoices();
        // Prefer richer, natural-sounding voices before generic fallback.
        const preferredNames = [
            'Google US English',
            'Microsoft Aria Online',
            'Microsoft Jenny Online',
            'Samantha',
            'Alex'
        ];

        ttsVoice =
            voices.find(v => preferredNames.some(name => v.name.includes(name))) ||
            voices.find(v => v.lang === 'en-US' && v.localService) ||
            voices.find(v => v.lang === 'en-US') ||
            voices.find(v => v.lang?.startsWith('en')) ||
            voices[0] || null;
    };
    loadVoices();
    speechSynthesis.onvoiceschanged = loadVoices;
}

export function setSpeechOutputMode(mode) {
    speechOutputMode = mode === 'stream' ? 'stream' : 'browser';
    if (speechOutputMode === 'stream') {
        if (window.speechSynthesis) speechSynthesis.cancel();
    } else {
        stopAudioPlayback();
    }
}

function stopAudioPlayback() {
    if (currentAudio) {
        currentAudio.pause();
        currentAudio.src = '';
        currentAudio = null;
    }
    audioQueue = [];
    audioBusy = false;
}

function playNextAudio() {
    if (audioBusy || audioQueue.length === 0) return;
    const nextText = audioQueue.shift();
    const audioUrl = `/api/tts?text=${encodeURIComponent(nextText)}&_=${Date.now()}`;

    audioBusy = true;
    currentAudio = new Audio(audioUrl);
    currentAudio.volume = ttsVolume;

    const cleanupAndContinue = () => {
        if (currentAudio) {
            currentAudio.onended = null;
            currentAudio.onerror = null;
            currentAudio = null;
        }
        audioBusy = false;
        playNextAudio();
    };

    currentAudio.onended = cleanupAndContinue;
    currentAudio.onerror = cleanupAndContinue;
    currentAudio.play().catch(() => {
        cleanupAndContinue();
    });
}

export function speak(text, { priority = false, pitch = ttsPitch, rate = ttsRate } = {}) {
    if (speechOutputMode === 'stream') {
        if (priority) stopAudioPlayback();
        audioQueue.push(text);
        playNextAudio();
        return null;
    }

    if (!window.speechSynthesis) return null;
    if (priority) {
        speechSynthesis.cancel();
    }

    const utter = new SpeechSynthesisUtterance(text);
    utter.voice = ttsVoice;
    const hasStrongEmotion = /!|soaring|massive|great day|heavy hit|staggering|fantastic/i.test(text);
    const variation = hasStrongEmotion ? 0.05 : 0.02;
    const dynamicPitch = Math.max(0.7, Math.min(1.35, pitch + (Math.random() * variation - variation / 2)));
    const dynamicRate = Math.max(0.82, Math.min(1.12, rate + (Math.random() * variation - variation / 2)));
    utter.pitch = dynamicPitch;
    utter.rate = dynamicRate;
    utter.volume = ttsVolume;
    speechSynthesis.speak(utter);

    utter.onend = () => {
        // If we were auto-restarting STT, do it now
        if (sttShouldRestart) {
            startListening();
            sttShouldRestart = false;
        }
    };

    return utter;
}


export function cancelSpeech() {
    if (window.speechSynthesis) speechSynthesis.cancel();
    stopAudioPlayback();
}

export function isSpeaking() {
    const browserSpeaking = window.speechSynthesis?.speaking || false;
    const streamSpeaking = !!currentAudio && !currentAudio.paused;
    return browserSpeaking || streamSpeaking;
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
let sttShouldRestart = false;
let silenceTimer = null;

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

        // Interruption logic: if speaking, cancel speech and treat as command
        if (isSpeaking()) {
            cancelSpeech();
            onCommandCallback?.(transcript);
            return;
        }

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

/**
 * Enhanced start: if speaking, we might want to wait or use a different mode.
 * For "Interruption", we actually want STT to be ACTIVE while TTS is running.
 * Most browsers disable STT while TTS is playing to avoid feedback.
  * We will try to keep it running.
  */
let wakeWordTriggered = false;

export function enableInterruptionMode() {
    if (!recognition) return;
    
    // We'll use a trick: restart STT periodically if it's "continuous" but stops
    recognition.continuous = true;
    recognition.interimResults = true; 

    recognition.onresult = (e) => {
        const results = e.results;
        const last = results[results.length - 1];
        const transcript = last[0].transcript.trim().toLowerCase();
        
        // Wake-word detection (e.g., "gugu", "googoo", "google")
        if (!wakeWordTriggered && /(gugu|googoo|google|goo goo)/.test(transcript)) {
            console.log('Wake-word detected:', transcript);
            wakeWordTriggered = true;
            if (isSpeaking()) cancelSpeech();
            onCommandCallback?.("__WAKE_WORD__");
        }

        if (last.isFinal) {
            console.log('Final voice input:', transcript);
            if (wakeWordTriggered) {
                // If wake-word was already triggered, this final result is the query
                const cleaned = transcript.replace(/(gugu|googoo|google|goo goo)/i, '').trim();
                if (cleaned) {
                    onCommandCallback?.(cleaned);
                }
                wakeWordTriggered = false;
            } else {
                if (isSpeaking()) cancelSpeech();
                onCommandCallback?.(transcript);
            }
        }
    };
    
    // Auto-restart STT if it ends (to keep wake-word alive)
    recognition.onend = () => {
        sttActive = false;
        // Periodic restart
        setTimeout(() => {
            if (!sttActive) startListening();
        }, 300);
        onEndCallback?.();
    };

    if (!sttActive) startListening();
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

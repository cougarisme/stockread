/**
 * api/chat.js — Vercel Serverless Function
 * LLM Chatbot integration (Gemini)
 *
 * Route: POST /api/chat
 */

const https = require('https');

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }

    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    const { message, context, apiKey: clientKey } = req.body;

    const apiKey = process.env.GEMINI_API_KEY || clientKey;

    if (!message) {
        res.status(400).json({ error: 'No message provided' });
        return;
    }

    if (!apiKey) {
        res.status(401).json({ error: 'AI API key required' });
        return;
    }

    try {
        const systemPrompt = `You are StockRead AI, a helpful assistant for a driver using a stock monitoring app. 
Keep your responses concise and easy to understand while driving. 
The user's current watchlist and prices are: ${JSON.stringify(context)}.
Directly answer the user's question about their stocks or the market.`;

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
        const requestBody = JSON.stringify({
            contents: [{
                parts: [{
                    text: `${systemPrompt}\n\nUser: ${message}`
                }]
            }],
            generationConfig: {
                maxOutputTokens: 200,
                temperature: 0.7,
            }
        });

        const result = await new Promise((resolve, reject) => {
            const proxyReq = https.request(geminiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                }
            }, (proxyRes) => {
                let data = '';
                proxyRes.on('data', c => { data += c; });
                proxyRes.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        const text = json?.candidates?.[0]?.content?.parts?.[0]?.text || "I'm sorry, I couldn't generate a response.";
                        resolve(text);
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            proxyReq.on('error', reject);
            proxyReq.write(requestBody);
            proxyReq.end();
        });

        res.status(200).json({ response: result });
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
};

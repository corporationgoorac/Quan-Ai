import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { LRUCache } from 'lru-cache';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import http from 'http';
import crypto from 'crypto';

dotenv.config();

// ==========================================
// 1. Initialize Firebase Admin
// ==========================================
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.error("FATAL ERROR: FIREBASE_SERVICE_ACCOUNT environment variable is missing.");
    process.exit(1);
}
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

// ==========================================
// 2. API Clients & Configuration
// ==========================================
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// ADVANCED LLM: LLaMA 3.3 70B Versatile (Flagship Reasoning Model)
const GROQ_MODEL = "llama-3.3-70b-versatile"; 
const VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const GEMINI_TEXT_MODEL = 'gemini-2.5-flash';
const GEMINI_IMAGE_MODEL = 'gemini-2.5-flash-image'; 

// Get public server URL, fallback to localhost
const SERVER_URL = process.env.SERVER_URL || `http://localhost:${process.env.PORT || 3000}`;

// ==========================================
// 3. In-Memory Caches
// ==========================================
const chatHistoryCache = new LRUCache({ max: 10000, ttl: 1000 * 60 * 60 * 24 });
const imageStore = new LRUCache({ max: 500, ttl: 1000 * 60 * 10 }); 
const apiUsageTracker = new Map();

console.log("[Quan AI Backend] Enterprise Worker started. Listening for incoming messages...");

// ==========================================
// 4. Advanced Helper Functions
// ==========================================

// Helper: Fetch Chat History
async function getChatHistory(uid, chatId) {
    const cacheKey = `${uid}_${chatId}`;
    if (chatHistoryCache.has(cacheKey)) return chatHistoryCache.get(cacheKey);

    try {
        const snapshot = await db.collection(`users/${uid}/chats/${chatId}/messages`)
            .orderBy('timestamp', 'desc').limit(20).get();
        
        let history = [];
        snapshot.docs.reverse().forEach(doc => {
            const data = doc.data();
            history.push({ 
                role: data.role === 'user' ? 'user' : 'model', 
                text: data.text || "", 
                imageUrl: data.imageUrl || null,
                imageUrls: data.imageUrls || [] 
            });
        });
        chatHistoryCache.set(cacheKey, history);
        return history;
    } catch (error) {
        console.error(`[Quan AI] Error fetching chat history for ${cacheKey}:`, error);
        return [];
    }
}

// Helper: Secure Image Fetching with Timeout
async function fetchImageForGemini(url) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000); 
        
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const arrayBuffer = await response.arrayBuffer();
        return {
            inlineData: {
                data: Buffer.from(arrayBuffer).toString('base64'),
                mimeType: response.headers.get('content-type') || 'image/jpeg'
            }
        };
    } catch (e) {
        console.error(`[Quan AI] Failed to fetch image: ${url}`, e.message);
        return { text: `[System Note: Image could not be loaded]` };
    }
}

// Helper: Wait function for Exponential Backoff (Retry Logic)
const delay = ms => new Promise(res => setTimeout(res, ms));

// ==========================================
// 5. Global Firestore Listener (The AI Engine)
// ==========================================
db.collectionGroup('messages').where('needs_ai_reply', '==', true).onSnapshot(async (snapshot) => {
    for (const change of snapshot.docChanges()) {
      if (change.type === 'added') {
        const messageDoc = change.doc;
        const messageData = messageDoc.data();
        const messageRef = messageDoc.ref;
        
        const uid = messageRef.path.split('/')[1];
        const chatId = messageRef.path.split('/')[3];
        const cacheKey = `${uid}_${chatId}`;

        console.log(`[Quan AI] Intercepted request in chat: ${chatId}`);

        try {
            // Lock the message immediately to prevent duplicate processing
            await messageRef.update({ needs_ai_reply: false });

            // Fetch User Context
            const userSnap = await db.collection('users').doc(uid).get();
            const memory = userSnap.exists ? (userSnap.data().memory || "") : "";
            const userName = userSnap.exists ? (userSnap.data().name || "User") : "User";

            // Build Local History
            let localHistory = await getChatHistory(uid, chatId);
            localHistory.push({ 
                role: 'user', 
                text: messageData.text || "", 
                imageUrl: messageData.imageUrl || null,
                imageUrls: messageData.imageUrls || [] 
            });
            if (localHistory.length > 20) localHistory.shift(); 

            // Routing Logic
            let messageCount = apiUsageTracker.get(cacheKey) || 0;
            let useGroq = (messageCount % 4) < 2; 

            const isImageGenerationRequest = /generate.*image|create.*image|draw|make.*picture|generate.*pic|sky image/i.test(messageData.text);

            if (isImageGenerationRequest) {
                console.log(`[Quan AI] Image request detected. Forcing Gemini.`);
                useGroq = false; 
            } else {
                apiUsageTracker.set(cacheKey, messageCount + 1); 
            }

            let aiReply = "";
            let generatedImageUrl = null;
            let groqSuccess = false;
            
            // --- ENTERPRISE SYSTEM PROMPT ---
            // Includes Temporal Awareness, Compression Directives, and strict negative constraints.
            const currentDate = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
            const currentTime = new Date().toLocaleTimeString('en-US');

            const systemPrompt = `You are Quantum AI, a flagship assistant built by Goorac Corporation. You are talking to ${userName}.
CURRENT SYSTEM TIME & DATE: ${currentDate}, ${currentTime}.

CURRENT MEMORY PROFILE:
${memory || "No permanent facts known yet."}

CRITICAL RULES FOR BEHAVIOR & MEMORY:
1. Always act as a highly intelligent, empathetic assistant. Reply naturally to the user FIRST.
2. LONG-TERM FACTS ONLY: You may only update memory if the user states a permanent fact (career, family, allergies, core preferences, overarching goals).
3. IGNORE TEMPORARY STATES: Do NOT save feelings, moods, immediate plans ("I'm tired", "Going to bed", "I am hungry"). Use the System Time to understand context.
4. COMPRESSION: When updating memory, seamlessly integrate new facts, remove outdated contradictions, and keep bullet points highly concise to save space.
5. FORMATTING: To update memory, you MUST append this exact block at the VERY END of your entire response:
[MEMORY_START]
- Fact 1
- Fact 2
[MEMORY_END]

If there are no permanent facts to update in this specific message, DO NOT output the memory tags. Just converse normally.`;

            // --- GROQ ROUTE WITH AUTO-RETRY ---
            if (useGroq) {
                console.log(`[Quan AI] Routing to Groq (LLaMA 3.3 70B)...`);
                let messagesPayload = [{ role: "system", content: systemPrompt }];
                let hasImageInHistory = false;

                localHistory.forEach(msg => {
                    let content = msg.text;
                    const hasMultipleImages = msg.imageUrls && msg.imageUrls.length > 0;
                    const hasSingleImage = !!msg.imageUrl;

                    if (msg.role === 'user' && (hasMultipleImages || hasSingleImage)) {
                        hasImageInHistory = true;
                        content = [{ type: "text", text: msg.text || "Analyze these images." }];
                        if (hasMultipleImages) {
                            msg.imageUrls.forEach(url => content.push({ type: "image_url", image_url: { url: url } }));
                        } else if (hasSingleImage) { 
                            content.push({ type: "image_url", image_url: { url: msg.imageUrl } });
                        }
                    }
                    messagesPayload.push({ role: msg.role === 'model' ? 'assistant' : 'user', content });
                });

                // Advanced Retry Logic for API stability
                let maxRetries = 2;
                for (let attempt = 1; attempt <= maxRetries; attempt++) {
                    try {
                        const controller = new AbortController();
                        const timeoutId = setTimeout(() => controller.abort(), 8000); // Generous 8s timeout for 70B model

                        const response = await fetch(`https://api.groq.com/openai/v1/chat/completions`, {
                            headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
                            method: "POST",
                            body: JSON.stringify({ 
                                model: hasImageInHistory ? VISION_MODEL : GROQ_MODEL, 
                                messages: messagesPayload, 
                                max_tokens: 800,
                                temperature: 0.6 // Slightly lower temperature for more logical memory formatting
                            }),
                            signal: controller.signal
                        });

                        clearTimeout(timeoutId);
                        
                        if (response.status === 429) {
                            console.warn(`[Quan AI] Groq Rate Limited. Retrying... (Attempt ${attempt}/${maxRetries})`);
                            if (attempt < maxRetries) await delay(1000 * attempt);
                            continue;
                        }

                        const result = await response.json();
                        
                        if (result.choices && result.choices.length > 0) {
                            aiReply = result.choices[0].message.content.trim();
                            groqSuccess = true;
                            break; // Exit retry loop on success
                        } else {
                            throw new Error("Invalid response structure from Groq.");
                        }
                    } catch (e) {
                        console.warn(`[Quan AI] Groq attempt ${attempt} failed:`, e.message);
                        if (attempt === maxRetries) groqSuccess = false;
                    }
                }
            } 
            
            // --- GEMINI ROUTE (PRIMARY VISION/IMAGE OR FAILOVER) ---
            if (!useGroq || !groqSuccess) {
                console.log(`[Quan AI] Routing to Gemini (Image Request or Groq Failover)...`);
                
                try {
                    if (isImageGenerationRequest) {
                         const imageResult = await ai.models.generateContent({
                             model: GEMINI_IMAGE_MODEL,
                             contents: messageData.text,
                             config: { responseModalities: ["IMAGE"] }
                         });
                         
                         const inlineData = imageResult.candidates?.[0]?.content?.parts?.[0]?.inlineData;
                         if (!inlineData) throw new Error("Gemini API did not return image data.");
                         
                         const imageBuffer = Buffer.from(inlineData.data, 'base64');
                         const imageId = crypto.randomBytes(16).toString('hex');
                         imageStore.set(imageId, imageBuffer);
    
                         generatedImageUrl = `${SERVER_URL}/image/${imageId}`;
                         aiReply = "Here is the image you requested. Let me know if you need adjustments. (Note: This secure link expires in 10 minutes).";
                    } else {
                        let geminiHistory = [];
                        
                        for (const msg of localHistory) {
                            let parts = [];
                            if (msg.text) parts.push({ text: msg.text });
                            else if (!msg.text && (msg.imageUrls?.length > 0 || msg.imageUrl)) parts.push({ text: "Analyze the attached images." });
    
                            if (msg.imageUrls && msg.imageUrls.length > 0) {
                                for (const url of msg.imageUrls) parts.push(await fetchImageForGemini(url));
                            } else if (msg.imageUrl) {
                                parts.push(await fetchImageForGemini(msg.imageUrl));
                            }
                            geminiHistory.push({ role: msg.role === 'model' ? 'model' : 'user', parts });
                        }
                        
                        const response = await ai.models.generateContent({
                            model: GEMINI_TEXT_MODEL,
                            contents: geminiHistory,
                            config: { systemInstruction: systemPrompt }
                        });
                        aiReply = response.text;
                    }
                } catch (geminiError) {
                    console.error(`[Quan AI] Critical Gemini failure:`, geminiError);
                    throw geminiError; 
                }
            }

            // --- ADVANCED MEMORY EXTRACTION ENGINE ---
            let updatedMemory = memory; 
            const exactRegex = /\[MEMORY_START\]([\s\S]*?)\[MEMORY_END\]/i;
            const partialRegex = /\[MEMORY_START\]([\s\S]*)/i; 

            if (exactRegex.test(aiReply)) {
                const match = aiReply.match(exactRegex);
                let rawMemory = match[1].replace(/```markdown|```/gi, '').trim(); // Sanitization
                updatedMemory = rawMemory;
                aiReply = aiReply.replace(match[0], '').trim(); 
            } else if (partialRegex.test(aiReply)) {
                const match = aiReply.match(partialRegex);
                let rawMemory = match[1].replace(/```markdown|```/gi, '').trim(); // Sanitization
                updatedMemory = rawMemory;
                aiReply = aiReply.replace(match[0], '').trim(); 
            }

            // Fail-safe: Prevent runaway token consumption
            if (updatedMemory.length > 2000) {
                console.warn(`[Quan AI] WARNING: Memory update exceeded safe limits (2000 chars). Aborting update.`);
                updatedMemory = memory; // Revert to old memory to prevent DB bloat
            }

            // Fail-safe: Ensure conversational output exists
            if (!aiReply || aiReply.length === 0) {
                aiReply = "I've successfully updated my internal memory with that information.";
            }

            // --- PERSISTENCE LAYER ---
            localHistory.push({ role: 'model', text: aiReply, imageUrl: generatedImageUrl, imageUrls: [] });
            chatHistoryCache.set(cacheKey, localHistory);

            const aiMessagePayload = { 
                text: aiReply, 
                role: "ai", 
                timestamp: FieldValue.serverTimestamp(), 
                needs_ai_reply: false 
            };
            if (generatedImageUrl) aiMessagePayload.imageUrl = generatedImageUrl; 

            // 1. Save Chat Message
            await db.collection(`users/${uid}/chats/${chatId}/messages`).add(aiMessagePayload);
            
            // 2. Save Updated Profile Memory
            if (updatedMemory !== memory && updatedMemory.length > 5) {
                console.log(`[Quan AI] Knowledge Base Synchronized. Memory footprint: ${updatedMemory.length} chars.`);
                await db.collection('users').doc(uid).set({ memory: updatedMemory }, { merge: true });
            }
            
            // 3. Update Chat Metadata
            await db.collection(`users/${uid}/chats`).doc(chatId).set({ updatedAt: FieldValue.serverTimestamp() }, { merge: true });

        } catch (error) {
            console.error(`[Quan AI] Unrecoverable error in chat ${chatId}:`, error);
            await db.collection(`users/${uid}/chats/${chatId}/messages`).add({
                text: "I experienced a temporary network disruption. Please try your request again.",
                role: "ai",
                timestamp: FieldValue.serverTimestamp(),
                needs_ai_reply: false
            });
        }
      }
    }
});

// ==========================================
// 6. HTTP Server for Local Operations
// ==========================================
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    if (req.url.startsWith('/image/')) {
        const imageId = req.url.split('/')[2];
        const imageBuffer = imageStore.get(imageId);
        
        if (imageBuffer) {
            res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': imageBuffer.length, 'Cache-Control': 'public, max-age=600' });
            res.end(imageBuffer);
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Image expired or not found.');
        }
        return;
    }
    
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Quan AI Flagship Worker is active and healthy.');
}).listen(port, '0.0.0.0', () => console.log(`[Quan AI] Server listening on port ${port}.`));

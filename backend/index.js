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
const imageStore = new LRUCache({ max: 500, ttl: 1000 * 60 * 10 }); // Stores images in RAM for 10 mins
const apiUsageTracker = new Map();

console.log("[Quan AI Backend] Advanced Worker started. Listening for incoming messages...");

// ==========================================
// 4. Helper Functions
// ==========================================
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

async function fetchImageForGemini(url) {
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const arrayBuffer = await response.arrayBuffer();
        return {
            inlineData: {
                data: Buffer.from(arrayBuffer).toString('base64'),
                mimeType: response.headers.get('content-type') || 'image/jpeg'
            }
        };
    } catch (e) {
        console.error(`[Quan AI] Failed to fetch image for Gemini: ${url}`, e.message);
        return { text: `[System Note: Attached image could not be retrieved from ${url}]` };
    }
}

// ==========================================
// 5. Global Firestore Listener
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
            // Immediately mark as processed to prevent duplicate processing
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
            if (localHistory.length > 20) localHistory.shift(); // Keep context window manageable

            // Determine Routing & Intent
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
            
            // SMART SYSTEM PROMPT for LLM-driven memory consolidation
            const systemPrompt = `You are Quantum AI, built by Goorac Corporation. You are talking to ${userName}.
CURRENT MEMORY: "${memory}"

CRITICAL INSTRUCTION FOR MEMORY MANAGEMENT:
1. If the user provides NEW information, changes a preference, or contradicts the CURRENT MEMORY, you must update the memory.
2. To update, output <UPDATE_MEMORY> followed by a freshly rewritten, comprehensive summary of ALL valid memory (combining the old facts with the new ones, and dropping outdated/contradicted facts).
3. If there is NO new information in the user's latest message, DO NOT use the <UPDATE_MEMORY> tag at all. 
4. NEVER output phrases like "No new updates" or "None" inside the tags. The content inside the tags will completely overwrite the user's database profile.`;

            // --- GROQ ROUTE ---
            if (useGroq) {
                console.log(`[Quan AI] Routing to Groq`);
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

                try {
                    const response = await fetch(`https://api.groq.com/openai/v1/chat/completions`, {
                        headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
                        method: "POST",
                        body: JSON.stringify({ model: hasImageInHistory ? VISION_MODEL : GROQ_MODEL, messages: messagesPayload, max_tokens: 800 })
                    });

                    const result = await response.json();
                    
                    if (result.choices && result.choices.length > 0) {
                        aiReply = result.choices[0].message.content.trim();
                        groqSuccess = true;
                    } else {
                        console.warn(`[Quan AI] Groq API returned an unexpected structure or error:`, result);
                        groqSuccess = false; 
                    }
                } catch (e) {
                    console.warn(`[Quan AI] Groq Request failed. Falling back to Gemini...`, e.message);
                    groqSuccess = false;
                }
            } 
            
            // --- GEMINI ROUTE (OR AUTO-FALLBACK) ---
            if (!useGroq || !groqSuccess) {
                console.log(`[Quan AI] Routing to Gemini (Primary or Auto-Fallback)`);
                
                try {
                    if (isImageGenerationRequest) {
                         console.log(`[Quan AI] Generating image using Gemini 2.5 Flash Image...`);
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
                         console.log(`[Quan AI] Image stored in RAM: ${generatedImageUrl}`);
                         aiReply = "Here is the image you requested. Note: This link will expire in 10 minutes.";
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
                            config: {
                                systemInstruction: systemPrompt
                            }
                        });
                        aiReply = response.text;
                    }
                } catch (geminiError) {
                    console.error(`[Quan AI] Gemini processing failed:`, geminiError);
                    throw geminiError; // Trigger outer catch block to notify user
                }
            }

            // --- SMART MEMORY EXTRACTION & CONSOLIDATION ---
            const memoryRegex = /<UPDATE_MEMORY>([\s\S]*?)(?:<\/UPDATE_MEMORY>|$)/i;
            const memoryMatch = aiReply.match(memoryRegex);
            let updatedMemory = memory; 

            if (memoryMatch) {
                const extractedMemory = memoryMatch[1].trim();
                aiReply = aiReply.replace(memoryRegex, '').trim(); 
                
                // Safety Net: Prevent the LLM from overwriting memory with lazy phrases
                const lazyPhrases = ["no new update", "no update", "none", "nothing new", "no changes", "no new information"];
                const isLazyResponse = lazyPhrases.some(phrase => extractedMemory.toLowerCase().includes(phrase));

                // Only update if it's not a lazy response and has actual substance
                if (!isLazyResponse && extractedMemory.length > 5) {
                    updatedMemory = extractedMemory;
                } else {
                    console.log(`[Quan AI] Ignored lazy or empty memory update from LLM: "${extractedMemory}"`);
                }
            }

            // --- SAVE STATE ---
            
            // 1. Update Local Cache
            localHistory.push({ role: 'model', text: aiReply, imageUrl: generatedImageUrl, imageUrls: [] });
            chatHistoryCache.set(cacheKey, localHistory);

            // 2. Write to Firestore Messages
            const aiMessagePayload = { 
                text: aiReply, 
                role: "ai", 
                timestamp: FieldValue.serverTimestamp(), 
                needs_ai_reply: false 
            };
            if (generatedImageUrl) aiMessagePayload.imageUrl = generatedImageUrl; 

            await db.collection(`users/${uid}/chats/${chatId}/messages`).add(aiMessagePayload);
            
            // 3. Write Memory Updates to User Doc ONLY if it actually changed
            if (updatedMemory !== memory) {
                console.log(`[Quan AI] Memory updated successfully. New context size: ${updatedMemory.length} chars.`);
                await db.collection('users').doc(uid).set({ memory: updatedMemory }, { merge: true });
            }
            
            // 4. Update Chat Timestamp for UI sorting
            await db.collection(`users/${uid}/chats`).doc(chatId).set({ updatedAt: FieldValue.serverTimestamp() }, { merge: true });

        } catch (error) {
            console.error(`[Quan AI] Critical error processing message for chat ${chatId}:`, error);
            // Send error fallback to user so the chat doesn't hang indefinitely
            await db.collection(`users/${uid}/chats/${chatId}/messages`).add({
                text: "I encountered a connection error while trying to process that request. Let's try again.",
                role: "ai",
                timestamp: FieldValue.serverTimestamp(),
                needs_ai_reply: false
            });
        }
      }
    }
});

// ==========================================
// 6. HTTP Server for Temporary Images
// ==========================================
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    if (req.url.startsWith('/image/')) {
        const imageId = req.url.split('/')[2];
        const imageBuffer = imageStore.get(imageId);
        
        if (imageBuffer) {
            res.writeHead(200, { 
                'Content-Type': 'image/jpeg', 
                'Content-Length': imageBuffer.length, 
                'Cache-Control': 'public, max-age=600' 
            });
            res.end(imageBuffer);
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Image expired or not found.');
        }
        return;
    }
    
    // Basic health check route
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Quan AI Worker is healthy and hosting temporary images.');
}).listen(port, '0.0.0.0', () => console.log(`[Quan AI] Server listening on port ${port}.`));

// tts-worker.js
import * as tts from 'https://cdn.jsdelivr.net/npm/@mintplex-labs/piper-tts-web@1.0.4/+esm';

// THIS IS THE FIX: Tell home.html that the AI engine is loaded and ready!
postMessage({ status: 'ready' });

self.onmessage = async function(e) {
    const { text, voiceModel, fallbackLang, originalText } = e.data;

    try {
        // Generate the audio using the neural model
        const audioWavBlob = await tts.predict({
            text: text,
            voiceId: voiceModel
        });

        // Convert the audio to an ArrayBuffer to send back to the main thread
        const arrayBuffer = await audioWavBlob.arrayBuffer();

        postMessage({ 
            status: 'success', 
            audio: arrayBuffer 
        }, [arrayBuffer]); 

    } catch (error) {
        console.error("Piper Worker Error:", error);
        postMessage({ 
            status: 'error', 
            fallbackLang: fallbackLang,
            originalText: originalText
        });
    }
};

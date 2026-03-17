// tts-worker.js
import * as tts from 'https://cdn.jsdelivr.net/npm/@mintplex-labs/piper-tts-web@1.0.4/+esm';

self.onmessage = async function(e) {
    const { text, voiceModel, fallbackLang, originalText } = e.data;

    try {
        // This library automatically downloads, caches, and runs the ONNX model locally
        const audioWavBlob = await tts.predict({
            text: text,
            voiceId: voiceModel
        });

        // Convert the WAV Blob to an ArrayBuffer so we can transfer it
        const arrayBuffer = await audioWavBlob.arrayBuffer();

        // Send the raw ArrayBuffer back to the main thread
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

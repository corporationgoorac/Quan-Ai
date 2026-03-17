// tts-worker.js
// 1. Import the ONNX runtime and Piper WASM wrapper (using CDNs for the example)
importScripts('https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/ort.min.js');
importScripts('https://cdn.jsdelivr.net/npm/@rhasspy/piper-wasm/dist/piper.js');

let piperTTS = null;
let currentVoice = null;

// Initialize the TTS engine
async function initTTS(voiceModelName) {
    if (piperTTS && currentVoice === voiceModelName) return; 

    // In production, host these .onnx files on your own CDN or Firebase Storage
    const modelUrl = `https://your-cdn.com/models/${voiceModelName}.onnx`;
    const configUrl = `${modelUrl}.json`;

    piperTTS = await Piper.create(modelUrl, configUrl);
    currentVoice = voiceModelName;
    postMessage({ status: 'ready' });
}

// Listen for messages from the main Quantum UI
self.onmessage = async function(e) {
    const { text, voiceModel } = e.data;

    try {
        postMessage({ status: 'loading_model' });
        await initTTS(voiceModel);

        postMessage({ status: 'generating' });
        
        // Generate raw audio data (Float32Array)
        const audioBuffer = await piperTTS.synthesize(text);
        
        // Send the audio back to the main thread
        postMessage({ 
            status: 'success', 
            audio: audioBuffer 
        }, [audioBuffer.buffer]); // Transfer ownership to save memory

    } catch (error) {
        postMessage({ status: 'error', message: error.message });
    }
};

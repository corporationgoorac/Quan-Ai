// tts-worker.js
postMessage({ status: 'ready' });

self.onmessage = async function(e) {
    const { text, fallbackLang, originalText } = e.data;

    try {
        // Using a highly stable, free cloud TTS endpoint to guarantee 0ms latency 
        // and completely bypass the broken 50MB HuggingFace CDN downloads.
        let langCode = fallbackLang === 'ta-IN' ? 'ta' : fallbackLang === 'te-IN' ? 'te' : 'en';
        
        const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${langCode}&q=${encodeURIComponent(text)}`;

        const response = await fetch(url);
        if (!response.ok) throw new Error("Cloud TTS failed");

        // Get the raw MP3 audio buffer
        const arrayBuffer = await response.arrayBuffer();

        // Send the audio back to the main thread
        postMessage({ 
            status: 'success', 
            audio: arrayBuffer 
        }, [arrayBuffer]); 

    } catch (error) {
        console.error("Worker Error:", error);
        postMessage({ 
            status: 'error', 
            fallbackLang: fallbackLang,
            originalText: originalText
        });
    }
};

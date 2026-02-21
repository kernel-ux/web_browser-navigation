const modelUrl = 'vendor/use.min.js'; // Just for reference, not used by load() directly usually
let model = null;
const pendingRankRequests = []; // Queue for rank requests received before model is ready

console.log('[Sandbox JS] Starting initialization...');

// Initialize model
// Note: use.load() usually tries to fetch from a CDN or a specific path.
// We might need to manually load the graph model if the high-level API fails.
try {
    use.load().then(loadedModel => {
        model = loadedModel;
        console.log('✅ [Sandbox] USE Lite model loaded successfully');
        // Notify parent that we are ready
        window.parent.postMessage({ type: 'MODEL_READY' }, '*');
        // Flush any queued rank requests
        if (pendingRankRequests.length > 0) {
            console.log(`[Sandbox] Flushing ${pendingRankRequests.length} queued rank requests...`);
            for (const req of pendingRankRequests) {
                window.dispatchEvent(new MessageEvent('message', { data: req }));
            }
            pendingRankRequests.length = 0;
        }
    }).catch(err => {
        console.error('❌ [Sandbox] Failed to load model (use.load):', err);
        window.parent.postMessage({ type: 'SANDBOX_ERROR', error: 'Model load failed: ' + err.message }, '*');
    });
} catch (e) {
    console.error('❌ [Sandbox] Synchronous error during init:', e);
    window.parent.postMessage({ type: 'SANDBOX_ERROR', error: 'Sync init error: ' + e.message }, '*');
}

// Cosine similarity function
function cosineSimilarity(a, b) {
    const dotProduct = tf.mul(a, b).sum().arraySync();
    const normA = tf.norm(a).arraySync();
    const normB = tf.norm(b).arraySync();
    return dotProduct / (normA * normB);
}

// Handle messages from parent
window.addEventListener('message', async (event) => {
    const { action, targets, goal, id } = event.data;

    if (action === 'ping') {
        console.log('[Sandbox] Ping received');
        window.parent.postMessage({ type: 'PONG', ready: !!model }, '*');
        return;
    }

    if (action === 'rank') {
        if (!model) {
            // Queue the request until model is ready
            pendingRankRequests.push(event.data);
            console.log(`[Sandbox] Model not ready, queued rank request (${pendingRankRequests.length} pending)`);
            return;
        }
        try {
            if (!targets || targets.length === 0) {
                window.parent.postMessage({ id, results: [] }, '*');
                return;
            }

            console.log(`⚙️ [Sandbox] Ranking ${targets.length} targets...`);
            const start = performance.now();

            // Embed goal
            const goalEmbedding = await model.embed([goal]);

            // Embed targets (batching appropriately would be better for very large lists, 
            // but for <100 elements, single batch is usually fine)
            // We strip targets to just their text/label for embedding
            const targetTexts = targets.map(t => {
                const text = t.text || '';
                const label = t.label || '';
                // Combine label and text, maybe give more weight to label by repeating?
                // For now, just space join.
                return (label + ' ' + text).trim() || ' ';
            });

            const targetEmbeddings = await model.embed(targetTexts);

            // Compute scores
            // We need to do this manually or using tf.matMul if we want to be purely tensor-based.
            // Since we need individual scores:

            const goalVec = goalEmbedding.slice([0, 0], [1, -1]); // Shape [1, 512]

            // targets is [N, 512]
            // goal is [1, 512]
            // We want [N] scores

            // Normalize both
            const goalNorm = tf.div(goalVec, tf.norm(goalVec));
            const targetsNorm = tf.div(targetEmbeddings, tf.norm(targetEmbeddings, 2, 1, true));

            // Matrix multiplication: [N, 512] * [512, 1] = [N, 1]
            const scoresTensor = tf.matMul(targetsNorm, goalNorm, false, true);
            const scores = await scoresTensor.data(); // Float32Array

            // Attach scores to targets
            const ranked = targets.map((t, i) => ({
                ...t,
                _score: scores[i]
            }));

            // Cleanup tensors
            goalEmbedding.dispose();
            targetEmbeddings.dispose();
            goalVec.dispose();
            goalNorm.dispose();
            targetsNorm.dispose();
            scoresTensor.dispose();

            // Send back results
            const end = performance.now();
            console.log(`⏱️ [Sandbox] Ranking took ${(end - start).toFixed(2)}ms`);
            window.parent.postMessage({ id, results: ranked }, '*');

        } catch (e) {
            console.error('[Sandbox] Ranking error:', e);
            window.parent.postMessage({ id, error: e.message }, '*');
        }
    }
});

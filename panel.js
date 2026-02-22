// --- Utility: Refine Search Term ---
function refineSearchTerm(goalText) {
    if (!goalText) return '';
    let text = goalText.toLowerCase();
    text = text.replace(/https?:\/\/[\S]+/gi, '');
    text = text.replace(/\b(guide me to|help me|i want to|i need to|how to|please|find|get|create|open)\b/gi, '');
    text = text.replace(/\s+/g, ' ').trim();
    const match = text.match(/(?:search|google)\s+for\s+(.+)/i);
    if (match && match[1]) text = match[1].trim();
    if (text.startsWith('search ')) text = text.slice(7).trim();
    if (text.startsWith('google ')) text = text.slice(7).trim();
    const words = text.split(' ').filter(Boolean).slice(0, 8);
    return words.join(' ').trim();
}
// --- STATE ---
let GOAL = '';
let HISTORY = [];
let CHAT_LOG = [];
let STEP_IN_FLIGHT = false;
let WAITING_CONFIRM = false;
let CURRENT_SESSION_ID = null;
let CURRENT_SESSION_CREATED = null;
let SHOW_SYSTEM_MESSAGES = false;

// --- AI PLANNER STATE ---
let ACTION_PLAN = [];
let CURRENT_STEP_INDEX = 0;

// --- UI BRIDGES (assigned inside DOMContentLoaded, used by top-level functions) ---
let _addMsg = (sender, text) => console.log(`[${sender}] ${text}`);
let _setStepCard = (text, status, action) => console.log(`[StepCard] ${text}`);
let _requestNextStep = async () => console.warn('[Bridge] requestNextStep called before init');
let _updateConfirmButtons = () => { };
let _appendHistoryInBackground = async () => {
    console.warn('[Bridge] appendHistoryInBackground called before init');
};



// --- SANDBOX FOR AI RANKING ---
let sandboxFrame = null;
let sandboxReady = false;
const pendingRankings = new Map(); // id -> resolve

function initSandbox() {
    sandboxFrame = document.createElement('iframe');
    sandboxFrame.src = 'sandbox.html';
    sandboxFrame.style.display = 'none';
    sandboxFrame.id = 'sandbox-frame';
    // Explicitly set sandbox attributes to ensure scripts can run
    sandboxFrame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
    sandboxFrame.onload = () => {
        console.log('✅ [Panel] Sandbox iframe loaded (DOM load event)');
    };
    sandboxFrame.onerror = (e) => {
        console.error('❌ [Panel] Sandbox iframe failed to load', e);
    };
    document.body.appendChild(sandboxFrame);

    // Start pinging
    const pingInterval = setInterval(() => {
        if (sandboxReady) {
            clearInterval(pingInterval);
            return;
        }
        if (sandboxFrame.contentWindow) {
            console.log('[Panel] Pinging sandbox...');
            sandboxFrame.contentWindow.postMessage({ action: 'ping' }, '*');
        }
    }, 1000);

    window.addEventListener('message', (event) => {
        // Ensure message is from our sandbox
        if (event.source !== sandboxFrame.contentWindow) return;

        const data = event.data;
        if (data.type === 'MODEL_READY') {
            console.log('✅ [Panel] Sandbox model ready');
            sandboxReady = true;
        } else if (data.type === 'PONG') {
            console.log('✅ [Panel] Sandbox PONG received, ready:', data.ready);
            if (data.ready) sandboxReady = true;
        } else if (data.id && pendingRankings.has(data.id)) {
            const resolve = pendingRankings.get(data.id);
            pendingRankings.delete(data.id);
            if (data.error) {
                console.error('[Panel] Sandbox error:', data.error);
                resolve([]); // Fallback to empty or handle error
            } else {
                const results = data.results || [];
                console.log(`✅ [Panel] Received ${results.length} ranked targets from sandbox`);
                if (results.length > 0) {
                    console.log('🔥 Top 3 Semantic Matches:', results.slice(0, 3).map(t =>
                        `[${t.index}] "${(t.label || t.text || '').slice(0, 20)}..." (Score: ${t._score?.toFixed(4)})`
                    ));
                }
                resolve(results);
            }
        }
    });
}

async function rankTargetsBySemantic(targets, goal, keywords = []) {
    // Wait for sandbox to be ready (up to 12 seconds) before falling back
    if (!sandboxReady) {
        console.log('⏳ [Panel] Sandbox not ready yet — waiting up to 12s...');
        const waited = await new Promise((resolve) => {
            const start = Date.now();
            const poll = setInterval(() => {
                if (sandboxReady) {
                    clearInterval(poll);
                    resolve(true);
                } else if (Date.now() - start > 12000) {
                    clearInterval(poll);
                    console.warn('⚠️ [Panel] Sandbox wait timed out — falling back to unranked');
                    resolve(false);
                }
            }, 200);
        });
        if (!waited) return targets; // Only fall back after waiting
    }

    // Boost goal with explicit keywords if available
    const effectiveGoal = keywords.length > 0
        ? `${goal} (Keywords: ${keywords.join(', ')})`
        : goal;

    // OPTIMIZATION: Hybrid Ranking
    // If we have many targets, filter them with BM25 (fast) first,
    // then only use Semantic (slow/accurate) on the top candidates.
    let targetsToRank = targets;
    let fallbackTargets = [];
    const TOP_K = 20;

    if (targets.length > TOP_K) {
        console.log(`⚡ [Panel] Using Hybrid Ranking: Filtering ${targets.length} -> ${TOP_K} via BM25 first`);
        // We use the raw goal for BM25 as it's keyword based anyway
        const bm25Ranked = rankTargetsByBm25(targets, goal);
        targetsToRank = bm25Ranked.slice(0, TOP_K);
        fallbackTargets = bm25Ranked.slice(TOP_K); // Keep the rest just in case, though usually ignored
    }

    console.log(`🚀 [Panel] Sending ${targetsToRank.length} targets to sandbox for semantic ranking. Goal: "${effectiveGoal}"`);
    return new Promise((resolve) => {
        const id = Math.random().toString(36).substring(7);
        pendingRankings.set(id, (rankedResults) => {
            // Combine ranked top-K with the unranked tail (if any)
            // The tail is already sorted by BM25, so appending it is a reasonable fallback
            resolve([...rankedResults, ...fallbackTargets]);
        });

        // Timeout fallback
        setTimeout(() => {
            if (pendingRankings.has(id)) {
                console.warn('⚠️ Sandbox ranking timed out');
                pendingRankings.delete(id);
                resolve(targets); // Return unranked original list
            }
        }, 15000); // 15s timeout

        sandboxFrame.contentWindow.postMessage({
            action: 'rank',
            id,
            targets: targetsToRank,
            goal: effectiveGoal // Send enriched goal
        }, '*');
    });
}

let RUNNING = false;
let CONFIG = { provider: 'gemini', apiKey: '', baseUrl: '', modelName: '', showBanners: true, enableCdp: false };
let CONTEXT_LEVEL = 1;
let LAST_FEEDBACK = '';
let SEARCH_GUIDED = false;
let FINISH_CHOICE = '';

const CONTEXT_PRESETS = [
    { limitGroups: 6, limitExamples: 6 },
    { limitGroups: 10, limitExamples: 6 },
    { limitGroups: 14, limitExamples: 6 }
];

const ALLOWED_ACTIONS = new Set(['click', 'type', 'scroll', 'finish', 'need_more', 'ask_user']);
const MAX_ACTION_ATTEMPTS = 3;


const RECENT_NAV_WINDOW = 6;
const RECENT_CLICK_WINDOW = 6;

// Call sandbox init immediately
if (typeof initSandbox === 'function') {
    initSandbox();
}

document.addEventListener('DOMContentLoaded', async () => {
    // initSandbox(); // Already called above
    const chat = document.getElementById('chat-container');
    const input = document.getElementById('goal-input');
    const btn = document.getElementById('send-btn');

    // Warn user if they paste multi-step instructions
    input.addEventListener('input', () => {
        const text = input.value;
        if (/^\d+\.\s/.test(text) || text.match(/\n\d+\./)) {
            console.log('ℹ️ Multi-step goal detected. All steps will be treated as one goal.');
        }
    });
    const scanBtn = document.getElementById('scan-btn');
    const clearBtn = document.getElementById('clear-history-btn');
    const doneBtn = document.getElementById('done-btn');
    const stepCard = document.getElementById('step-card');
    const stepText = document.getElementById('step-text');
    const stepAction = document.getElementById('step-action');
    const stepStatus = document.getElementById('step-status');
    let finishPrompt = null;
    let finishYes = null;
    let finishNo = null;
    let finishNotes = null;
    let loadingMsg = null;
    const bannerToggle = document.getElementById('banner-toggle');
    const cdpToggle = document.getElementById('cdp-toggle');
    let newtabPrompt = null;

    // --- LOADING OVERLAY LOGIC ---
    const loadingOverlay = document.getElementById('loading-overlay');
    const loadingText = document.getElementById('loading-text');
    let loadingInterval = null;

    function showLoading() {
        if (loadingOverlay) {
            loadingOverlay.classList.remove('hidden');
            loadingText.textContent = "Starting...";
        }
    }

    function updateLoadingStatus(text) {
        if (loadingOverlay && !loadingOverlay.classList.contains('hidden')) {
            loadingText.textContent = text;
        }
    }

    function hideLoading() {
        if (loadingOverlay) {
            loadingOverlay.classList.add('hidden');
            if (loadingInterval) clearInterval(loadingInterval);
            loadingInterval = null;
        }
    }
    // -----------------------------

    await loadConfig();

    // FORCE DISABLE CDP MIGRATION
    if (CONFIG.enableCdp) {
        console.log('⚠️ Forcing enableCdp to false to fix banner issue');
        CONFIG.enableCdp = false;
        await sendToBackground('gg_save_config', { config: CONFIG });
    }

    await loadHistoryFromBackground();
    await refreshSessionsList();

    const settingsBtn = document.getElementById('settings-btn');
    if (settingsBtn) {
        settingsBtn.onclick = () => {
            document.getElementById('settings-panel').classList.toggle('hidden');
        };
    }

    const saveBtn = document.getElementById('save-settings');
    if (saveBtn) {
        saveBtn.onclick = async () => {
            const newConfig = readConfigFromForm();
            await sendToBackground('gg_save_config', { config: newConfig });
            CONFIG = newConfig;
            document.getElementById('settings-panel').classList.add('hidden');
            addMsg('System', 'Settings Saved.');
        };
    }


    async function openGoogleSearch() {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab?.id) {
                await chrome.tabs.update(tab.id, { url: 'https://www.google.com' });
            } else {
                await chrome.tabs.create({ url: 'https://www.google.com' });
            }
            setNewtabBanner(false);
            addMsg('System', 'Opened Google Search. Press Start again.');
        } catch (e) {
            addMsg('System', `Could not open Google Search: ${e.message}`);
        }
    }

    function ensureNewtabPrompt() {
        if (newtabPrompt && newtabPrompt.isConnected) return;
        newtabPrompt = document.createElement('div');
        newtabPrompt.className = 'msg ai';
        newtabPrompt.innerHTML = `
            <strong>AI:</strong> Chrome's new tab page blocks extensions. Open Google Search so I can highlight and guide you.
            <div class="finish-card">
                <div class="newtab-banner-title">Start from Google Search</div>
                <div class="newtab-banner-note">Open google.com to continue.</div>
                <button type="button" class="newtab-btn">Open Google Search</button>
            </div>
        `;
        const button = newtabPrompt.querySelector('.newtab-btn');
        if (button) button.onclick = openGoogleSearch;
        chat.appendChild(newtabPrompt);
        chat.scrollTop = chat.scrollHeight;
    }

    function removeNewtabPrompt() {
        if (newtabPrompt && newtabPrompt.isConnected) {
            newtabPrompt.remove();
        }
        newtabPrompt = null;
    }

    function setNewtabBanner(show, options = {}) {
        const shouldShow = Boolean(show && (options.force || CONFIG.showBanners !== false));
        if (shouldShow) {
            ensureNewtabPrompt();
        } else {
            removeNewtabPrompt();
        }
    }

    const providerSelect = document.getElementById('provider-select');
    if (providerSelect) {
        providerSelect.onchange = (e) => {
            updateProviderFields(e.target.value);
        };
    }

    const sessionsBtn = document.getElementById('sessions-btn');
    if (sessionsBtn) {
        sessionsBtn.onclick = () => {
            const panel = document.getElementById('sessions-panel');
            if (panel) panel.classList.toggle('open');
        };
    }

    const sessionList = document.getElementById('session-list');
    if (sessionList) {
        sessionList.addEventListener('click', async (event) => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;
            const deleteBtn = target.closest('.delete-session');
            const item = target.closest('.session-item');
            const sessionId = item?.getAttribute('data-session-id') || '';
            if (!sessionId) return;

            if (deleteBtn) {
                await deleteSessionById(sessionId);
                await refreshSessionsList();
                return;
            }

            await loadSessionById(sessionId);
        });
    }

    const newChatBtn = document.getElementById('new-chat-btn');
    if (newChatBtn) {
        newChatBtn.onclick = async () => {
            GOAL = '';
            HISTORY = [];
            RUNNING = false;
            WAITING_CONFIRM = false;
            STEP_IN_FLIGHT = false;
            LAST_FEEDBACK = '';
            SEARCH_GUIDED = false;
            FINISH_CHOICE = '';
            CHAT_LOG = [];
            CURRENT_SESSION_ID = '';
            CURRENT_SESSION_CREATED = 0;
            chat.innerHTML = '';
            await clearHistoryInBackground();
            if (doneBtn) doneBtn.disabled = true;
            updateConfirmButtons();
            setStepCard('Waiting for a step...', 'idle', '');
            addMsg('System', 'New Chat Started.');
            await refreshSessionsList();
        };
    }

    if (clearBtn) {
        clearBtn.onclick = async () => {
            HISTORY = [];
            LAST_FEEDBACK = '';
            SEARCH_GUIDED = false;
            FINISH_CHOICE = '';
            await clearHistoryInBackground();
            if (doneBtn) doneBtn.disabled = true;
            updateConfirmButtons();
            setStepCard('Waiting for a step...', 'idle', '');
            addMsg('System', 'History Cleared.');
            await refreshSessionsList();
        };
    }

    if (scanBtn) {
        scanBtn.onclick = async () => {
            const resp = await sendToBackground('gg_scan_page', { options: buildScanOptions() });
            if (resp.error) {
                addMsg('Error', resp.error);
                return;
            }
            const context = resp.context;
            const totalTypes = context.elementSummary ? context.elementSummary.length : 0;
            const totalElements = (context.elementSummary || []).reduce((sum, group) => sum + group.count, 0);
            addMsg('System', `Scan complete: ${totalElements} elements across ${totalTypes} types.`);

            const firstExample = context.elementSummary?.[0]?.examples?.[0];
            if (firstExample && typeof firstExample.index === 'number') {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                await sendToContent(tab.id, {
                    action: 'visual_command',
                    type: 'click',
                    id: firstExample.index,
                    text: 'SCAN TEST'
                });
                setStepCard('Scan test highlight shown on first element.', 'pending', 'click');
            }
        };
    }

    const testBtn = document.getElementById('test-connection');
    if (testBtn) {
        testBtn.onclick = async () => {
            const status = document.getElementById('test-status');
            status.innerHTML = 'Testing...';
            status.style.color = '#aaa';
            testBtn.disabled = true;

            try {
                const tempConfig = readConfigFromForm();
                const resp = await sendToBackground('gg_test_connection', { config: tempConfig });
                if (resp.error) throw new Error(resp.error);
                status.innerHTML = 'Success';
                status.style.color = '#00E676';
            } catch (e) {
                status.innerHTML = 'Failed';
                status.style.color = '#ff4444';
                alert('Connection Error:\n' + e.message);
            }
            testBtn.disabled = false;
        };
    }

    btn.onclick = async () => {
        if (RUNNING) {
            RUNNING = false;
            WAITING_CONFIRM = false;
            btn.innerText = 'Start';
            addMsg('System', 'Stopped');
            if (doneBtn) doneBtn.disabled = true;
            updateConfirmButtons();
            setStepCard('Waiting for a step...', 'idle', '');
            await sendToBackground('gg_clear_highlight');
            return;
        }

        if (WAITING_CONFIRM) {
            // User can still start a new goal - just clears current step
            const text = input.value.trim();
            if (!text) return;
            // Keep FULL goal text including multi-step instructions
            GOAL = normalizeGoal(text);
            await clearHistoryInBackground();
            WAITING_CONFIRM = false;
            LAST_FEEDBACK = '';
            SEARCH_GUIDED = false;
            FINISH_CHOICE = '';
            CONTEXT_LEVEL = 1;
            input.value = '';
            addMsg('You', GOAL);
            RUNNING = true;
            btn.innerText = 'Stop';

            // NEW PLANNER LOGIC
            await generatePlan(GOAL);
            if (ACTION_PLAN.length > 0) {
                await requestNextStep();
            } else {
                RUNNING = false;
                btn.innerText = 'Start';
                setStepCard('Could not generate plan. Try again.', 'error', 'retry');
            }
            return;
        }

        const text = input.value.trim();
        if (text) {
            GOAL = normalizeGoal(text);
            await clearHistoryInBackground();
            WAITING_CONFIRM = false;
            LAST_FEEDBACK = '';
            SEARCH_GUIDED = false;
            FINISH_CHOICE = '';
            CONTEXT_LEVEL = 1;
            input.value = '';
            input.value = '';
            addMsg('You', GOAL);

            // NEW PLANNER LOGIC
            RUNNING = true;
            btn.innerText = 'Stop';
            await generatePlan(GOAL);
            if (ACTION_PLAN.length > 0) {
                await requestNextStep();
            } else {
                RUNNING = false;
                btn.innerText = 'Start';
                setStepCard('Could not generate plan. Try again.', 'error', 'retry');
            }
            return; // Explicit return to avoid falling through
        } else if (!GOAL) {
            return;
        }

        RUNNING = true;
        btn.innerText = 'Stop';

        // REMOVED OLD FALLTHROUGH LOGIC to prevent double execution
        // await requestNextStep();
    };

    async function generatePlan(userGoal) {
        console.log('🧠 [Planner] Generating plan for:', userGoal);
        setStepCard('AI is planning the steps...', 'loading', 'plan');
        showLoading();
        updateLoadingStatus('Planning steps...');


        const planPrompt = `
You are a smart Task Planner.
The user wants to: "${userGoal}"

Current URL: "${(await getActiveTabInfo()).url || 'empty'}"

Instructions:
1. If the user mentions a specific website (e.g. "go to amazon", "check reddit"), Step 1 MUST be "Navigate to [site].com". Do NOT search for the site on Google.
2. Break complex actions like "Sort by price" into TWO steps: "Click Sort Dropdown" then "Click Price: Low to High".
3. Keep it efficient. Minimal steps.
4. If a button or link has an Emoji (e.g. "🔍"), use the functionality or visual appearance to describe it, or use the emoji itself in "keys".

Return a STRICT JSON array (no markdown, just raw JSON).

For each step:
1. "id": number
2. "act": string (short instruction)
3. "keys": array of strings (keywords for element search)
4. "url": string (optional: expected url part after step)

Example JSON:
[
  {"id": 1, "act": "Navigate to amazon.com", "keys": ["amazon"], "url": "amazon"},
  {"id": 2, "act": "Search for drone", "keys": ["search", "input"]}
]
`;

        let text = '';
        try {
            const response = await sendToBackground('gg_ask_ai', { userMessage: planPrompt, config: CONFIG });
            text = response.reply || response.text || '';
            // cleanup markdown code blocks if any
            text = text.replace(/```json/g, '').replace(/```/g, '').trim();

            let plan = parseJsonWithRepair(text);
            if (Array.isArray(plan)) {
                // Map short keys back to full keys
                plan = plan.map(s => ({
                    step_id: s.id || s.step_id,
                    instruction: s.act || s.instruction,
                    ranking_keywords: s.keys || s.ranking_keywords || [],
                    expected_url_part: s.url || s.expected_url_part || ''
                }));

                ACTION_PLAN = plan;
                CURRENT_STEP_INDEX = 0;
                console.log('✅ [Planner] Plan generated:', ACTION_PLAN);
                addMsg('System', `📅 Plan Created (${ACTION_PLAN.length} steps):\n` +
                    ACTION_PLAN.map(s => `${s.step_id}. ${s.instruction}`).join('\n'));
                hideLoading();
                return;
            } else {
                throw new Error('AI response was not an array');
            }
        } catch (e) {
            console.error('❌ [Planner] Failed to generate plan:', e);
            if (text) console.warn('⚠️ Raw AI text:', text);

            addMsg('System', '⚠️ Plan generation failed. Please try again.');
            setStepCard('Plan generation failed', 'error', 'retry');
            hideLoading();
            RUNNING = false;
            btn.innerText = 'Start';
        }
    }

    function parseJsonWithRepair(text) {
        console.log('🔍 [Planner] Parsing text length:', text.length);
        console.log('🔍 [Planner] Text prefix:', text.slice(0, 100));
        try {
            return JSON.parse(text);
        } catch (e) {
            console.log('⚠️ [Planner] JSON parse failed, attempting repair...');

            // ROBUST REPAIR: Extract valid JSON objects using regex
            const jsonObjects = [];

            // 1. Try closing the array if it's just missing "]"
            try { return JSON.parse(text + ']'); } catch (e) { }
            try { return JSON.parse(text + '}]'); } catch (e) { }
            try { return JSON.parse(text + '"}]'); } catch (e) { }

            // 2. Fallback: REGEX EXTRACTION
            let brackets = 0;
            let start = -1;
            for (let i = 0; i < text.length; i++) {
                if (text[i] === '{') {
                    if (brackets === 0) start = i;
                    brackets++;
                } else if (text[i] === '}') {
                    brackets--;
                    if (brackets === 0 && start !== -1) {
                        const potentialJson = text.substring(start, i + 1);
                        try {
                            const obj = JSON.parse(potentialJson);
                            // Accept either short keys (id/act) or long keys (step_id/instruction)
                            if ((obj.id || obj.step_id) && (obj.act || obj.instruction)) {
                                jsonObjects.push(obj);
                                console.log('✅ [Planner] Valid step found:', obj.id || obj.step_id);
                            } else {
                                console.log('⚠️ [Planner] Invalid step keys:', Object.keys(obj));
                            }
                        } catch (err) {
                            console.log('⚠️ [Planner] Chunk parse error:', err.message);
                        }
                        start = -1;
                    }
                }
            }

            if (jsonObjects.length > 0) {
                console.log('⚠️ [Planner] Recovered', jsonObjects.length, 'steps from truncated JSON');
                return jsonObjects;
            }

            console.error('❌ [Planner] Repair failed. No valid steps found.');
            return null;
        }
    }

    async function executeNavigation(url) {
        console.log('🧭 [Planner] Direct Navigation to:', url);
        setStepCard(`Navigating to ${url}...`, 'loading', 'nav');

        let targetUrl = url;
        if (!targetUrl.startsWith('http')) {
            targetUrl = 'https://' + targetUrl;
        }

        const tabInfo = await getActiveTabInfo();
        if (!tabInfo.id) {
            console.error('❌ [Planner] No active tab found');
            setStepCard('No active tab found.', 'error', 'nav');
            STEP_IN_FLIGHT = false;
            return;
        }

        await new Promise((resolve) => chrome.tabs.update(tabInfo.id, { url: targetUrl }, resolve));

        // Wait for page load
        addMsg('System', `Navigating to ${targetUrl}...`);

        let attempts = 0;
        while (attempts < 30) { // Wait up to 30s
            await new Promise(r => setTimeout(r, 1000));
            const currentTabInfo = await getActiveTabInfo();
            console.log(`🔄 [Planner] Waiting for page load... Status: ${currentTabInfo.status}, Attempt: ${attempts + 1}/30`);
            if (currentTabInfo.status === 'complete') {
                console.log('✅ [Planner] Navigation complete');
                // Extra settle time for SPAs (React/Vue render after status=complete)
                await new Promise(r => setTimeout(r, 1500));
                break;
            }
            attempts++;
        }

        if (attempts >= 30) {
            console.warn('⚠️ [Planner] Navigation timeout after 30s, proceeding anyway');
        }

        // After nav, we consider the step done (verification happens in confirmStep or next loop)
        // But we should probably mark it as done here to follow the pattern

        await appendHistoryInBackground({
            action: 'navigate',
            url: targetUrl,
            thought: 'Direct navigation from plan',
            status: 'done'
        });

        // Verify step completion
        const currentStep = ACTION_PLAN[CURRENT_STEP_INDEX];
        if (currentStep && currentStep.expected_url_part) {
            const currentTabInfo = await getActiveTabInfo();
            const onTargetUrl = (currentTabInfo.url || '').toLowerCase().includes(currentStep.expected_url_part.toLowerCase());
            if (onTargetUrl) {
                console.log(`✅ [Planner] Step ${currentStep.step_id} verified via URL match: ${currentStep.expected_url_part}`);
            } else {
                console.warn(`⚠️ [Planner] Step verification warning: "${currentStep.expected_url_part}" not found in URL.`);
            }
        }

        // CRITICAL: Increment step index BEFORE calling confirmStep
        CURRENT_STEP_INDEX++;
        STEP_IN_FLIGHT = false;

        // Auto-advance to next step
        setStepCard('Navigation complete. Moving to next step...', 'success', 'next');
        await requestNextStep();
    }

    if (doneBtn) {
        doneBtn.onclick = async () => {
            const last = HISTORY[HISTORY.length - 1];
            const finishPending = Boolean(last && last.action === 'finish' && last.status === 'pending');
            if (finishPending) {
                if (!FINISH_CHOICE || (FINISH_CHOICE === 'not_done' && !String(getFinishNotesEl()?.value || '').trim())) {
                    ensureFinishPrompt();
                    setStepCard('Confirm goal is complete → Continue', 'waiting', 'finish');
                    WAITING_CONFIRM = true;
                    updateConfirmButtons();
                    return;
                }
                await confirmStep('user');
                return;
            }
            if (STEP_IN_FLIGHT) {
                setStepCard('Still working on the last step...', 'loading', 'next');
                return;
            }
            if (!WAITING_CONFIRM) {
                if (!RUNNING && GOAL) {
                    RUNNING = true;
                    btn.innerText = 'Stop';
                }
                if (RUNNING) {
                    setStepCard('Fetching next step...', 'loading', 'next');
                    await requestNextStep();
                    return;
                }
                setStepCard('Enter a goal to start.', 'idle', '');
                return;
            }
            await confirmStep('user');
        };
    }

    function getFinishNotesEl() {
        if (finishPrompt && finishPrompt.isConnected) {
            return finishPrompt.querySelector('.finish-notes');
        }
        return finishNotes;
    }

    function setFinishChoice(choice) {
        FINISH_CHOICE = choice;
        if (finishYes) finishYes.classList.toggle('active', choice === 'done');
        if (finishNo) finishNo.classList.toggle('active', choice === 'not_done');
        const notesEl = getFinishNotesEl();
        if (notesEl) {
            const needsNotes = choice === 'not_done';
            notesEl.classList.toggle('hidden', !needsNotes);
        }
        if (choice === 'done') {
            addMsg('AI', 'Press Continue to confirm completion.');
        }
        if (choice === 'not_done') {
            addMsg('AI', 'Tell what is missing, then press Continue.');
        }
        updateConfirmButtons();
    }

    chat.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const finish = target.getAttribute('data-finish');
        if (finish === 'done' || finish === 'not_done') {
            setFinishChoice(finish);
        }
    });

    chat.addEventListener('input', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        if (target.classList.contains('finish-notes')) {
            updateConfirmButtons();
        }
    });

    function ensureFinishPrompt() {
        if (finishPrompt && finishPrompt.isConnected) return;
        finishPrompt = document.createElement('div');
        finishPrompt.className = 'msg ai finish-msg';
        finishPrompt.innerHTML = `
            <strong>AI:</strong> I think the goal is complete. Choose one option to continue.
            <div class="finish-card">
                <div class="finish-actions">
                    <button type="button" class="finish-btn" data-finish="done">Finished</button>
                    <button type="button" class="finish-btn" data-finish="not_done">Not finished</button>
                </div>
                <textarea class="finish-notes hidden" placeholder="Tell what is missing or what went wrong..."></textarea>
            </div>
        `;
        chat.appendChild(finishPrompt);
        finishYes = finishPrompt.querySelector('[data-finish="done"]');
        finishNo = finishPrompt.querySelector('[data-finish="not_done"]');
        finishNotes = finishPrompt.querySelector('.finish-notes');
        chat.scrollTop = chat.scrollHeight;
    }

    function removeFinishPrompt() {
        if (finishPrompt && finishPrompt.isConnected) {
            finishPrompt.remove();
        }
        finishPrompt = null;
        finishYes = null;
        finishNo = null;
        finishNotes = null;
    }

    function updateConfirmButtons() {
        const last = HISTORY[HISTORY.length - 1];
        const hasPendingStep = Boolean(last && last.status === 'pending');
        const finishPending = Boolean((WAITING_CONFIRM || hasPendingStep) && last && last.action === 'finish' && last.status === 'pending');
        WAITING_CONFIRM = WAITING_CONFIRM || hasPendingStep;
        if (doneBtn) {
            doneBtn.disabled = !WAITING_CONFIRM;
            doneBtn.textContent = finishPending ? 'Continue' : 'Done';
        }
        if (finishPending) {
            ensureFinishPrompt();
        } else {
            removeFinishPrompt();
        }
        if (!finishPending) {
            FINISH_CHOICE = '';
            if (finishYes) finishYes.classList.remove('active');
            if (finishNo) finishNo.classList.remove('active');
            if (finishNotes) {
                finishNotes.value = '';
                finishNotes.classList.add('hidden');
            }
        }
    }

    let sessionSaveTimer = null;

    async function loadHistoryFromBackground() {
        const resp = await sendToBackground('gg_load_action_history');
        if (resp && Array.isArray(resp.history)) {
            HISTORY = resp.history;
        }
    }

    async function clearHistoryInBackground() {
        HISTORY = [];
        await sendToBackground('gg_clear_action_history');
        await sendToBackground('gg_clear_history');
    }

    async function setHistoryInBackground(history) {
        HISTORY = Array.isArray(history) ? history : [];
        await sendToBackground('gg_set_action_history', { history: HISTORY });
    }

    async function appendHistoryInBackground(entry) {
        HISTORY.push(entry);
        await sendToBackground('gg_append_action_history', { entry });
        scheduleSessionSave();
    }

    async function updateHistoryEntry(index, patch) {
        if (index < 0 || index >= HISTORY.length) return;
        HISTORY[index] = { ...HISTORY[index], ...patch };
        await setHistoryInBackground(HISTORY);
        scheduleSessionSave();
    }

    function scheduleSessionSave() {
        if (!GOAL && HISTORY.length === 0 && CHAT_LOG.length === 0) return;
        if (sessionSaveTimer) window.clearTimeout(sessionSaveTimer);
        sessionSaveTimer = window.setTimeout(() => {
            saveSessionSnapshot();
        }, 400);
    }

    async function saveSessionSnapshot() {
        if (!GOAL && HISTORY.length === 0 && CHAT_LOG.length === 0) return;
        if (!CURRENT_SESSION_ID) {
            CURRENT_SESSION_ID = `gg_${Date.now()}`;
        }
        if (!CURRENT_SESSION_CREATED) {
            CURRENT_SESSION_CREATED = Date.now();
        }
        const session = {
            id: CURRENT_SESSION_ID,
            goal: GOAL,
            messages: CHAT_LOG,
            history: HISTORY,
            createdAt: CURRENT_SESSION_CREATED
        };
        await sendToBackground('gg_save_session', { session });
        await refreshSessionsList();
    }

    async function refreshSessionsList() {
        const resp = await sendToBackground('gg_list_sessions');
        const sessions = Array.isArray(resp.sessions) ? resp.sessions : [];
        const list = document.getElementById('session-list');
        if (!list) return;

        list.innerHTML = '';
        if (sessions.length === 0) {
            list.innerHTML = '<div class="session-item">No saved sessions</div>';
            return;
        }

        for (const session of sessions) {
            const item = document.createElement('div');
            item.className = 'session-item';
            if (session.id === CURRENT_SESSION_ID) item.classList.add('active');
            item.setAttribute('data-session-id', session.id);
            const title = session.goal || 'Untitled session';
            const date = new Date(session.updatedAt || session.createdAt || Date.now());
            item.innerHTML = `
                <div>
                    <div>${escapeHtml(title.slice(0, 36))}</div>
                    <span class="session-date">${date.toLocaleString()}</span>
                </div>
                <div class="delete-session" title="Delete">✕</div>
            `;
            list.appendChild(item);
        }
    }

    async function loadSessionById(sessionId) {
        const resp = await sendToBackground('gg_load_session', { sessionId });
        if (!resp || !resp.session) return;
        const session = resp.session;
        CURRENT_SESSION_ID = session.id;
        CURRENT_SESSION_CREATED = session.createdAt || Date.now();
        GOAL = session.goal || '';
        HISTORY = Array.isArray(session.history) ? session.history : [];
        CHAT_LOG = Array.isArray(session.messages) ? session.messages : [];

        if (chat) {
            chat.innerHTML = '';
            CHAT_LOG.forEach(entry => {
                const div = document.createElement('div');
                div.className = `msg ${(entry.sender || 'System').toLowerCase()}`;
                div.innerHTML = `<strong>${escapeHtml(entry.sender || 'System')}:</strong> ${escapeHtml(entry.text || '')}`;
                chat.appendChild(div);
            });
            chat.scrollTop = chat.scrollHeight;
        }

        if (input) input.value = '';

        RUNNING = false;
        WAITING_CONFIRM = false;
        STEP_IN_FLIGHT = false;
        LAST_FEEDBACK = '';
        SEARCH_GUIDED = false;
        FINISH_CHOICE = '';

        await setHistoryInBackground(HISTORY);
        updateConfirmButtons();
        setStepCard('Session loaded. Press Start to continue.', 'idle', '');
        await refreshSessionsList();
    }

    async function deleteSessionById(sessionId) {
        await sendToBackground('gg_delete_session', { sessionId });
        if (sessionId === CURRENT_SESSION_ID) {
            CURRENT_SESSION_ID = '';
            CURRENT_SESSION_CREATED = 0;
        }
    }

    async function requestNextStep() {
        if (STEP_IN_FLIGHT) {
            console.warn('Step already in flight, skipping');
            return;
        }

        // CHECK PLAN STATUS
        if (CURRENT_STEP_INDEX >= ACTION_PLAN.length) {
            console.log('✅ [Planner] All steps completed.');
            setStepCard('All planned steps completed!', 'success', 'finish');
            RUNNING = false;
            btn.innerText = 'Start';
            return;
        }

        const currentStep = ACTION_PLAN[CURRENT_STEP_INDEX];
        const stepGoal = currentStep.instruction;
        const stepKeywords = currentStep.ranking_keywords || [];
        const stepUrlPart = currentStep.expected_url_part || '';

        console.log(`📍 [Planner] Executing Step ${currentStep.step_id}/${ACTION_PLAN.length}: "${stepGoal}"`);
        setStepCard(`Step ${currentStep.step_id}/${ACTION_PLAN.length}: ${stepGoal}`, 'loading', 'step');

        // DIRECT NAVIGATION DISPATCHER: If step is "Navigate to X", execute directly
        if (stepGoal.toLowerCase().startsWith('navigate to ')) {
            const urlMatch = stepGoal.match(/navigate to\s+(.*)/i);
            if (urlMatch && urlMatch[1]) {
                console.log('🧭 [Planner] Direct Navigation Step Detected');
                STEP_IN_FLIGHT = true;
                await executeNavigation(urlMatch[1].trim());
                return;
            }
        }

        console.log('📍 [1/20] requestNextStep called');
        STEP_IN_FLIGHT = true;
        try {
            console.log('📍 [2/20] Checking GOAL and RUNNING:', { GOAL: stepGoal.slice(0, 50), RUNNING });
            debugMsg(`requestNextStep start | goal: ${stepGoal || '(empty)'} | running: ${RUNNING}`);

            // SHOW LOADING ANIMATION (Defer until after checks)
            // showLoading();
            // setStepCard('Scanning page...', 'loading', 'scan');

            console.log('📍 [3/20] Starting step request for goal:', stepGoal);

            // RETRY logic for empty URL (page might be loading)
            let tabInfo = await getActiveTabInfo();
            let retries = 0;
            while ((!tabInfo.url || tabInfo.url.trim() === '') && retries < 3) {
                console.log(`⚠️ Empty URL, retrying (${retries + 1}/3)...`);
                await new Promise(resolve => setTimeout(resolve, 300));
                tabInfo = await getActiveTabInfo();
                retries++;
            }

            console.log('📍 [4/20] Got tab info:', { url: tabInfo.url });

            // GUARD: Check for empty/restricted URL FIRST, before doing anything
            if (!tabInfo.url || isRestrictedUrl(tabInfo.url)) {
                if (!tabInfo.url || isNewTabUrl(tabInfo.url)) {
                    setNewtabBanner(true, { force: true });
                    setStepCard('Opening Google Search to continue...', 'loading', 'navigate');
                    await openGoogleSearch();
                } else {
                    setStepCard('Open a normal web page to continue.', 'waiting', 'navigate');
                }
                console.log('⚠️ Restricted/empty URL, skipping scan:', tabInfo.url);
                return;
            }

            // SHOW LOADING ANIMATION NOW
            showLoading();
            updateLoadingStatus('Scanning page content...');
            setStepCard('Scanning page...', 'loading', 'scan');

            // Ensure content script is loaded on the current tab
            if (tabInfo.id) {
                try {
                    await sendToBackground('gg_ensure_content_script', { tabId: tabInfo.id });
                    console.log('📍 [4a/20] Content script ensured on tab');
                } catch (e) {
                    console.warn('⚠️ Could not ensure content script:', e.message);
                }
            }

            setNewtabBanner(false);

            // General search guidance (not just Google) when goal explicitly includes search
            if (shouldGuideSearchAnywhere(stepGoal)) {
                const currentHost = safeHostname(tabInfo.url || '');
                const primaryDomain = detectPrimaryDomain(stepGoal || GOAL);
                const allowSearchGuide = !primaryDomain || currentHost.includes(primaryDomain.split('.')[0]);
                const last = HISTORY[HISTORY.length - 1];
                const alreadyPendingSearch = Boolean(last && last.action === 'search' && last.status === 'pending');
                if (allowSearchGuide && !alreadyPendingSearch) {
                    const searchTerm = refineSearchTerm(stepGoal);
                    try {
                        const searchResp = await sendToContent(tabInfo.id, { action: 'find_search_input', searchTerm });
                        if (searchResp && searchResp.found) {
                            if (searchTerm) {
                                setStepCard(`Search for: "${searchTerm}" → Press Enter, then click Done`, 'waiting', 'search');
                            } else {
                                setStepCard('Type your query → Press Enter, then click Done', 'waiting', 'search');
                            }
                            await appendHistoryInBackground({ action: 'search', thought: searchTerm || 'search query', searchTerm, url: tabInfo.url, status: 'pending' });
                            SEARCH_GUIDED = true;
                            WAITING_CONFIRM = true;
                            if (doneBtn) doneBtn.disabled = false;
                            updateConfirmButtons();
                            STEP_IN_FLIGHT = false;
                            return;
                        }
                    } catch (e) {
                        console.warn('Search highlight failed:', e.message);
                    }
                }
            }

            if (/google\./i.test(tabInfo.url || '')) {
                const onResults = isGoogleResultsUrl(tabInfo.url || '');
                const last = HISTORY[HISTORY.length - 1];

                if (last && last.action === 'search' && last.status === 'pending' && !onResults) {
                    SEARCH_GUIDED = true;
                }

                // If we're stuck on Google after search was guided, move forward
                if (onResults && SEARCH_GUIDED) {
                    console.log('✅ On Google results after search - continuing normally');
                    SEARCH_GUIDED = false;
                }

                if (!onResults && SEARCH_GUIDED) {
                    const term = last.searchTerm || last.thought || '';
                    if (term) {
                        setStepCard(`Press Enter to run: "${term}", then click Done`, 'waiting', 'search');
                    } else {
                        setStepCard('Press Enter to run your search, then click Done', 'waiting', 'search');
                    }
                    WAITING_CONFIRM = true;
                    if (doneBtn) doneBtn.disabled = false;
                    updateConfirmButtons();
                    STEP_IN_FLIGHT = false;
                    return;
                }

                if (shouldUseSearchShortcut(stepGoal) && !onResults) {
                    const searchTerm = refineSearchTerm(stepGoal);
                    debugMsg(`google short-circuit | term: ${searchTerm || '(none)'}`);
                    try {
                        const searchResp = await sendToContent(tabInfo.id, { action: 'find_search_input', searchTerm });
                        debugMsg(`google highlight response: ${JSON.stringify(searchResp || {})}`);
                        if (searchResp && searchResp.found) {
                            if (searchTerm) {
                                setStepCard(`Search for: "${searchTerm}" → Press Enter, then click Done`, 'waiting', 'search');
                            } else {
                                setStepCard('Type your query → Press Enter, then click Done', 'waiting', 'search');
                            }
                            await appendHistoryInBackground({ action: 'search', thought: searchTerm || 'search query', searchTerm, url: tabInfo.url, status: 'pending' });
                            SEARCH_GUIDED = true;
                            WAITING_CONFIRM = true;
                            if (doneBtn) doneBtn.disabled = false;
                            updateConfirmButtons();
                            STEP_IN_FLIGHT = false;
                            return;
                        }
                    } catch (e) {
                        console.warn('Google search highlight failed:', e.message);
                    }
                }
            }

            console.log('📍 [5/20] Scanning page...');
            let scanResp;
            try {
                scanResp = await withTimeout(
                    sendToBackground('gg_scan_page', { options: buildScanOptions() }),
                    12000,
                    'Page scan timeout - page may be too complex or slow. Try reload or simpler page.'
                );
            } catch (err) {
                console.error('📍 [5b/20] Scan failed:', err);
                // Try again with simpler scan options if first attempt failed
                try {
                    console.log('📍 [5c/20] Retrying scan with minimal options...');
                    scanResp = await withTimeout(
                        sendToBackground('gg_scan_page', { options: { limitGroups: 5, limitExamples: 3 } }),
                        8000,
                        'Simplified scan timed out'
                    );
                } catch (retryErr) {
                    throw new Error(`Scan failed: ${retryErr.message}`);
                }
            }
            debugMsg(`scan response: ${scanResp?.context ? 'ok' : 'empty'} | error: ${scanResp?.error || 'none'}`);
            if (scanResp.error) throw new Error(scanResp.error);

            console.log('📍 [6/20] Processing scan results');
            const context = scanResp.context || {};
            const elementSummary = context.elementSummary || [];
            const availableTargets = context.availableTargets || [];
            const pageUrl = context.url || '';
            const pageHost = safeHostname(pageUrl);

            console.log('📍 [7/20] Found', availableTargets.length, 'available targets');
            updateLoadingStatus(`Found ${availableTargets.length} elements. Analyzing...`);

            let allowEmptyTargets = false;
            if (!availableTargets.length) {
                const hostLabel = pageHost || safeHostname(tabInfo.url) || 'this page';
                if (/google\./i.test(hostLabel)) {
                    const onResults = isGoogleResultsUrl(pageUrl || tabInfo.url || '');
                    if (onResults) {
                        setStepCard('Click the best search result → Done', 'waiting', 'click');
                        await appendHistoryInBackground({ action: 'manual_click', thought: 'click a search result', url: pageUrl || tabInfo.url || '', status: 'pending' });
                        WAITING_CONFIRM = true;
                        if (doneBtn) doneBtn.disabled = false;
                        updateConfirmButtons();
                        STEP_IN_FLIGHT = false;
                        return;
                    }

                    if (shouldUseSearchShortcut(stepGoal)) {
                        const searchTerm = refineSearchTerm(stepGoal);
                        try {
                            const searchResp = await sendToContent(tabInfo.id, { action: 'find_search_input', searchTerm });
                            if (searchResp && searchResp.found) {
                                if (searchTerm) {
                                    setStepCard(`Search for: "${searchTerm}" → Press Enter, then click Done`, 'waiting', 'search');
                                } else {
                                    setStepCard('Type your query → Press Enter, then click Done', 'waiting', 'search');
                                }
                                WAITING_CONFIRM = true;
                                if (doneBtn) doneBtn.disabled = false;
                                updateConfirmButtons();
                                STEP_IN_FLIGHT = false;
                                return;
                            }
                        } catch (e) {
                            console.warn('Google search highlight failed:', e.message);
                        }
                    } else {
                        allowEmptyTargets = true;
                    }

                }

                if (!allowEmptyTargets) {
                    setStepCard(`No clickable elements on ${hostLabel}. Refresh and try again.`, 'waiting', 'scan');
                    STEP_IN_FLIGHT = false;
                    return;
                }
            }

            console.log('📍 Available targets:', availableTargets.slice(0, 5).map(t => `[${t.index}]="${t.label}"`));

            console.log('📍 [8/20] Building history string for prompt');
            // SMART HISTORY - show URLs visited + recent actions to prevent repetition
            let historyStr = '';

            if (HISTORY.length > 0) {
                // Part 1: ALL URLs visited (prevents repeating navigation)
                const visitedUrls = HISTORY
                    .filter(h => h.action === 'navigate' && h.url && h.status === 'done')
                    .map(h => h.url)
                    .filter((url, i, arr) => arr.indexOf(url) === i); // unique

                if (visitedUrls.length > 0) {
                    historyStr += `VISITED URLS (never repeat these):\n${visitedUrls.map(u => `✓ ${u}`).join('\n')}\n\n`;
                }

                // Part 2: Last 2 successful actions only (keeps prompt short)
                const recentCount = Math.min(2, HISTORY.length);
                const recentSteps = HISTORY.filter(h => h.status === 'done').slice(-recentCount);

                if (recentSteps.length > 0) {
                    historyStr += `LAST ACTIONS:\n`;
                    historyStr += recentSteps.map(h => {
                        const action = h.action || 'unknown';
                        const detail = h.thought || h.target_text || h.url || h.detail || 'done';
                        return `✓ ${action}: ${detail}`;
                    }).join('\n');
                }
            } else {
                historyStr = 'No history - this is step 1';
            }

            console.log('📍 [9/20] Filtering and formatting targets for prompt (Semantic)');
            const rankedTargets = await rankTargetsBySemantic(availableTargets, stepGoal, stepKeywords);
            const filteredTargets = filterTargetsByGoal(rankedTargets, GOAL, pageUrl);
            const topTargets = filteredTargets.slice(0, 12);  // Reduced from 25 to 12 to save API tokens
            console.log('📍 Target counts:', {
                available: availableTargets.length,
                ranked: rankedTargets.length,
                filtered: filteredTargets.length,
                top: topTargets.length
            });
            console.log('📍 Top target indices:', topTargets.map(t => t.index));
            console.log('📍 Top target labels:', topTargets.map(t => `${t.index}:${(t.label || '').slice(0, 40)}`));

            // Populate top-3 targets in UI
            const topTargetsContainer = document.getElementById('top-targets');
            const topTargetsList = topTargetsContainer?.querySelector('.top-targets-list');
            if (topTargets.length > 0 && topTargets.length <= 25 && topTargetsList) {
                const top3 = topTargets.slice(0, 3);
                topTargetsList.innerHTML = top3
                    .map(t => {
                        const typeChar = (t.type || 'element')[0].toUpperCase();
                        const label = escapeHtml((t.label || 'unnamed').slice(0, 35));
                        return `<li><strong>[${t.index}]</strong> <em>${typeChar}</em>: ${label}</li>`;
                    })
                    .join('');
                topTargetsContainer?.classList.remove('hidden');
            } else if (topTargetsContainer) {
                topTargetsContainer?.classList.add('hidden');
            };
            const onResultsPage = isGoogleResultsUrl(pageUrl || tabInfo.url || '');
            const bestLinkTarget = onResultsPage ? getBestLinkTarget(topTargets) : null;
            const targetLines = topTargets
                .map(t => {
                    const type = (t.type || 'element')[0];
                    const label = (t.label || '').slice(0, 45);
                    return `${t.index}:[${type}]${label}`;
                })
                .join('\n');
            const targetCountLine = `Targets Provided: ${topTargets.length} of ${availableTargets.length}`;

            const preferredSearchTerm = refineSearchTerm(GOAL);
            const taskType = detectGoalType(GOAL);
            const pageLooksRelevant = isLikelyGoalComplete(GOAL, pageUrl, context.title, HISTORY.length);
            const onGoogleHome = isGoogleHomeUrl(pageUrl || tabInfo.url || '');
            const apiGoal = isApiGoal(GOAL);

            // Context-aware hint based on step type
            const stepLower = stepGoal.toLowerCase();
            const isTabStep = /\btab\b|\bsection\b|\bsidebar\b|\bpreferences\b|\bsettings\b/.test(stepLower);
            const tabHint = isTabStep
                ? '\n// HINT: This step involves navigating to a settings section or tab. Prefer sidebar links, tab buttons, or navigation items over content elements like "Create" buttons or feeds.'
                : '';

            // API-specific guidance - keep SHORT to avoid verbose AI responses
            const apiHint = apiGoal ? '\nHINT: For API goals, search "[service] api key", click official docs/console links.' : '';
            const contentSummaryBlock = formatContentSummary(context.contentSummary);

            // BUILD FLEXIBLE PROMPT - Works for any web task
            const prompt = `Goal: ${stepGoal}${apiHint}${tabHint}

Current URL: ${pageUrl || 'unknown'}
Page Title: ${context.title || 'unknown'}
Page Relevance: ${pageLooksRelevant ? 'LIKELY ON TARGET PAGE - avoid re-searching' : 'Unknown'}

// Important:
// - If already on a likely target page or search results, do NOT suggest a new search
// - Prefer clicking relevant links, buttons, or headings on the current page
// - If the current domain already matches the target site, do NOT suggest navigate
// - CRITICAL: If the Goal says "go to [site]" (e.g. amazon, youtube) and you are NOT on that site, you MUST choose 'navigate' [url] first. Do not search on the current page.
// - On search results pages, choose a click on a relevant result (do not navigate or search again)

            ${historyStr}${contentSummaryBlock}

            Available Elements (ranked, index:type-label):
            ${targetLines || 'None found'}
            ${targetCountLine}

What's next? Choose one:
- click [index] - click an element
- type [index] "text" - type into a field
- navigate [url] - go to different site  
- finish - goal complete

Return JSON only: {"action":"click"|"type"|"navigate"|"finish","index":N,"text":"...","url":"...","thought":"why"}`;

            console.log('📍 [10/20] Built prompt. Sending to AI...');
            console.log('📍 Prompt length:', prompt.length, 'chars');
            addMsg('System', 'Asking AI... (timeout 30s)');
            updateLoadingStatus('Consulting AI...');
            console.log('📍 [11/20] About to call sendToBackground');

            let response;
            try {
                console.log('📍 [12/20] Waiting for AI response...');
                response = await sendToBackground('gg_ask_ai', { userMessage: prompt, config: CONFIG });
                console.log('📍 [13/20] Got response from AI');
            } catch (timeoutErr) {
                console.error('📍 [13b/20] AI request error:', timeoutErr.message);
                throw new Error(timeoutErr.message);
            }

            console.log('📍 [14/20] Checking response object');
            if (response.error) {
                const err = new Error(response.error);
                err.code = response.errorCode || '';
                throw err;
            }

            let json = response.reply || '';
            console.log('📍 [15/20] Got JSON string, length:', json.length);
            if (!json || json.trim() === '') {
                console.error('📍 [15b/20] AI returned empty reply');
                throw new Error('AI returned empty response');
            }

            console.log('📍 [16/20] AI raw (first 200 chars):', json.slice(0, 200));

            // Extract JSON
            json = json.trim();
            console.log('📍 [17/20] JSON extraction: starts with {?', json.startsWith('{'), 'length:', json.length);

            if (!json.startsWith('{')) {
                const idx = json.indexOf('{');
                if (idx > -1) {
                    console.log('📍 [17b/20] Found { at index:', idx);
                    json = json.slice(idx);
                } else {
                    console.error('❌ No JSON found in response.');
                    console.error('Raw AI response (first 500 chars):', json.slice(0, 500));
                    const fallbackCmd = buildFallbackCmd(topTargets, GOAL, pageUrl, 'AI returned non-JSON; using best match');
                    if (fallbackCmd) {
                        addMsg('System', 'AI returned non-JSON. Using best match instead.');
                        json = JSON.stringify(fallbackCmd);
                    } else {
                        throw new Error('AI returned text instead of JSON. This provider may not be compatible. Try Groq (fast & free) or OpenAI instead.');
                    }
                }
            }

            const endIdx = json.lastIndexOf('}');
            if (endIdx > -1) {
                json = json.slice(0, endIdx + 1);
            }

            console.log('📍 [18/20] Cleaned JSON length:', json.length, 'sample:', json.slice(0, 100));

            let cmd = {};
            try {
                cmd = JSON.parse(json);
                console.log('📍 [19/20] Parsed JSON successfully, action:', cmd.action);
            } catch (e) {
                console.error('❌ JSON parse failed:', e.message);
                console.error('Raw response (first 500 chars):', response.reply?.slice(0, 500));
                console.error('Cleaned JSON attempt:', json.slice(0, 500));
                const fallbackCmd = buildFallbackCmd(topTargets, GOAL, pageUrl, 'AI returned invalid JSON; using best match');
                if (fallbackCmd) {
                    addMsg('System', 'AI returned invalid JSON. Using best match instead.');
                    cmd = fallbackCmd;
                } else {
                    throw new Error(`AI returned invalid JSON. The response was not in the correct format. Try a simpler provider like Groq or check your API key. Error: ${e.message}`);
                }
            }

            console.log('📍 [20/20] Parsed action:', cmd.action, 'index:', cmd.index, 'url:', cmd.url);

            // Check if goal is already achieved
            if (cmd.action === 'finish' || cmd.action === 'success') {
                // SAFETY: Don't allow finish without meaningful progress
                const actualActions = HISTORY.filter(h =>
                    ['click', 'navigate', 'search'].includes(h.action)
                );

                if (actualActions.length === 0) {
                    console.warn('⚠️ AI said finish but no progress made yet');
                    addMsg('System', 'Goal is not yet complete. Need to take action first. Requesting next step...');
                    STEP_IN_FLIGHT = false;
                    // Request another step instead of asking to confirm
                    await requestNextStep();
                    return;
                }

                // SAFETY: Don't allow finish if there are remaining plan steps
                const remainingSteps = ACTION_PLAN.slice(CURRENT_STEP_INDEX + 1);
                if (remainingSteps.length > 0) {
                    console.warn(`⚠️ AI said finish but ${remainingSteps.length} plan steps remain. Treating as step failure.`);
                    addMsg('System', `⚠️ AI couldn't find the element. Trying to correct... (${remainingSteps.length} steps remain)`);
                    STEP_IN_FLIGHT = false;
                    const currentStep = ACTION_PLAN[CURRENT_STEP_INDEX];
                    const tabInfo = await getActiveTabInfo();
                    await injectCorrectionSteps(currentStep, tabInfo?.url || '');
                    return;
                }

                console.warn('⚠️ Finish returned. Asking user to confirm.');
                addMsg('System', 'AI says the goal is complete. Choose Finished or Not finished, then Continue.');
                FINISH_CHOICE = '';
                if (finishYes) finishYes.classList.remove('active');
                if (finishNo) finishNo.classList.remove('active');
                if (finishNotes) {
                    finishNotes.value = '';
                    finishNotes.classList.add('hidden');
                }
                // Always remove and re-add finish prompt to ensure visibility
                removeFinishPrompt();
                ensureFinishPrompt();
                await appendHistoryInBackground({ action: 'finish', thought: cmd.thought || 'Confirm completion', status: 'pending' });
                WAITING_CONFIRM = true;
                if (doneBtn) doneBtn.disabled = false;
                updateConfirmButtons();
                setStepCard('Confirm goal is complete → Continue', 'waiting', 'finish');
                STEP_IN_FLIGHT = false;
                return;
            }

            if (apiGoal && onResultsPage && bestLinkTarget) {
                const target = typeof cmd.index === 'number'
                    ? availableTargets.find(t => t.index === cmd.index)
                    : null;
                const isLinkClick = cmd.action === 'click' && target && target.type === 'link';

                if (!isLinkClick) {
                    const feedback = '[API-GUARD] On search results. Clicking the top relevant result.';
                    addMsg('AI', feedback);
                    cmd = {
                        action: 'click',
                        index: bestLinkTarget.index,
                        target_text: bestLinkTarget.label,
                        thought: feedback
                    };
                }
            }

            // CHECK FOR REPETITION - Prevent loops and stuck behavior
            const recentDone = HISTORY.filter(h => h.status === 'done');
            const recentNav = recentDone
                .filter(h => h.action === 'navigate' && h.url)
                .slice(-RECENT_NAV_WINDOW)
                .map(h => normalizeUrl(h.url));

            if (isGoogleResultsUrl(pageUrl || tabInfo.url || '') && (cmd.action === 'navigate' || cmd.action === 'search')) {
                const prefix = apiGoal ? '[API-GUARD] ' : '';
                const feedback = `${prefix}You are on search results. Do not navigate or search again. Click the most relevant result.`;
                addMsg('System', feedback);
                if (prefix) addMsg('AI', feedback);
                await appendHistoryInBackground({ action: 'feedback', thought: feedback, status: 'done' });
                setStepCard('Click a relevant search result → Continue', 'waiting', 'click');
                WAITING_CONFIRM = true;
                if (doneBtn) doneBtn.disabled = false;
                updateConfirmButtons();
                STEP_IN_FLIGHT = false;
                return;
            }

            if (apiGoal && pageLooksRelevant && (cmd.action === 'navigate' || cmd.action === 'search')) {
                const feedback = '[API-GUARD] Already on a relevant API page. Do not search or navigate again. Choose a link or button on this page.';
                addMsg('System', feedback);
                addMsg('AI', feedback);
                await appendHistoryInBackground({ action: 'feedback', thought: feedback, status: 'done' });
                setStepCard('Click a link or button on this page → Continue', 'waiting', 'click');
                WAITING_CONFIRM = true;
                if (doneBtn) doneBtn.disabled = false;
                updateConfirmButtons();
                STEP_IN_FLIGHT = false;
                return;
            }

            if (cmd.action === 'navigate' && cmd.url) {
                const targetUrl = normalizeUrl(cmd.url);
                if (targetUrl && recentNav.includes(targetUrl)) {
                    const feedback = `Already visited ${cmd.url} recently. Try a different page or path.`;
                    addMsg('System', feedback);
                    await appendHistoryInBackground({ action: 'feedback', thought: feedback, status: 'done' });
                    RUNNING = false;
                    btn.innerText = 'Start';
                    STEP_IN_FLIGHT = false;
                    setStepCard('Loop detected - navigation repeated. Stopped.', 'waiting', 'error');
                    return;
                }
            }

            if (cmd.action === 'click' && typeof cmd.index === 'number') {
                const recentClicks = recentDone
                    .filter(h => h.action === 'click' && h.index === cmd.index && h.pageChanged === false)
                    .slice(-RECENT_CLICK_WINDOW);

                if (recentClicks.length >= MAX_ACTION_ATTEMPTS) {
                    const feedback = `Clicked the same element ${recentClicks.length} times without page change. Try a different action.`;
                    addMsg('System', feedback);
                    await appendHistoryInBackground({ action: 'feedback', thought: feedback, status: 'done' });
                    LAST_FEEDBACK = feedback;
                    STEP_IN_FLIGHT = false;
                    await requestNextStep();
                    return;
                }
            }

            // Handle type action
            if (cmd.action === 'type') {
                const typeText = (cmd.text || cmd.value || '').trim();
                if (!typeText) {
                    throw new Error('Type action missing text');
                }

                if (typeof cmd.index === 'number') {
                    const target = availableTargets.find(t => t.index === cmd.index);
                    if (!target) {
                        console.warn('❌ Index not found for type:', cmd.index);
                    } else {
                        // Detect if this is a search box (should auto-submit with Enter)
                        const isSearchField = /search|query|q[\s\n]*$/i.test(target.name || target.label || target.placeholder || '');

                        const execCmd = {
                            action: 'type',
                            thought: cmd.thought || `Type "${typeText}" into ${target.label}`,
                            index: cmd.index,
                            target_text: target.label,
                            target_type: target.type,
                            url: pageUrl,
                            value: typeText,
                            xpath: target.xpath || '',
                            frameXPath: target.frameXPath || '',
                            submitAfter: isSearchField  // Auto-submit search boxes
                        };

                        addMsg('AI', execCmd.thought);

                        const executed = await tryHighlightWithFallbacks(execCmd, context, tabInfo);
                        if (!executed) {
                            throw new Error('Could not highlight input field');
                        }

                        await appendHistoryInBackground({ ...executed, status: 'pending' });
                        WAITING_CONFIRM = true;
                        if (doneBtn) doneBtn.disabled = false;
                        updateConfirmButtons();
                        CONTEXT_LEVEL = 1;

                        // For search fields, auto-submit after a brief delay
                        setStepCard(`Type "${typeText}" into the highlighted ${target.type} → Done`, 'pending', 'type');
                        return;
                    }
                }

                const execCmd = {
                    action: 'type',
                    thought: cmd.thought || `Type "${typeText}" into the best match`,
                    index: null,
                    target_text: cmd.target_text || GOAL,
                    url: pageUrl,
                    value: typeText
                };

                addMsg('AI', execCmd.thought);

                const executed = await tryHighlightWithFallbacks(execCmd, context, tabInfo);
                if (!executed) {
                    throw new Error('Could not highlight input field');
                }

                await appendHistoryInBackground({ ...executed, status: 'pending' });
                WAITING_CONFIRM = true;
                if (doneBtn) doneBtn.disabled = false;
                updateConfirmButtons();
                CONTEXT_LEVEL = 1;
                setStepCard(`Type "${typeText}" into the highlighted field → Done`, 'pending', 'type');
                return;
            }

            // Handle navigation action
            if (cmd.action === 'navigate' && cmd.url) {
                const targetHost = safeHostname(cmd.url);
                const currentHost = safeHostname(pageUrl || tabInfo.url || '');
                if (targetHost && currentHost && targetHost === currentHost) {
                    const prefix = apiGoal ? '[API-GUARD] ' : '';
                    const feedback = `${prefix}We are already on ${currentHost}. Do not navigate again. Choose a relevant link or button on this page.`;
                    addMsg('System', feedback);
                    if (prefix) addMsg('AI', feedback);
                    await appendHistoryInBackground({ action: 'feedback', thought: feedback, status: 'done' });
                    setStepCard(`Click a link or button on this page → Continue`, 'waiting', 'click');
                    WAITING_CONFIRM = true;
                    if (doneBtn) doneBtn.disabled = false;
                    updateConfirmButtons();
                    STEP_IN_FLIGHT = false;
                    return;
                }
                console.log('📍 Navigate to:', cmd.url);
                addMsg('AI', cmd.thought || `Need to go to: ${cmd.url}`);

                // Try to find and highlight a search bar only on Google home
                console.log('📍 Trying to find search bar for visual search guidance...');
                let foundSearchBar = false;
                if (onGoogleHome) {
                    try {
                        const urlHostname = extractHostname(cmd.url);
                        const searchResp = await sendToContent(tabInfo.id, { action: 'find_search_input', searchTerm: urlHostname });
                        console.log('📍 Search response from content:', searchResp);
                        if (searchResp && searchResp.found) {
                            foundSearchBar = true;
                            console.log('✅ Search bar found, highlighting for hostname:', urlHostname);
                            addMsg('System', '✅ Search box found! Visually highlighted on page.');
                            addMsg('AI', `Search for "${urlHostname}" and press Enter.`);

                            const execCmd = {
                                action: 'navigate',
                                method: 'search',
                                thought: cmd.thought,
                                url: cmd.url,
                                searchTerm: urlHostname
                            };

                            await appendHistoryInBackground({ ...execCmd, status: 'pending' });
                            SEARCH_GUIDED = true;
                            WAITING_CONFIRM = true;
                            if (doneBtn) doneBtn.disabled = false;
                            updateConfirmButtons();
                            setStepCard(`Search for: "${urlHostname}" → Press Enter`, 'waiting', 'search');
                            STEP_IN_FLIGHT = false;
                            return;
                        }
                    } catch (e) {
                        console.log('⚠️ Could not find search bar:', e.message);
                    }
                }

                // Fallback: guide user to manually navigate to URL
                if (!foundSearchBar) {
                    console.log('⚠️ No search bar found, using manual navigation');
                    addMsg('System', `📂 Open new tab and go to: ${cmd.url}`);
                    addMsg('System', 'Once you reach that page, come back and click Done');
                }

                const execCmd = {
                    action: 'navigate',
                    method: 'url',
                    thought: cmd.thought || `Go to ${cmd.url}`,
                    url: cmd.url
                };

                await appendHistoryInBackground({ ...execCmd, status: 'pending' });
                WAITING_CONFIRM = true;
                if (doneBtn) doneBtn.disabled = false;
                updateConfirmButtons();
                setStepCard(`Navigate to: ${cmd.url}`, 'waiting', 'navigate');
                STEP_IN_FLIGHT = false;
                return;
            }

            // Handle click action
            if (cmd.action === 'click') {
                cmd.target_text = cmd.target_text || cmd.text || extractTargetText(cmd.thought || '') || '';

                if (typeof cmd.index === 'number') {
                    const target = availableTargets.find(t => t.index === cmd.index);
                    if (!target) {
                        console.warn('❌ Index not found:', cmd.index);
                    } else {
                        console.log('✅ Target found:', target.label);
                        const execCmd = {
                            action: 'click',
                            thought: cmd.thought || `Click ${target.label}`,
                            index: cmd.index,
                            target_text: target.label,
                            target_type: target.type,
                            url: pageUrl,
                            xpath: target.xpath || '',
                            frameXPath: target.frameXPath || ''
                        };

                        addMsg('AI', execCmd.thought);

                        const executed = await tryHighlightWithFallbacks(execCmd, context, tabInfo);
                        if (!executed) {
                            throw new Error('Could not highlight element');
                        }

                        await appendHistoryInBackground({ ...executed, status: 'pending' });
                        if (doneBtn) doneBtn.disabled = false;
                        updateConfirmButtons();
                        CONTEXT_LEVEL = 1;
                        // Force UI update
                        setStepCard(`Click the highlighted ${target.type} → Done`, 'pending', 'click');
                        STEP_IN_FLIGHT = false;
                        return;
                    }
                }

                // No usable index from AI - fall back to ranking
                console.warn('⚠️ AI did not provide a valid index. Falling back to ranked candidates.');
                const execCmd = {
                    action: 'click',
                    thought: cmd.thought || 'Click the next best match',
                    index: null,
                    target_text: cmd.target_text || GOAL,
                    url: pageUrl
                };

                addMsg('AI', execCmd.thought);

                const executed = await tryHighlightWithFallbacks(execCmd, context, tabInfo);
                if (!executed) {
                    throw new Error('Could not highlight element');
                }

                await appendHistoryInBackground({ ...executed, status: 'pending' });
                WAITING_CONFIRM = true;
                if (doneBtn) doneBtn.disabled = false;
                updateConfirmButtons();
                CONTEXT_LEVEL = 1;
                // Force UI update
                setStepCard('Click the highlighted target → Done', 'pending', 'click');
                STEP_IN_FLIGHT = false;
                return;
            }

            throw new Error('AI action unclear: ' + JSON.stringify(cmd));
        } catch (e) {
            console.error('❌ Error in requestNextStep:', e.message, e.stack);
            const errMsg = String(e.message || '');
            const errorCode = e.code || '';

            // Provide helpful guidance for common errors
            let userMsg = `Error: ${e.message}`;
            if (errorCode === 'auth_invalid') {
                userMsg = '🔑 API key appears invalid. Check Settings → Provider Settings and verify your key.';
            } else if (errorCode === 'rate_limit') {
                userMsg = '⏳ Rate limit hit. Wait a bit and try again.';
            } else if (errorCode === 'model_not_found') {
                userMsg = '📦 Model not found. Clear the model name or choose a valid one.';
            } else if (errorCode === 'timeout') {
                userMsg = '⏱️ Request timed out. Your internet or API might be slow. Try again in 10 seconds.';
            } else if (errorCode === 'network') {
                userMsg = '🌐 Network error. Check your internet connection.';
            } else if (errMsg.includes('returned no content') || errMsg.includes('Empty response')) {
                userMsg = '⚠️ AI returned empty response. Your API might be rate-limited or down. Try clicking Settings to switch to a different provider.';
            } else if (errMsg.includes('timeout')) {
                userMsg = '⏱️ Request timed out. Page might be slow or complex. Try reloading the page and clicking Start again.';
            } else if (errMsg.includes('Content message timeout')) {
                userMsg = '⚠️ Could not communicate with page. The page might have navigated or the tab may have changed. Try again.';
            } else if (errMsg.includes('Invalid response') || errMsg.includes('JSON')) {
                userMsg = '📡 API response was malformed. Try clicking Settings to switch providers.';
            } else if (errMsg.includes('No active tab')) {
                userMsg = '⚠️ No tab found. Open a web page and try again.';
            } else if (errMsg.includes('Network error')) {
                userMsg = '🌐 Network error. Check your internet connection.';
            } else if (errMsg.includes('Could not inject content script') || errMsg.includes('Execution context was destroyed')) {
                userMsg = '⚠️ Could not interact with this page. Try reloading it and clicking Start again.';
            }

            addMsg('System', userMsg);
            console.log('📍 Error recovery: Setting RUNNING=true for retry');

            RUNNING = true;
            btn.innerText = 'Stop';
            WAITING_CONFIRM = false;
            if (doneBtn) doneBtn.disabled = false;
            updateConfirmButtons();
            setStepCard(`${userMsg} Click Done to retry.`, 'error', 'retry', { allowConfirm: true });
        } finally {
            console.log('📍 Finally block: Resetting STEP_IN_FLIGHT');
            STEP_IN_FLIGHT = false;
            hideLoading();
        }
    }

    function escapeHtml(text) {
        if (!text) return '';
        return String(text)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function addMsg(sender, text) {
        if (!SHOW_SYSTEM_MESSAGES && sender === 'System') {
            CHAT_LOG.push({ sender, text, ts: Date.now() });
            scheduleSessionSave();
            return;
        }
        const div = document.createElement('div');
        div.className = `msg ${sender.toLowerCase()}`;
        div.innerHTML = `<strong>${escapeHtml(sender)}:</strong> ${escapeHtml(text)}`;
        chat.appendChild(div);
        chat.scrollTop = chat.scrollHeight;
        CHAT_LOG.push({ sender, text, ts: Date.now() });
        scheduleSessionSave();
    }

    function debugMsg(text) {
        console.log('[GG]', text);
    }

    function setStepCard(text, status, action, options = {}) {
        if (!stepCard || !stepText || !stepStatus || !stepAction) return;
        stepCard.classList.remove('hidden');
        stepText.textContent = text || 'Waiting for a step...';
        stepStatus.textContent = `Status: ${status || 'idle'}`;
        stepAction.textContent = `Action: ${action || '-'}`;
        if (status === 'loading') {
            showLoadingMessage(text || 'Working...');
        } else {
            hideLoadingMessage();
        }
        if (doneBtn && options.allowConfirm !== false) {
            const actionable = ['waiting', 'pending'].includes(status) && action && action !== '-';
            if (actionable) {
                WAITING_CONFIRM = true;
                doneBtn.disabled = false;
                updateConfirmButtons();
            }
        }
    }

    // Wire up top-level UI bridges so functions outside this closure can call addMsg/setStepCard
    _addMsg = addMsg;
    _setStepCard = setStepCard;
    _requestNextStep = requestNextStep;
    _updateConfirmButtons = updateConfirmButtons;
    _appendHistoryInBackground = appendHistoryInBackground;


    function showLoadingMessage(text) {
        if (loadingMsg && loadingMsg.isConnected) {
            const textEl = loadingMsg.querySelector('.loading-text');
            if (textEl) textEl.textContent = text;
            return;
        }
        loadingMsg = document.createElement('div');
        loadingMsg.className = 'msg ai';
        loadingMsg.innerHTML = `<strong>AI:</strong> <span class="loading-text">${escapeHtml(text)}</span> <span class="loading-dots">...</span>`;
        chat.appendChild(loadingMsg);
        chat.scrollTop = chat.scrollHeight;
    }

    function hideLoadingMessage() {
        if (loadingMsg && loadingMsg.isConnected) {
            loadingMsg.remove();
        }
        loadingMsg = null;
    }

    let lastConfirmTime = 0;
    async function confirmStep(source = 'system') {
        const now = Date.now();
        if (now - lastConfirmTime < 2000) {
            console.warn(`🛡️ [Planner] confirmStep debounce block (${now - lastConfirmTime}ms). Source: ${source}`);
            return;
        }
        lastConfirmTime = now;

        console.log(`🛡️ [Planner] confirmStep called by: ${source} | Waiting: ${WAITING_CONFIRM}`);

        // CRITICAL GUARD: If waiting for user, reject system calls
        if (WAITING_CONFIRM && source !== 'user') {
            console.warn('⚠️ [Planner] System attempted to confirm step while waiting for user. Blocked.');
            return;
        }

        try {
            const lastEntry = HISTORY[HISTORY.length - 1];
            if (!WAITING_CONFIRM && (!lastEntry || lastEntry.status !== 'pending')) {
                if (GOAL) {
                    setStepCard('Fetching next step...', 'loading', 'next');
                    await requestNextStep();
                }
                return;
            }
            const lastAction = lastEntry?.action;
            if (lastAction === 'finish') {
                WAITING_CONFIRM = true;
                const notesEl = getFinishNotesEl();
                const note = (notesEl && notesEl.value || '').trim();

                if (FINISH_CHOICE === 'done') {
                    addMsg('System', '✅ Goal confirmed complete.');
                    await updateHistoryEntry(HISTORY.length - 1, { status: 'done' });
                    LAST_FEEDBACK = '';
                    RUNNING = false;
                    GOAL = '';
                    btn.innerText = 'Start';
                    setStepCard('Goal complete!', 'success', 'finish');
                    updateConfirmButtons();
                    await sendToBackground('gg_clear_highlight');
                    WAITING_CONFIRM = false;
                    return;
                }

                if (FINISH_CHOICE !== 'not_done') {
                    ensureFinishPrompt();
                    setStepCard('Choose Finished or Not finished to continue.', 'waiting', 'finish');
                    updateConfirmButtons();
                    return;
                }

                if (!note) {
                    ensureFinishPrompt();
                    if (notesEl) notesEl.classList.remove('hidden');
                    setStepCard('Tell what is missing, then click Continue.', 'waiting', 'finish');
                    updateConfirmButtons();
                    return;
                }

                LAST_FEEDBACK = note;
                await updateHistoryEntry(HISTORY.length - 1, { status: 'done' });
                await appendHistoryInBackground({ action: 'feedback', thought: note, status: 'done' });
                addMsg('You', note);

                addMsg('System', 'Continuing with the next step...');
                setStepCard('Fetching next step...', 'loading', '');
                WAITING_CONFIRM = false;
                updateConfirmButtons();
                await sendToBackground('gg_clear_highlight');
                await requestNextStep();
                return;
            }

            WAITING_CONFIRM = false;

            await updateHistoryEntry(HISTORY.length - 1, { status: 'done' });

            // If the last action was a navigate suggestion, execute it now
            if (lastAction === 'navigate' && lastEntry?.url) {
                console.log('🧭 [confirmStep] Executing pending navigation to:', lastEntry.url);
                setStepCard(`Navigating to ${lastEntry.url}...`, 'loading', 'nav');
                STEP_IN_FLIGHT = true;
                await executeNavigation(lastEntry.url);
                return; // executeNavigation handles advancing the step
            }

            // VERIFY STEP COMPLETION (AI-driven)
            const tabInfo = await getActiveTabInfo();
            const currentStep = ACTION_PLAN[CURRENT_STEP_INDEX];
            const previousUrl = lastEntry?.url || '';
            const currentUrl = tabInfo?.url || '';

            setStepCard('Verifying step...', 'loading', 'next');
            const verified = await verifyCurrentStep(currentStep, previousUrl, currentUrl, tabInfo);

            if (!verified) {
                // Step failed — inject correction steps instead of advancing blindly
                console.warn('⚠️ [Planner] Step verification failed. Injecting correction steps...');
                await injectCorrectionSteps(currentStep, currentUrl);
                WAITING_CONFIRM = false;
                updateConfirmButtons();
                return;
            }

            // Step verified — advance
            CURRENT_STEP_INDEX++;

            let finalUrl = currentUrl || previousUrl;
            if (tabInfo?.url) {
                const onGoogle = /google\./i.test(tabInfo.url || '');
                const onResults = isGoogleResultsUrl(tabInfo.url);
                if (!onGoogle || onResults) {
                    console.log('🔄 Resetting SEARCH_GUIDED flag');
                    SEARCH_GUIDED = false;
                }
            }

            if (lastEntry) {
                const pageChanged = Boolean(finalUrl && previousUrl && finalUrl !== previousUrl);
                await updateHistoryEntry(HISTORY.length - 1, { resultUrl: finalUrl, pageChanged });
            }

            try {
                await sendToBackground('gg_clear_highlight');
            } catch (e) {
                console.warn('⚠️ Could not clear highlight:', e.message);
            }

            // Check if plan is complete
            if (CURRENT_STEP_INDEX >= ACTION_PLAN.length) {
                await checkGoalCompletion();
                return;
            }

            // Move to next step
            console.log(`🚀 [Planner] Step verified. Advancing to step ${CURRENT_STEP_INDEX + 1}/${ACTION_PLAN.length}`);
            WAITING_CONFIRM = false;
            updateConfirmButtons();
            setStepCard('Fetching next step...', 'loading', 'next');
            await requestNextStep();
        } catch (error) {
            console.error('❌ Error in confirmStep:', error);
            addMsg('System', `Error: ${error.message || 'Unknown error'}. Try clicking Done again.`);
            STEP_IN_FLIGHT = false;
            WAITING_CONFIRM = false;
            if (doneBtn) doneBtn.disabled = false;
            setStepCard('Error occurred - click Done to retry', 'error', 'retry');
        }
    }

    updateConfirmButtons();
});


// ─────────────────────────────────────────────────────────────────────────────
// STEP VERIFICATION — called after user clicks Done
// Returns true if step succeeded, false if it failed
// ─────────────────────────────────────────────────────────────────────────────
async function verifyCurrentStep(step, previousUrl, currentUrl, tabInfo) {
    if (!step) {
        // No step info — assume success (e.g. navigation-only steps)
        return true;
    }

    const stepDesc = step.act || step.instruction || '';
    console.log(`🔍 [Verify] Checking step: "${stepDesc}"`);

    // ── Check 0: Trust visually confirmed click actions ───────────────────────
    // If the last history entry was a click that was highlighted (visual confirm),
    // trust it succeeded — avoids false failures on dropdown/menu clicks where URL doesn't change
    const lastEntry = HISTORY[HISTORY.length - 1];
    if (lastEntry?.action === 'click' && lastEntry?.status === 'pending') {
        console.log('✅ [Verify] Check 0 passed: click was visually confirmed, trusting it succeeded');
        _addMsg('System', '✅ Step verified: click action confirmed.');
        return true;
    }

    // ── Check 1: URL changed (free, instant) ──────────────────────────────────
    if (currentUrl && previousUrl && currentUrl !== previousUrl) {
        console.log(`✅ [Verify] Check 1 passed: URL changed from ${previousUrl} to ${currentUrl}`);
        _addMsg('System', `✅ Step verified: page navigated to ${currentUrl}`);
        return true;
    }

    // ── Check 2: expected_url_part in current URL ─────────────────────────────
    if (step.expected_url_part) {
        const onTarget = (currentUrl || '').toLowerCase().includes(step.expected_url_part.toLowerCase());
        if (onTarget) {
            console.log(`✅ [Verify] Check 2 passed: "${step.expected_url_part}" found in URL`);
            _addMsg('System', `✅ Step verified: found "${step.expected_url_part}" in URL.`);
            return true;
        }
    }

    // ── Check 3: keyword visible on page (free, DOM scan) ────────────────────
    const stepKeywords = step.ranking_keywords || step.keys || [];
    if (stepKeywords.length > 0) {
        try {
            const tabId = tabInfo?.id;
            if (tabId) {
                const keyword = stepKeywords[0]; // Use first keyword as signal
                const result = await chrome.scripting.executeScript({
                    target: { tabId },
                    func: (kw) => document.body?.innerText?.toLowerCase().includes(kw.toLowerCase()),
                    args: [keyword]
                });
                const visible = result?.[0]?.result;
                if (visible) {
                    console.log(`✅ [Verify] Check 3 passed: keyword "${keyword}" visible on page`);
                    _addMsg('System', `✅ Step verified: "${keyword}" is visible on the page.`);
                    return true;
                }
            }
        } catch (e) {
            console.warn('[Verify] Keyword check failed:', e.message);
        }
    }

    // ── Check 4: Ask AI (cost — only if all free checks fail) ─────────────────
    try {
        console.log('[Verify] Free checks inconclusive. Asking AI...');
        _setStepCard('Asking AI to verify step...', 'loading', 'next');

        const pageTitle = tabInfo?.title || '';

        // Grab a snapshot of visible text on the page to give AI real context
        let pageSnapshot = '';
        try {
            const snapResult = await chrome.scripting.executeScript({
                target: { tabId: tabInfo?.id },
                func: () => {
                    // Get visible interactive elements and headings as a quick snapshot
                    const els = Array.from(document.querySelectorAll('button, a, [role="menuitem"], h1, h2, h3, [role="menu"]'));
                    return els
                        .filter(el => {
                            const r = el.getBoundingClientRect();
                            return r.width > 5 && r.height > 5;
                        })
                        .slice(0, 30)
                        .map(el => (el.innerText || el.getAttribute('aria-label') || '').trim())
                        .filter(t => t.length > 0)
                        .join(', ');
                }
            });
            pageSnapshot = snapResult?.[0]?.result || '';
        } catch (e) { /* ignore */ }

        const prompt = `You are verifying if a browser action succeeded.

Step attempted: "${stepDesc}"
Previous URL: ${previousUrl || 'unknown'}
Current URL: ${currentUrl || 'unknown'}
Page title: "${pageTitle}"
Visible elements on page: ${pageSnapshot ? pageSnapshot.slice(0, 300) : 'unknown'}

Did the step succeed? Consider: URL change, new elements appearing (menus, dialogs), or page title change.
Reply with ONLY valid JSON:
{"success": true} or {"success": false, "reason": "brief reason"}`;

        const reply = await sendToBackground('gg_ask_ai', { userMessage: prompt, config: CONFIG });
        const text = reply?.reply || reply?.text || '';
        const match = text.match(/\{[\s\S]*?\}/);
        if (match) {
            const parsed = JSON.parse(match[0]);
            if (parsed.success === true) {
                console.log('✅ [Verify] AI confirmed step success');
                _addMsg('System', '✅ AI verified step completion.');
                return true;
            } else {
                console.warn(`⚠️ [Verify] AI says step failed: ${parsed.reason}`);
                _addMsg('System', `⚠️ Step may not have worked: ${parsed.reason || 'AI could not confirm success.'}`);
                return false;
            }
        }
    } catch (e) {
        console.warn('[Verify] AI check failed:', e.message);
    }

    // If all checks fail, assume success to avoid blocking user
    console.warn('[Verify] All checks inconclusive — assuming success to avoid blocking.');
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// INJECT CORRECTION STEPS — called when step verification fails
// Asks AI what went wrong and inserts fix steps into the plan
// ─────────────────────────────────────────────────────────────────────────────
async function injectCorrectionSteps(failedStep, currentUrl) {
    const stepDesc = failedStep?.act || failedStep?.instruction || 'unknown step';

    // Guard: stop infinite correction loops — max 2 correction attempts per step
    failedStep._correctionCount = (failedStep._correctionCount || 0) + 1;
    if (failedStep._correctionCount > 2) {
        console.warn(`[Planner] Step "${stepDesc}" failed ${failedStep._correctionCount} times — skipping to avoid loop.`);
        _addMsg('System', `⏭️ Skipping stuck step after ${failedStep._correctionCount} attempts: "${stepDesc}"`);
        CURRENT_STEP_INDEX++;
        _setStepCard('Skipped stuck step, continuing...', 'loading', 'next');
        await _requestNextStep();
        return;
    }

    _addMsg('System', `🔄 Step "${stepDesc}" didn't seem to work. Figuring out what to do next...`);
    _setStepCard('Calculating correction...', 'loading', 'next');

    try {
        const prompt = `A browser automation step failed.

Failed step: "${stepDesc}"
Current URL: ${currentUrl || 'unknown'}
Original goal: "${GOAL}"

What went wrong and what 1-3 corrective steps should be taken?
Reply with ONLY a JSON array of steps:
[{"id": 1, "act": "description of corrective action", "keys": ["keyword1"]}]`;

        const reply = await sendToBackground('gg_ask_ai', { userMessage: prompt, config: CONFIG });
        const text = reply?.reply || reply?.text || '';

        // Extract JSON array — use greedy match to get the full array
        const match = text.match(/\[[\s\S]*\]/);
        if (match) {
            const correctionSteps = JSON.parse(match[0]);
            if (Array.isArray(correctionSteps) && correctionSteps.length > 0) {
                // Re-number and NORMALIZE correction steps to match requestNextStep schema
                // (AI returns {id, act, keys} but requestNextStep reads {step_id, instruction, ranking_keywords})
                const insertAt = CURRENT_STEP_INDEX + 1;
                const renumbered = correctionSteps.map((s, i) => ({
                    step_id: insertAt + i,
                    instruction: s.act || s.instruction || 'Retry step',
                    ranking_keywords: s.keys || s.ranking_keywords || [],
                    expected_url_part: s.expected_url_part || '',
                    _correction: true
                }));

                // Splice into ACTION_PLAN right after current step
                ACTION_PLAN.splice(insertAt, 0, ...renumbered);

                _addMsg('System', `🔧 Added ${renumbered.length} correction step(s) to the plan.`);
                console.log(`[Planner] Injected ${renumbered.length} correction steps at index ${insertAt}`);

                // Move to the first correction step
                CURRENT_STEP_INDEX = insertAt;
                _setStepCard('Fetching correction step...', 'loading', 'next');
                await _requestNextStep();
                return;
            }
        }
    } catch (e) {
        console.error('[Planner] Failed to inject correction steps:', e.message);
    }

    // Fallback: just advance anyway
    _addMsg('System', '⚠️ Could not generate correction. Moving to next step.');
    CURRENT_STEP_INDEX++;
    if (CURRENT_STEP_INDEX >= ACTION_PLAN.length) {
        await checkGoalCompletion();
    } else {
        await _requestNextStep();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK GOAL COMPLETION — called when all plan steps are done
// Asks AI if the original goal was fully achieved
// ─────────────────────────────────────────────────────────────────────────────
async function checkGoalCompletion() {
    _addMsg('System', '🏁 All steps done. Checking if goal is complete...');
    _setStepCard('Checking goal completion...', 'loading', 'finish');

    try {
        const tabInfo = await getActiveTabInfo();
        const currentUrl = tabInfo?.url || '';
        const pageTitle = tabInfo?.title || '';

        const prompt = `You are checking if a user's goal has been fully achieved.

Original goal: "${GOAL}"
Current URL: ${currentUrl}
Page title: "${pageTitle}"

Is the goal fully achieved? Reply with ONLY valid JSON:
{"finished": true} or {"finished": false, "remaining": [{"id": 1, "act": "next step needed", "keys": ["keyword"]}]}`;

        const reply = await sendToBackground('gg_ask_ai', { userMessage: prompt, config: CONFIG });
        const text = reply?.reply || reply?.text || '';
        const match = text.match(/\{[\s\S]*\}/);

        if (match) {
            const parsed = JSON.parse(match[0]);

            if (parsed.finished === true) {
                // Ask user to confirm completion (Finished / Not finished)
                _addMsg('System', 'AI says the goal is complete. Choose Finished or Not finished, then Continue.');
                const last = HISTORY[HISTORY.length - 1];
                if (!(last && last.action === 'finish' && last.status === 'pending')) {
                    await _appendHistoryInBackground({ action: 'finish', thought: 'Confirm completion', status: 'pending' });
                }
                RUNNING = false;
                WAITING_CONFIRM = true;
                FINISH_CHOICE = '';
                _setStepCard('Confirm goal is complete → Continue', 'waiting', 'finish');
                _updateConfirmButtons();
                await sendToBackground('gg_clear_highlight');
                return;
            }

            if (parsed.finished === false && Array.isArray(parsed.remaining) && parsed.remaining.length > 0) {
                // Goal not done — append remaining steps and continue
                // Normalize remaining steps to match requestNextStep schema
                const normalized = parsed.remaining.map((s, i) => ({
                    step_id: ACTION_PLAN.length + i + 1,
                    instruction: s.act || s.instruction || 'Continue',
                    ranking_keywords: s.keys || s.ranking_keywords || [],
                    expected_url_part: s.expected_url_part || '',
                }));
                _addMsg('System', `📋 Goal not fully achieved. Adding ${normalized.length} more step(s)...`);
                ACTION_PLAN.push(...normalized);
                _setStepCard('Continuing to finish goal...', 'loading', 'next');
                await _requestNextStep();
                return;
            }
        }
    } catch (e) {
        console.error('[Planner] Goal completion check failed:', e.message);
    }

    // Fallback: show manual finish prompt
    _addMsg('System', '✅ Steps complete. Please confirm if the goal is done.');
    const last = HISTORY[HISTORY.length - 1];
    if (!(last && last.action === 'finish' && last.status === 'pending')) {
        await _appendHistoryInBackground({ action: 'finish', thought: 'Confirm completion', status: 'pending' });
    }
    _setStepCard('All steps done. Is the goal complete?', 'waiting', 'finish');
    RUNNING = false;
    WAITING_CONFIRM = true;
    FINISH_CHOICE = '';
    _updateConfirmButtons();
}

async function loadConfig() {
    const resp = await sendToBackground('gg_load_config');
    if (resp && resp.config) {
        CONFIG = resp.config;
        document.getElementById('api-key').value = CONFIG.apiKey || '';
        document.getElementById('provider-select').value = CONFIG.provider || 'gemini';
        document.getElementById('base-url').value = CONFIG.baseUrl || '';
        document.getElementById('model-name').value = CONFIG.modelName || '';
        const bannerToggleEl = document.getElementById('banner-toggle');
        if (bannerToggleEl) bannerToggleEl.checked = CONFIG.showBanners !== false;
        const cdpToggleEl = document.getElementById('cdp-toggle');
        if (cdpToggleEl) cdpToggleEl.checked = CONFIG.enableCdp !== false;
        updateProviderFields(CONFIG.provider || 'gemini');
    }
}

function readConfigFromForm() {
    return {
        provider: document.getElementById('provider-select').value,
        apiKey: document.getElementById('api-key').value.trim(),
        baseUrl: document.getElementById('base-url').value.trim(),
        modelName: document.getElementById('model-name').value.trim(),
        showBanners: Boolean(document.getElementById('banner-toggle')?.checked),
        enableCdp: Boolean(document.getElementById('cdp-toggle')?.checked)
    };
}

function updateProviderFields(value) {
    const baseGroup = document.getElementById('base-url-group');
    const modelGroup = document.getElementById('model-name-group');
    const modelInput = document.getElementById('model-name');

    if (value === 'custom') {
        baseGroup.style.display = 'block';
        modelGroup.style.display = 'block';
        if (modelInput) modelInput.placeholder = 'e.g. llama3, gpt-4';
    } else if (['openrouter', 'groq', 'deepseek', 'openai'].includes(value)) {
        baseGroup.style.display = 'none';
        modelGroup.style.display = 'block';
        if (value === 'groq' && modelInput) {
            modelInput.placeholder = 'e.g. mixtral-8x7b-32768';
        } else if (value === 'deepseek' && modelInput) {
            modelInput.placeholder = 'e.g. deepseek-chat';
        } else if (value === 'openai' && modelInput) {
            modelInput.placeholder = 'e.g. gpt-4o-mini';
        } else if (value === 'openrouter' && modelInput) {
            modelInput.placeholder = 'e.g. openai/gpt-4o-mini';
        }
    } else {
        baseGroup.style.display = 'none';
        modelGroup.style.display = 'none';
    }
}

function buildScanOptions() {
    const preset = CONTEXT_PRESETS[Math.min(CONTEXT_LEVEL - 1, CONTEXT_PRESETS.length - 1)];
    return {
        ...preset,
        preferredTypes: getPreferredTypes(GOAL),
        allowCdp: CONFIG.enableCdp !== false
    };
}

function getPreferredTypes(goalText) {
    const text = (goalText || '').toLowerCase();
    const types = ['button', 'link', 'input_text', 'input_search'];

    if (text.includes('login') || text.includes('sign in')) {
        types.push('input_email', 'input_password');
    }
    if (text.includes('submit') || text.includes('send')) {
        types.push('input_submit');
    }
    if (text.includes('select') || text.includes('dropdown')) {
        types.push('select');
    }
    if (text.includes('upload')) {
        types.push('input_file');
    }
    if (text.includes('search') || text.includes('find') || text.includes('lookup')) {
        types.push('input_search', 'input_text', 'textbox');
    }

    return Array.from(new Set(types));
}

function detectGoalType(goal) {
    const lower = (goal || '').toLowerCase();

    if (/setup|configure|create|account|authenticate|register|signin|login|fill|form|api|key|token/.test(lower)) {
        return 'SETUP';
    }
    if (/search|find|lookup|locate|check|google|look for|search for/.test(lower)) {
        return 'SEARCH';
    }
    if (/click|visit|navigate|go to|open|view|read|see|get/.test(lower)) {
        return 'NAVIGATION';
    }

    return 'GENERIC';
}

function isApiGoal(goalText) {
    return /api\s*key|api\b|token|credential|secret|access key|developer|console|dashboard/i.test(goalText || '');
}

const BM25_K1 = 1.5;
const BM25_B = 0.75;

function tokenizeForBm25(text) {
    return (text || '')
        .toLowerCase()
        // Allow letters, numbers, and symbols/emojis (Unicode)
        .replace(/[^\p{L}\p{N}\p{S}]+/gu, ' ')
        .split(' ')
        .filter(token => token.length >= 1); // Allow single-char tokens (emojis)
}

function buildTargetDocText(target) {
    const parts = [
        target.label || '',
        target.text || '',
        target.type || '',
        target.axRole || ''
    ];
    return parts.join(' ');
}

function rankTargetsByBm25(targets, query) {
    if (!Array.isArray(targets) || targets.length === 0) return [];
    const docs = targets.map(target => tokenizeForBm25(buildTargetDocText(target)));
    const docLengths = docs.map(tokens => tokens.length || 0);
    const avgdl = docLengths.reduce((sum, len) => sum + len, 0) / docLengths.length || 1;

    const df = new Map();
    docs.forEach(tokens => {
        const unique = new Set(tokens);
        unique.forEach(term => df.set(term, (df.get(term) || 0) + 1));
    });

    const queryTokens = Array.from(new Set(tokenizeForBm25(query)));
    return targets.map((target, idx) => {
        const tokens = docs[idx];
        if (!tokens.length || !queryTokens.length) {
            return { ...target, _bm25: 0 };
        }
        const tf = new Map();
        tokens.forEach(term => tf.set(term, (tf.get(term) || 0) + 1));

        let score = 0;
        for (const term of queryTokens) {
            const termFreq = tf.get(term) || 0;
            if (!termFreq) continue;
            const docFreq = df.get(term) || 0;
            const idf = Math.log(1 + (targets.length - docFreq + 0.5) / (docFreq + 0.5));
            const dl = docLengths[idx];
            const denom = termFreq + BM25_K1 * (1 - BM25_B + BM25_B * (dl / avgdl));
            score += idf * ((termFreq * (BM25_K1 + 1)) / denom);
        }
        return { ...target, _bm25: score };
    }).sort((a, b) => (b._bm25 || 0) - (a._bm25 || 0));
}

function extractDomainFromUrl(url) {
    if (!url) return '';
    try {
        const u = new URL(url);
        return u.hostname.replace(/^www\./, '');
    } catch (e) {
        return '';
    }
}

function detectPrimaryDomain(goal) {
    const lower = (goal || '').toLowerCase();
    // Simple heuristic: look for known domain keywords in goal
    const patterns = [
        { regex: /github\.com/, domain: 'github.com' },
        { regex: /reddit\.com/, domain: 'reddit.com' },
        { regex: /deepseek/, domain: 'deepseek.com' },
        { regex: /openai/, domain: 'openai.com' },
        { regex: /anthropic/, domain: 'anthropic.com' },
        { regex: /google/, domain: 'google.com' },
        { regex: /youtube/, domain: 'youtube.com' },
        { regex: /wikipedia/, domain: 'wikipedia.org' }
    ];
    for (const { regex, domain } of patterns) {
        if (regex.test(lower)) return domain;
    }
    return null;
}

function filterTargetsByGoal(targets, goal, pageUrl) {
    if (!targets || targets.length === 0) return targets;

    const lower = (goal || '').toLowerCase();
    const goalTokens = getGoalTokens(goal);
    const onResults = isGoogleResultsUrl(pageUrl || '');
    const primaryDomain = detectPrimaryDomain(goal);

    // GENERALIZED APPROACH: Re-rank based on semantic signals, don't filter aggressively
    // STRICT CLICKABLE FILTER: Only allow buttons, links, and inputs with AX match or clear label
    const clickableTypes = ['button', 'link', 'input_text', 'input_password', 'input_submit', 'select', 'textarea'];
    const filtered = targets.filter(t => {
        // Must be a clickable/interactable type
        if (!clickableTypes.includes(t.type)) return false;
        // Must have a label or AX match
        if (!(t.label && t.label.length > 0) && !t.axMatch) return false;
        return true;
    });

    // Rerank filtered targets as before
    const sortedTargets = filtered
        .map(target => {
            let score = (target._bm25 || 0) + scoreTargetMatch(target, goalTokens);
            if (target.axMatch) score += 2;
            if (onResults && target.type === 'link') score += 3;
            if (target.ariaLabel) score += 1;
            if (onResults) {
                const positionBonus = Math.max(0, 35 - target.index * 0.35);
                score += positionBonus;
            }
            if (onResults && target.type === 'link' && primaryDomain) {
                const linkDomain = extractDomainFromUrl(target.url || target.href || '');
                if (linkDomain && linkDomain.includes(primaryDomain.split('.')[0])) {
                    score += 10;
                }
            }
            if (onResults && target.type === 'link') {
                const label = (target.label || '').toLowerCase();
                if (/^(how to|tutorial|guide|here\'s|step by|beginners|explained|what is|custom|reddit)/i.test(label)) {
                    score -= 2;
                }
            }
            if (/setup|configure|create|authenticate|fill|form|api|key|token|login|sign up/.test(lower)) {
                if (/button|input|select|textarea|form/.test(target.type || '')) score += 1.5;
            }
            return { ...target, _score: score };
        })
        .sort((a, b) => b._score - a._score);

    // On search results, prioritize official domain links
    if (onResults) {
        const officialLinks = sortedTargets.filter(t => {
            if (t.type !== 'link' || !primaryDomain) return false;
            const linkDomain = extractDomainFromUrl(t.url || t.href || '');
            return linkDomain && linkDomain.includes(primaryDomain.split('.')[0]);
        });
        if (officialLinks.length > 0) {
            officialLinks.sort((a, b) => {
                const lenA = ((a.label || '') + (a.text || '')).length;
                const lenB = ((b.label || '') + (b.text || '')).length;
                return lenB - lenA;
            });
            return officialLinks;
        }
        const links = sortedTargets.filter(t => t.type === 'link');
        const others = sortedTargets.filter(t => t.type !== 'link');
        links.sort((a, b) => {
            let scoreA = 0, scoreB = 0;
            const textA = (a.label || '').toLowerCase();
            const textB = (b.label || '').toLowerCase();
            if (/^(how to|tutorial|guide|step by|explained)/i.test(textA)) scoreA -= 20;
            if (/^(how to|tutorial|guide|step by|explained)/i.test(textB)) scoreB -= 20;
            scoreA += ((a.label || '').length / 10);
            scoreB += ((b.label || '').length / 10);
            return scoreB - scoreA;
        });
        return links.concat(others);
    }
    return sortedTargets;
}

function getBestLinkTarget(targets) {
    if (!Array.isArray(targets)) return null;
    const link = targets.find(t => t.type === 'link');
    return link || null;
}

function buildFallbackCmd(targets, goalText, pageUrl, reason) {
    const best = Array.isArray(targets) ? targets.find(t => typeof t.index === 'number') : null;
    if (!best) return null;
    return {
        action: 'click',
        index: best.index,
        text: '',
        url: pageUrl || '',
        target_text: best.label || best.text || goalText || '',
        thought: reason || 'Fallback to best match'
    };
}

const MAX_PROMPT_CONTENT_CHARS = 1800;

function formatContentSummary(contentSummary) {
    if (!contentSummary) return '';
    const lines = [];
    if (contentSummary.title) lines.push(`Content Title: ${contentSummary.title}`);
    if (contentSummary.byline) lines.push(`Byline: ${contentSummary.byline}`);
    if (contentSummary.excerpt) lines.push(`Excerpt: ${contentSummary.excerpt}`);

    const markdown = contentSummary.markdown || '';
    const text = contentSummary.text || '';
    const body = markdown || text;
    if (body) {
        const trimmed = body.length > MAX_PROMPT_CONTENT_CHARS
            ? body.slice(0, MAX_PROMPT_CONTENT_CHARS) + '...'
            : body;
        lines.push(`Main Content (truncated):\n${trimmed}`);
    }

    return lines.length ? `\n\nPage Content Summary:\n${lines.join('\n')}` : '';
}

function sendToBackground(action, payload = {}) {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            reject(new Error(`Background action "${action}" timed out`));
        }, 8000);

        chrome.runtime.sendMessage({ action, ...payload }, response => {
            clearTimeout(timeoutId);
            if (chrome.runtime.lastError) {
                console.warn(`Background message error: ${chrome.runtime.lastError.message}`);
                resolve({}); // Resolve with empty to avoid breaking flows, or reject if critical
            } else {
                resolve(response || {});
            }
        });
    });
}

function sendToContent(tabId, message, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        let timeoutId = null;
        let responded = false;

        timeoutId = setTimeout(() => {
            if (!responded) {
                responded = true;
                reject(new Error(`Content message timeout after ${timeoutMs}ms - tab may have navigated or content script not loaded`));
            }
        }, timeoutMs);

        chrome.tabs.sendMessage(tabId, message, { frameId: 0 }, response => {
            if (responded) return; // Already timed out
            responded = true;
            clearTimeout(timeoutId);

            const err = chrome.runtime.lastError;
            if (err) reject(new Error(err.message || 'Message send failed'));
            else resolve(response);
        });
    });
}

async function getActiveTabInfo() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return { id: tab?.id || null, url: tab?.url || '', title: tab?.title || '', status: tab?.status || '' };
}

function isRestrictedUrl(url) {
    if (!url) return true;
    return (
        url.startsWith('chrome://') ||
        url.startsWith('edge://') ||
        url.startsWith('about:') ||
        url.startsWith('chrome-extension://')
    );
}

function isNewTabUrl(url) {
    if (!url) return false;
    return (
        url.startsWith('chrome://newtab') ||
        url.startsWith('edge://newtab') ||
        url.startsWith('about:newtab')
    );
}

function extractGoalDomain(goalText) {
    const text = (goalText || '').toLowerCase();
    const urlMatch = text.match(/https?:\/\/[^\s]+/i);
    if (urlMatch) {
        try {
            return new URL(urlMatch[0]).hostname.replace(/^www\./, '');
        } catch (e) {
            return '';
        }
    }

    const domainMatch = text.match(/\b([a-z0-9-]+\.)+[a-z]{2,}\b/i);
    if (domainMatch) {
        return domainMatch[0].replace(/^www\./, '');
    }

    return '';
}

function safeHostname(url) {
    if (!url) return '';
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return '';
    }
}

function normalizeUrl(url) {
    if (!url) return '';
    try {
        const parsed = new URL(url);
        parsed.hash = '';
        let normalized = parsed.toString();
        if (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
        return normalized;
    } catch {
        return url.trim();
    }
}

function normalizeGoal(text) {
    if (!text) return '';
    const cleaned = text.replace(/\r/g, '').trim();

    // If prompt is a numbered/bulleted list, take the first actionable line.
    const lines = cleaned.split('\n').map(l => l.trim()).filter(Boolean);
    const numbered = lines.find(l => /^(\d+[\.\)]|[0-9]️⃣|[-*•])\s+/u.test(l));
    if (numbered) {
        const firstLine = numbered.replace(/^(\d+[\.\)]|[0-9]️⃣|[-*•])\s+/u, '').trim();
        if (firstLine) return firstLine.slice(0, 160);
    }

    // If prompt contains "Step 1:" style, keep only the first step.
    if (/step\s*\d+/i.test(cleaned)) {
        const stepMatch = cleaned.split(/step\s*\d+\s*[:.-]?/i).filter(Boolean);
        if (stepMatch.length) {
            const first = stepMatch[0].trim();
            const urlMatch = first.match(/https?:\/\/[^\s]+/i);
            if (urlMatch) return first;
            const sentenceEnd = first.search(/[.!?](\s|$)/);
            if (sentenceEnd > 0) return first.slice(0, sentenceEnd + 1);
            return first.slice(0, 160);
        }
    }

    // Otherwise, keep the first sentence to avoid long, confusing prompts.
    const sentenceEnd = cleaned.search(/[.!?](\s|$)/);
    if (sentenceEnd > 0) return cleaned.slice(0, sentenceEnd + 1).trim();

    return cleaned.slice(0, 160);
}

function isLikelyGoalComplete(goalText, pageUrl, pageTitle, historyCount) {
    if (!goalText) return false;
    const goal = goalText.toLowerCase();
    const url = (pageUrl || '').toLowerCase();
    const title = (pageTitle || '').toLowerCase();

    const domain = extractGoalDomain(goalText);
    if (domain && url.includes(domain)) return true;

    const tokens = goal
        .replace(/https?:\/\/[^\s]+/g, '')
        .split(/[^a-z0-9]+/i)
        .filter(t => t.length >= 4)
        .slice(0, 6);

    const apiSignals = ['api', 'key', 'token', 'console', 'dashboard', 'developer', 'access'];
    const hasApiSignal = apiSignals.some(t => url.includes(t) || title.includes(t));

    if (tokens.length && (tokens.some(t => url.includes(t)) || tokens.some(t => title.includes(t)))) {
        if (isApiGoal(goalText)) return true;
        return historyCount > 0;
    }

    if (isApiGoal(goalText) && hasApiSignal) return true;

    return false;
}

async function tryHighlightWithFallbacks(cmd, context, tabInfo) {
    if (!tabInfo.id) {
        console.error('❌ [Planner] tryHighlightWithFallbacks: No tab ID');
        return null;
    }

    // Ensure content script is loaded on this tab before attempting visual commands
    try {
        await sendToBackground('gg_ensure_content_script', { tabId: tabInfo.id });
    } catch (e) {
        console.warn('⚠️ Could not inject content script:', e.message);
    }

    const attempts = buildCandidateAttempts(cmd, context);
    console.log(`🎯 [Planner] Attempting visual command with ${attempts.length} candidates`);

    for (const [i, attempt] of attempts.entries()) {
        console.log(`🔸 [Planner] Attempt ${i + 1}/${attempts.length}: Index ${attempt.index} (${attempt.text || 'no text'})`);
        try {
            const response = await sendToContent(tabInfo.id, {
                action: 'visual_command',
                type: attempt.action,
                id: typeof attempt.index === 'number' ? attempt.index : undefined,
                xpath: attempt.xpath || '',
                frameXPath: attempt.frameXPath || '',
                text: attempt.text || '',
                value: attempt.value || '',
                submitAfter: cmd.submitAfter || false  // Pass submitAfter flag
            }, 5000); // 5 second timeout for visual commands

            if (response && response.ok) {
                console.log(`✅ [Planner] Visual command succeeded on attempt ${i + 1}`);
                return attempt;
            } else {
                console.warn(`⚠️ [Planner] Visual command returned not-ok:`, response);
            }
        } catch (e) {
            console.warn(`⚠️ [Planner] Attempt ${i + 1} failed:`, e.message);
        }
    }

    console.error('❌ [Planner] All visual command attempts failed.');
    return null;
}

function buildCandidateAttempts(cmd, context) {
    const attempts = [];

    // Try AI's suggested index first (if it's valid)
    if (typeof cmd.index === 'number') {
        attempts.push({
            action: cmd.action || 'click',
            thought: cmd.thought,
            text: cmd.target_text || cmd.text || '',
            value: cmd.value || cmd.text || '',
            index: cmd.index,
            xpath: cmd.xpath || '',
            frameXPath: cmd.frameXPath || ''
        });
    }

    // Then try ranking others as fallback
    const query = (cmd.target_text || cmd.text || GOAL).toLowerCase();
    const ranked = rankCandidates(context, query);

    for (const candidate of ranked) {
        // Skip if we already tried this one
        if (attempts.some(a => a.index === candidate.index)) continue;

        attempts.push({
            action: cmd.action || 'click',
            thought: cmd.thought,
            text: candidate.text || candidate.label,
            value: cmd.value || cmd.text || '',
            index: typeof candidate.index === 'number' ? candidate.index : null,
            xpath: candidate.xpath || '',
            frameXPath: candidate.frameXPath || ''
        });
        if (attempts.length >= 6) break;
    }

    return attempts;
}

function rankCandidates(context, query) {
    const summary = context?.elementSummary || [];
    const target = normalizeTarget(query);

    // Extract goal keywords for smart matching
    const goalKeywords = extractGoalKeywords(query);
    const genericButtons = ['search', 'menu', 'more', 'options', 'settings', 'help', 'close', 'cancel'];

    const candidates = [];

    for (const group of summary) {
        for (const ex of group.examples || []) {
            if (typeof ex.index !== 'number') continue;
            const text = normalizeTarget(ex.text || '');
            const label = normalizeTarget(ex.label || '');
            const combined = text + ' ' + label;

            let score = 0;

            // Bonus for goal keyword matches
            for (const keyword of goalKeywords) {
                if (combined.includes(keyword)) score += 5;
                if (text === keyword || label === keyword) score += 10; // Exact match
            }

            // Penalty for generic buttons (unless goal mentions them)
            const isGeneric = genericButtons.some(g => combined.includes(g));
            if (isGeneric && !goalKeywords.some(k => genericButtons.includes(k))) {
                score -= 3;
            }

            // Original matching
            if (target && (text.includes(target) || label.includes(target))) score += 4;
            if (text) score += 1;
            if (label) score += 1;
            if (group.type === 'button') score += 1;
            if (ex.axMatch) score += 2;
            // If goal is search-like, prefer inputs over buttons
            if (goalKeywords.includes('search') || goalKeywords.includes('query')) {
                if ((group.type || '').includes('input') || (group.type || '').includes('textarea')) score += 3;
                if ((group.type || '').includes('button')) score -= 1;
            }

            candidates.push({
                ...ex,
                score
            });
        }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates;
}

function extractGoalKeywords(query) {
    const lower = (query || '').toLowerCase();
    const keywords = [];

    // Common action keywords
    if (/api|key/.test(lower)) keywords.push('api', 'key', 'generate', 'create');
    if (/upload|add|import/.test(lower)) keywords.push('upload', 'add', 'import', 'new');
    if (/login|signin|sign in/.test(lower)) keywords.push('login', 'sign in', 'signin');
    if (/logout|signout|sign out/.test(lower)) keywords.push('logout', 'sign out', 'signout');
    if (/download|export/.test(lower)) keywords.push('download', 'export', 'save');
    if (/delete|remove/.test(lower)) keywords.push('delete', 'remove', 'trash');
    if (/edit|modify|change/.test(lower)) keywords.push('edit', 'modify', 'update');
    if (/documentation|docs/.test(lower)) keywords.push('docs', 'documentation', 'guide');
    if (/search|find|lookup|query/.test(lower)) keywords.push('search', 'find', 'lookup', 'query', 'input', 'textbox');

    return keywords;
}

function normalizeTarget(text) {
    return (text || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function getGoalTokens(goalText) {
    const cleaned = normalizeTarget(goalText || '');
    const tokens = cleaned.split(' ').filter(t => t.length >= 3);
    const common = new Set(['the', 'and', 'for', 'with', 'from', 'your', 'this', 'that', 'get', 'find', 'open']);
    return tokens.filter(t => !common.has(t));
}

function scoreTargetMatch(target, goalTokens) {
    if (!goalTokens || goalTokens.length === 0) return 0;
    const hay = normalizeTarget(`${target.label || ''} ${target.text || ''}`);
    if (!hay) return 0;

    let score = 0;
    const expandedTokens = expandGoalTokens(goalTokens);
    for (const token of expandedTokens) {
        if (hay.includes(token)) score += 2;
    }
    if ((target.type || '').includes('button')) score += 0.5;
    return score;
}

function expandGoalTokens(tokens) {
    const synonyms = {
        api: ['developer', 'platform', 'console', 'dashboard', 'docs', 'documentation'],
        key: ['token', 'credential', 'secret', 'access'],
        login: ['signin', 'sign in', 'log in']
    };

    const expanded = new Set(tokens);
    for (const token of tokens) {
        const related = synonyms[token];
        if (related) {
            related.forEach(item => expanded.add(item));
        }
    }

    return Array.from(expanded);
}

function extractHostname(url) {
    try {
        const urlObj = new URL(url);
        return urlObj.hostname.replace(/^www\./, '');
    } catch (e) {
        return url;
    }
}

function extractTargetText(text) {
    if (!text) return '';
    const singleQuote = text.match(/'([^']+)'/);
    if (singleQuote && singleQuote[1]) return singleQuote[1].trim();
    const doubleQuote = text.match(/"([^"]+)"/);
    if (doubleQuote && doubleQuote[1]) return doubleQuote[1].trim();
    return '';
}



async function waitForUrlChange(tabId, previousUrl, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const tab = await chrome.tabs.get(tabId);
        const url = tab?.url || '';
        if (url && url !== previousUrl) return url;
        await new Promise(resolve => setTimeout(resolve, 400));
    }
    return '';
}
function formatUrlForSearch(url) {
    try {
        const urlObj = new URL(url);
        const host = urlObj.hostname
            .replace(/^www\./, '')
            .replace(/\.com$|\.org$|\.net$|\.io$|\.co$/, '')
            .split('.')
            .join(' ');
        return host.charAt(0).toUpperCase() + host.slice(1);
    } catch {
        return url;
    }
}

function withTimeout(promise, ms, message) {
    let timeoutId;
    const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function isGoogleResultsUrl(url) {
    const lowered = (url || '').toLowerCase();
    if (!/google\./i.test(lowered)) return false;
    if (lowered.includes('/search')) return true;
    if (lowered.includes('?q=')) return true;
    if (lowered.includes('&q=')) return true;
    if (lowered.includes('#q=')) return true;
    if (lowered.includes('tbm=') || lowered.includes('webhp?')) return true;
    return false;
}

function isGoogleHomeUrl(url) {
    if (!url) return false;
    try {
        const parsed = new URL(url);
        if (!/google\./i.test(parsed.hostname)) return false;
        const path = parsed.pathname || '/';
        if (path === '/' || path === '/webhp') return true;
        return false;
    } catch {
        return false;
    }
}

function shouldUseSearchShortcut(goalText) {
    if (!goalText) return false;
    const text = goalText.toLowerCase();
    // ONLY use search shortcut if explicitly mentioned
    if (/(^search |^google |search for|google for)/i.test(text)) return true;
    return false;
}

function shouldGuideSearchAnywhere(goalText) {
    if (!goalText) return false;
    return /search|find|lookup|query/i.test(goalText);
}

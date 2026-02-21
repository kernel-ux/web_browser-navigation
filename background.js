const DEFAULT_CONFIG = {
  provider: 'gemini',
  apiKey: '',
  baseUrl: '',
  modelName: '',
  showBanners: true,
  enableCdp: false
};

const DEFAULT_MODELS = {
  gemini: 'gemini-1.5-flash-latest',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-sonnet-20241022',
  deepseek: 'deepseek-chat',
  openrouter: 'meta-llama/llama-3.1-8b-instruct:free',
  groq: 'mixtral-8x7b-32768',
  custom: ''
};

const AI_TIMEOUT_MS = 45000;
const HISTORY_LIMIT = 10;
const ACTION_HISTORY_KEY = 'gg_action_history';

class TaskGuideManager {
  constructor() {
    this.pageContext = null;
    this.history = [];
    this.config = { ...DEFAULT_CONFIG };
  }

  async loadConfig() {
    const data = await storageGet(['gg_config']);
    this.config = { ...DEFAULT_CONFIG, ...(data.gg_config || {}) };
    return this.config;
  }

  async saveConfig(config) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    await storageSet({ gg_config: this.config });
    return this.config;
  }

  async loadHistory() {
    const data = await storageGet(['gg_history']);
    this.history = Array.isArray(data.gg_history) ? data.gg_history : [];
    return this.history;
  }

  async saveHistory() {
    await storageSet({ gg_history: this.history });
  }

  async clearHistory() {
    this.history = [];
    await storageSet({ gg_history: [] });
  }

  async setHistory(history) {
    this.history = Array.isArray(history) ? history : [];
    if (this.history.length > HISTORY_LIMIT) {
      this.history = this.history.slice(-HISTORY_LIMIT);
    }
    await this.saveHistory();
    return this.history;
  }

  async appendHistory(entry) {
    this.history.push(entry);
    if (this.history.length > HISTORY_LIMIT) {
      this.history = this.history.slice(-HISTORY_LIMIT);
    }
    await this.saveHistory();
    return this.history;
  }

  async scanActiveTab(options = {}) {
    await this.loadConfig();
    const tab = await queryActiveTab();
    if (!tab || !tab.id) throw new Error('No active tab found');

    await ensureContentScript(tab.id);
    const scan = await withTimeout(
      sendMessageToTab(tab.id, { action: 'scan_context' }, { frameId: 0 }),
      7000,
      'Scan timed out'
    );

    if (scan?.error) throw new Error(scan.error);

    let elements = Array.isArray(scan?.elements) ? scan.elements : [];
    let iframeSummary = scan?.iframeSummary || { crossOrigin: [], accessibleCount: 0 };
    let cdpUsed = false;
    let axIndex = null;
    let axUsed = false;

    const allowCdp = options.allowCdp !== false && this.config.enableCdp !== false;
    const allowAx = options.allowAx !== false && allowCdp;
    if (allowAx) {
      const axScan = await scanViaAxTree(tab.id);
      if (axScan?.axIndex?.labels?.size) {
        axIndex = axScan.axIndex;
        axUsed = true;
      }
    }
    if (!elements.length && allowCdp) {
      const cdpScan = await scanViaCdp(tab.id);
      if (cdpScan?.elements?.length) {
        elements = cdpScan.elements;
        cdpUsed = true;
      }
    }

    const context = {
      url: scan?.page?.url || tab.url || '',
      title: scan?.page?.title || tab.title || '',
      elementSummary: buildElementSummary(elements, { ...options, axIndex }),
      availableTargets: buildAvailableTargets(elements, { ...options, axIndex }),
      contentSummary: scan?.contentSummary || null,
      iframeSummary,
      cdpUsed,
      axUsed,
      axSummary: axIndex ? { labels: axIndex.labels.size, nodes: axIndex.count } : null
    };

    this.pageContext = context;
    return context;
  }

  buildSystemMessage() {
    return `You are a web automation assistant. Your STRICT job:
1. Read the goal AND the feedback history carefully
2. Choose ONE action to progress toward it
3. NEVER repeat actions you've already tried
4. Only say "finish" when goal is COMPLETELY done

CRITICAL RULES:
- Do NOT suggest actions already in history (same click, search, or navigation)
- If user says goal is "not finished" with feedback, DO THAT FEEDBACK
- Listen to system feedback - if told to try different approach, actually do it
- Do NOT say "finish" unless the goal is 100% clearly complete
- RESPONSE MUST BE VALID JSON ONLY - no explanations, no markdown, no extra text

Actions:
- click [index] - Click element with index
- type [index] "text" - Type into an input/field
- navigate [url] - Go to different website (only if needed)
- finish - Goal is proven complete

RETURN ONLY THIS JSON FORMAT (nothing else):
{"action":"click"|"type"|"navigate"|"finish", "index":N, "text":"...", "url":"...", "thought":"brief reason"}

IMPORTANT: Your entire response must be parseable JSON. Keep "thought" field to max 10 words.`;
  }

  addToHistory(role, content) {
    this.history.push({ role, content });
    if (this.history.length > HISTORY_LIMIT) {
      this.history = this.history.slice(-HISTORY_LIMIT);
    }
  }

  async askAI(userMessage) {
    await this.loadConfig();
    await this.loadHistory();

    const systemMessage = this.buildSystemMessage();
    const messages = [{ role: 'system', content: systemMessage }, ...this.history, { role: 'user', content: userMessage }];

    console.log('[TaskGuide] askAI: Calling provider with retry logic, timeout', AI_TIMEOUT_MS, 'ms...');
    let reply;
    try {
      reply = await this.callProviderWithRetry(messages);
    } catch (err) {
      console.error('[TaskGuide] askAI error:', err.message);
      throw err;
    }

    if (!reply || reply.trim() === '') {
      console.error('[TaskGuide] askAI returned empty reply');
      throw new Error('AI returned empty response - check API status or try a different provider');
    }

    console.log('[TaskGuide] askAI got reply:', reply.slice(0, 100));
    this.addToHistory('user', userMessage);
    this.addToHistory('assistant', reply);
    await this.saveHistory();

    return reply;
  }

  async callProviderWithRetry(messages, maxRetries = 2) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[TaskGuide] Attempt ${attempt}/${maxRetries}...`);
        return await callProvider(this.config, messages);
      } catch (err) {
        lastError = err;
        const classified = classifyProviderError(err);

        // Only retry on rate limit errors
        if (classified.code === 'rate_limit' && attempt < maxRetries) {
          const delayMs = Math.min(2000 * attempt, 5000); // 2s, 4s max
          console.warn(`[TaskGuide] Rate limit hit, retrying in ${delayMs}ms...`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
          continue;
        }

        // Don't retry other errors
        throw err;
      }
    }
    throw lastError;
  }

  async testConnection() {
    const systemMessage = this.buildSystemMessage();
    const messages = [{ role: 'system', content: systemMessage }, { role: 'user', content: "Say 'OK'" }];
    return callProvider(this.config, messages);
  }
}

const manager = new TaskGuideManager();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'gg_load_config') {
    manager.loadConfig().then(config => sendResponse({ config })).catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (request.action === 'gg_save_config') {
    manager.saveConfig(request.config || {}).then(config => sendResponse({ config })).catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (request.action === 'gg_clear_history') {
    manager.clearHistory().then(() => sendResponse({ ok: true })).catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (request.action === 'gg_load_action_history') {
    loadActionHistory().then(history => sendResponse({ history })).catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (request.action === 'gg_set_action_history') {
    setActionHistory(request.history || []).then(history => sendResponse({ history })).catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (request.action === 'gg_append_action_history') {
    appendActionHistory(request.entry || {}).then(history => sendResponse({ history })).catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (request.action === 'gg_clear_action_history') {
    clearActionHistory().then(() => sendResponse({ ok: true })).catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (request.action === 'gg_scan_page') {
    const options = request.options || {};
    manager.scanActiveTab(options).then(context => sendResponse({ context })).catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (request.action === 'gg_clear_highlight') {
    queryActiveTab()
      .then(tab => {
        if (!tab || !tab.id) throw new Error('No active tab found');
        return sendMessageToTab(tab.id, { action: 'clear_highlight' }, { frameId: 0 });
      })
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }


  if (request.action === 'gg_ask_ai') {
    manager
      .askAI(request.userMessage || '')
      .then(reply => sendResponse({ reply }))
      .catch(err => {
        const classified = classifyProviderError(err);
        sendResponse({ error: classified.message, errorCode: classified.code });
      });
    return true;
  }

  if (request.action === 'gg_test_connection') {
    const tempConfig = request.config ? { ...DEFAULT_CONFIG, ...request.config } : null;
    if (tempConfig) {
      const systemMessage = manager.buildSystemMessage();
      const messages = [{ role: 'system', content: systemMessage }, { role: 'user', content: "Say 'OK'" }];
      callProvider(tempConfig, messages)
        .then(reply => sendResponse({ reply }))
        .catch(err => sendResponse({ error: err.message }));
    } else {
      manager.testConnection().then(reply => sendResponse({ reply })).catch(err => sendResponse({ error: err.message }));
    }
    return true;
  }

  if (request.action === 'gg_list_sessions') {
    loadSessions()
      .then(sessions => sendResponse({ sessions }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (request.action === 'gg_save_session') {
    saveSession(request.session || {})
      .then(session => sendResponse({ session }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (request.action === 'gg_load_session') {
    loadSession(request.sessionId)
      .then(session => sendResponse({ session }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (request.action === 'gg_delete_session') {
    deleteSession(request.sessionId)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (request.action === 'gg_ensure_content_script') {
    const tabId = request.tabId;
    if (!tabId) {
      sendResponse({ error: 'No tabId provided' });
      return false;
    }
    ensureContentScript(tabId)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
});

function classifyElement(el) {
  const tag = (el.tag || '').toLowerCase();
  const role = (el.role || '').toLowerCase();
  if (tag === 'button' || role === 'button') return 'button';
  if (tag === 'a' || role === 'link') return 'link';
  if (tag === 'select') return 'select';
  if (tag === 'textarea') return 'textarea';
  if (tag === 'input') return `input_${(el.inputType || 'text').toLowerCase()}`;
  return tag || 'element';
}

const AX_INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'menuitem',
  'tab',
  'switch',
  'option',
  'listbox',
  'slider',
  'spinbutton'
]);

function normalizeLabel(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getAxBooleanProp(node, propName) {
  if (!node || !Array.isArray(node.properties)) return false;
  const prop = node.properties.find(item => item.name === propName);
  return Boolean(prop && prop.value && prop.value.value === true);
}

function buildAxIndex(axNodes) {
  const labels = new Set();
  const roles = new Map();
  let count = 0;

  for (const node of axNodes || []) {
    if (!node || node.ignored) continue;
    const role = String(node.role?.value || '').toLowerCase();
    const name = String(node.name?.value || '').trim();
    if (!name) continue;

    const focusable = getAxBooleanProp(node, 'focusable');
    const editable = getAxBooleanProp(node, 'editable');
    const interactive = AX_INTERACTIVE_ROLES.has(role) || focusable || editable;
    if (!interactive) continue;

    const normalized = normalizeLabel(name);
    if (!normalized) continue;

    labels.add(normalized);
    if (!roles.has(normalized) && role) {
      roles.set(normalized, role);
    }
    count += 1;
  }

  return { labels, roles, count };
}

async function scanViaAxTree(tabId) {
  try {
    await attachDebugger(tabId);
    await sendCdpCommand(tabId, 'Accessibility.enable', {});
    const result = await sendCdpCommand(tabId, 'Accessibility.getFullAXTree', {});
    const nodes = result?.nodes || [];
    return { axIndex: buildAxIndex(nodes) };
  } catch (e) {
    console.warn('[GhostGuide] AX tree scan failed:', e.message);
    return { axIndex: null };
  } finally {
    await detachDebugger(tabId);
  }
}

async function scanViaCdp(tabId) {
  try {
    await attachDebugger(tabId);
    const script = `(() => {
      const selectors = 'button,a,input,select,textarea,[role="button"],[role="link"],[role="menuitem"],[role="tab"]';
      const list = Array.from(document.querySelectorAll(selectors));
      const getText = (el) => {
        const text = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || '').trim();
        return text.replace(/\s+/g, ' ').slice(0, 80);
      };
      const makeXPath = (el) => {
        if (!el || el.nodeType !== 1) return '';
        const parts = [];
        let node = el;
        while (node && node.nodeType === 1 && node !== document.body) {
          let index = 1;
          let sib = node.previousSibling;
          while (sib) {
            if (sib.nodeType === 1 && sib.nodeName === node.nodeName) index += 1;
            sib = sib.previousSibling;
          }
          parts.unshift(node.nodeName.toLowerCase() + '[' + index + ']');
          node = node.parentNode;
        }
        return '/html/' + parts.join('/');
      };
      return list.slice(0, 300).map((el, index) => ({
        index,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || '',
        inputType: el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text') : '',
        text: getText(el),
        id: el.id || '',
        name: el.getAttribute('name') || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        title: el.getAttribute('title') || '',
        placeholder: el.getAttribute('placeholder') || '',
        xpath: makeXPath(el),
        frameXPath: ''
      }));
    })()`;

    const result = await sendCdpCommand(tabId, 'Runtime.evaluate', {
      expression: script,
      returnByValue: true,
      awaitPromise: true
    });

    const elements = result?.result?.value || [];
    return { elements };
  } catch (e) {
    console.warn('[GhostGuide] CDP scan failed:', e.message);
    return { elements: [] };
  } finally {
    await detachDebugger(tabId);
  }
}

async function attachDebugger(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      const err = chrome.runtime.lastError;
      if (err) reject(err);
      else resolve();
    });
  });
}

async function detachDebugger(tabId) {
  return new Promise(resolve => {
    chrome.debugger.detach({ tabId }, () => resolve());
  });
}

async function sendCdpCommand(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, result => {
      const err = chrome.runtime.lastError;
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function formatElementLabel(el) {
  const text = (el.text || '').trim();
  const label = (
    text ||
    el.ariaLabel ||
    el.placeholder ||
    el.title ||
    el.name ||
    el.id ||
    el.tag ||
    'element'
  );
  return String(label).replace(/\s+/g, ' ').trim().slice(0, 80);
}

function getAxMatchInfo(label, axIndex) {
  if (!axIndex || !axIndex.labels) return { axMatch: false, axRole: '' };
  const normalized = normalizeLabel(label);
  if (!normalized || !axIndex.labels.has(normalized)) return { axMatch: false, axRole: '' };
  return { axMatch: true, axRole: axIndex.roles.get(normalized) || '' };
}

function buildElementSummary(elements, options = {}) {
  const limitGroups = Math.max(1, Number(options.limitGroups || 10));
  const limitExamples = Math.max(1, Number(options.limitExamples || 6));
  const preferred = Array.isArray(options.preferredTypes) ? options.preferredTypes : [];
  const axIndex = options.axIndex || null;
  const groups = new Map();

  for (const el of elements) {
    const type = classifyElement(el);
    const label = formatElementLabel(el);
    const axInfo = getAxMatchInfo(label, axIndex);
    const entry = groups.get(type) || { type, count: 0, examples: [] };
    entry.count += 1;
    if (entry.examples.length < limitExamples) {
      entry.examples.push({
        index: el.index,
        text: el.text || '',
        label,
        axMatch: axInfo.axMatch,
        axRole: axInfo.axRole,
        xpath: el.xpath || '',
        frameXPath: el.frameXPath || ''
      });
    }
    groups.set(type, entry);
  }

  const ordered = Array.from(groups.values()).sort((a, b) => {
    const aPref = preferred.indexOf(a.type);
    const bPref = preferred.indexOf(b.type);
    if (aPref !== -1 || bPref !== -1) {
      if (aPref === -1) return 1;
      if (bPref === -1) return -1;
      return aPref - bPref;
    }
    return b.count - a.count;
  });

  return ordered.slice(0, limitGroups);
}

function buildAvailableTargets(elements, options = {}) {
  const axIndex = options.axIndex || null;
  return elements
    .map(el => {
      const label = formatElementLabel(el);
      const axInfo = getAxMatchInfo(label, axIndex);
      return {
        index: el.index,
        label,
        type: classifyElement(el),
        text: el.text || '',
        axMatch: axInfo.axMatch,
        axRole: axInfo.axRole,
        xpath: el.xpath || '',
        frameXPath: el.frameXPath || ''
      };
    })
    .filter(entry => typeof entry.index === 'number' && (entry.label || entry.text));
}

function withTimeout(promise, ms, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function messagesToPrompt(messages) {
  return messages
    .filter(msg => msg.role !== 'system') // Filter out system messages since we handle them separately
    .map(msg => {
      const role = msg.role === 'assistant' ? 'ASSISTANT' : 'USER';
      return `${role}: ${msg.content}`;
    })
    .join('\n\n');
}

async function callProvider(config, messages) {
  const provider = config.provider || 'gemini';
  let model = config.modelName && config.modelName.trim() !== ''
    ? config.modelName.trim()
    : DEFAULT_MODELS[provider] || DEFAULT_MODELS.gemini;

  console.log(`[API] Provider: ${provider}, Model: ${model}, Messages: ${messages.length}`);

  if (provider === 'gemini') {
    if (!config.apiKey || config.apiKey.trim() === '') {
      throw new Error('Gemini API key is required');
    }

    // Ensure model name doesn't have extra spaces
    model = model.replace(/\s+/g, '');

    const apiKey = config.apiKey.trim();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    // Build simple Gemini request - combine all messages into single user prompt
    let fullPrompt = '';
    for (const msg of messages) {
      if (msg.role === 'system') {
        fullPrompt += msg.content + '\n\n';
      } else if (msg.role === 'user') {
        fullPrompt += 'USER: ' + msg.content + '\n\n';
      } else if (msg.role === 'assistant') {
        fullPrompt += 'ASSISTANT: ' + msg.content + '\n\n';
      }
    }

    const body = {
      contents: [{
        parts: [{ text: fullPrompt.trim() }]
      }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 1000
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
      ]
    };

    console.log(`[Gemini] Calling ${model} with prompt length: ${fullPrompt.length}`);

    try {
      console.log('[Gemini] Starting request...');
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }, AI_TIMEOUT_MS);

      console.log('[Gemini] Got response, status:', res.status);

      if (!res.ok) {
        const errorText = await res.text();
        console.error('[Gemini] HTTP', res.status, ':', errorText.slice(0, 300));

        let errorMsg = `HTTP ${res.status}`;
        try {
          const errorData = JSON.parse(errorText);
          errorMsg = errorData.error?.message || errorData.error?.status || errorMsg;
        } catch (e) {
          // If can't parse JSON, use raw text
          if (errorText.includes('API_KEY_INVALID') || errorText.includes('invalid')) {
            errorMsg = 'Invalid API key';
          } else if (errorText.includes('not found') || errorText.includes('404')) {
            errorMsg = `Model ${model} not found - leave model name blank`;
          } else if (errorText.includes('quota') || errorText.includes('429')) {
            errorMsg = 'Rate limit - wait 1 minute';
          } else {
            errorMsg = errorText.slice(0, 150);
          }
        }
        throw new Error(`Gemini error: ${errorMsg}`);
      }

      const data = await res.json();
      console.log('[Gemini] ✅ Response received');

      if (data.error) {
        throw new Error(`Gemini: ${data.error.message || JSON.stringify(data.error)}`);
      }

      if (data.promptFeedback?.blockReason) {
        throw new Error(`Gemini blocked: ${data.promptFeedback.blockReason}`);
      }

      const candidate = data?.candidates?.[0];
      if (!candidate) throw new Error('Gemini: No response generated');

      const text = candidate?.content?.parts?.[0]?.text;
      if (!text) throw new Error('Gemini: Empty response');

      console.log('[Gemini] ✅ Got response:', text.slice(0, 100));
      return text;

    } catch (error) {
      // Enhanced error handling
      if (error.message.includes('timeout')) {
        throw new Error('Gemini: Request timeout - check internet or try again');
      }
      if (error.message.includes('fetch')) {
        throw new Error('Gemini: Network error - check connection');
      }
      throw error;
    }
  }

  if (provider === 'anthropic') {
    if (!config.apiKey || config.apiKey.trim() === '') {
      throw new Error('Anthropic API key is required');
    }
    const url = 'https://api.anthropic.com/v1/messages';
    const system = messages.find(msg => msg.role === 'system')?.content || '';
    const filtered = messages.filter(msg => msg.role !== 'system').map(msg => ({ role: msg.role, content: msg.content }));
    const body = {
      model,
      max_tokens: 500,
      system,
      messages: filtered
    };
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    }, AI_TIMEOUT_MS);

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Anthropic: ${errorText}`);
    }

    const data = await res.json();
    if (data.error) throw new Error(`Anthropic: ${data.error.message || 'Unknown error'}`);
    const text = data?.content?.[0]?.text;
    if (!text) throw new Error('Anthropic returned no content');
    return text;
  }

  const openAiLikeProviders = ['openai', 'deepseek', 'openrouter', 'groq', 'custom'];
  if (openAiLikeProviders.includes(provider)) {
    if (!config.apiKey || config.apiKey.trim() === '') {
      throw new Error(`${provider} API key is required`);
    }

    const url = resolveOpenAiUrl(config);

    // For OpenRouter, ensure model is in correct format
    if (provider === 'openrouter' && model && !model.includes('/')) {
      console.warn(`[OpenRouter] Model "${model}" should include provider, e.g., "openai/gpt-4o-mini"`);
    }

    const body = {
      model,
      messages,
      max_tokens: 2000,
      temperature: 0.7
    };

    const headers = { 'Content-Type': 'application/json' };
    headers.Authorization = `Bearer ${config.apiKey}`;

    // OpenRouter needs HTTP-Referer header
    if (provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://github.com/ghostguide-extension';
      headers['X-Title'] = 'GhostGuide Extension';
    }

    console.log(`[${provider}] Calling: ${url} with model: ${model}`);

    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    }, AI_TIMEOUT_MS);

    console.log(`[${provider}] Got response, status:`, res.status);

    if (!res.ok) {
      const errorText = await res.text();
      console.error(`[${provider}] Error response:`, errorText);
      let errorMsg = 'API request failed';
      try {
        const errorData = JSON.parse(errorText);
        const rawMessage = errorData.error?.message || errorData.message || errorData.error || '';
        const errorCode = errorData.error?.code || errorData.code || '';
        errorMsg = rawMessage || errorMsg;

        const lowerMsg = String(errorMsg).toLowerCase();
        if (errorCode === 'rate_limit_exceeded' || lowerMsg.includes('rate limit') || lowerMsg.includes('rate_limit')) {
          errorMsg = 'Rate limit hit. Wait a bit and retry.';
        } else if (lowerMsg.includes('invalid') && lowerMsg.includes('key')) {
          errorMsg = 'Invalid API key';
        } else if (lowerMsg.includes('model') && !lowerMsg.includes('rate limit')) {
          errorMsg = `Model "${model}" not available. Check model name format.`;
        }
      } catch (e) {
        errorMsg = errorText.slice(0, 200);
      }
      throw new Error(`${provider}: ${errorMsg}`);
    }

    let data;
    try {
      data = await res.json();
    } catch (e) {
      console.error(`[${provider}] Failed to parse JSON response:`, e.message);
      throw new Error(`${provider}: Invalid response format`);
    }

    console.log(`[${provider}] Response received:`, JSON.stringify(data).slice(0, 150));

    // Check for API errors
    if (data.error) {
      const errMsg = typeof data.error === 'string' ? data.error : (data.error.message || 'Unknown error');
      const errCode = typeof data.error === 'object' ? data.error.code : '';
      const lowerMsg = String(errMsg).toLowerCase();
      if (errCode === 'rate_limit_exceeded' || lowerMsg.includes('rate limit') || lowerMsg.includes('rate_limit')) {
        throw new Error(`${provider}: Rate limit hit. Wait a bit and retry.`);
      }
      throw new Error(`${provider}: ${errMsg}`);
    }

    // Validate response structure
    if (!data.choices || !Array.isArray(data.choices)) {
      console.error(`[${provider}] Invalid response structure - no choices array:`, data);
      throw new Error(`${provider}: Invalid response structure`);
    }

    if (data.choices.length === 0) {
      console.error(`[${provider}] Response has empty choices array`);
      throw new Error(`${provider}: No choices in response`);
    }

    const choice = data.choices[0];
    const text = choice?.message?.content;

    if (!text || text.trim() === '') {
      console.error(`[${provider}] Empty content in response:`, choice);
      const err = new Error(`${provider}: Provider returned empty response (may be temporary)`);
      err.code = 'provider_empty_response';
      throw err;
    }

    console.log(`[${provider}] ✅ Got response (${text.length} chars)`);
    return text;
  }

  throw new Error('Unsupported provider');
}

function classifyProviderError(err) {
  const message = String(err?.message || 'Unknown error');
  const lower = message.toLowerCase();

  if (lower.includes('invalid api key') || (lower.includes('invalid') && lower.includes('key'))) {
    return { code: 'auth_invalid', message: 'Invalid API key. Check Settings and try again.' };
  }

  if (lower.includes('rate limit') || lower.includes('quota') || lower.includes('429')) {
    return { code: 'rate_limit', message: 'Rate limit hit. Wait a bit and retry.' };
  }

  if (lower.includes('model') && (lower.includes('not found') || lower.includes('not available'))) {
    return { code: 'model_not_found', message: 'Model not found. Check the model name or leave it blank.' };
  }

  if (lower.includes('timeout')) {
    return { code: 'timeout', message: 'Request timed out. Check your connection and retry.' };
  }

  if (lower.includes('network') || lower.includes('fetch')) {
    return { code: 'network', message: 'Network error. Check your internet connection.' };
  }

  return { code: 'unknown', message };
}

async function loadActionHistory() {
  const data = await storageGet([ACTION_HISTORY_KEY]);
  const history = data[ACTION_HISTORY_KEY];
  return Array.isArray(history) ? history : [];
}

async function setActionHistory(history) {
  const normalized = Array.isArray(history) ? history.slice(-HISTORY_LIMIT) : [];
  await storageSet({ [ACTION_HISTORY_KEY]: normalized });
  return normalized;
}

async function appendActionHistory(entry) {
  const history = await loadActionHistory();
  history.push(entry);
  const normalized = history.slice(-HISTORY_LIMIT);
  await storageSet({ [ACTION_HISTORY_KEY]: normalized });
  return normalized;
}

async function clearActionHistory() {
  await storageSet({ [ACTION_HISTORY_KEY]: [] });
}

async function loadSessions() {
  const data = await storageGet(['gg_sessions']);
  return Array.isArray(data.gg_sessions) ? data.gg_sessions : [];
}

async function saveSession(session) {
  const sessions = await loadSessions();
  const next = {
    id: session.id || `gg_${Date.now()}`,
    goal: session.goal || '',
    messages: Array.isArray(session.messages) ? session.messages : [],
    history: Array.isArray(session.history) ? session.history : [],
    createdAt: session.createdAt || Date.now(),
    updatedAt: Date.now()
  };

  const idx = sessions.findIndex(item => item.id === next.id);
  if (idx >= 0) {
    sessions[idx] = { ...sessions[idx], ...next, updatedAt: Date.now() };
  } else {
    sessions.unshift(next);
  }

  await storageSet({ gg_sessions: sessions.slice(0, 50) });
  return next;
}

async function loadSession(sessionId) {
  if (!sessionId) return null;
  const sessions = await loadSessions();
  return sessions.find(item => item.id === sessionId) || null;
}

async function deleteSession(sessionId) {
  if (!sessionId) return;
  const sessions = await loadSessions();
  const next = sessions.filter(item => item.id !== sessionId);
  await storageSet({ gg_sessions: next });
}

function resolveOpenAiUrl(config) {
  if (config.provider === 'openai') return 'https://api.openai.com/v1/chat/completions';
  if (config.provider === 'deepseek') return 'https://api.deepseek.com/chat/completions';
  if (config.provider === 'groq') return 'https://api.groq.com/openai/v1/chat/completions';
  if (config.provider === 'openrouter') return 'https://openrouter.ai/api/v1/chat/completions';

  const base = (config.baseUrl || '').replace(/\/$/, '');
  if (!base) return 'http://localhost:11434/v1/chat/completions';
  if (base.endsWith('/chat/completions')) return base;
  if (base.endsWith('/v1')) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, result => {
      const err = chrome.runtime.lastError;
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function storageSet(value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(value, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(err);
      else resolve();
    });
  });
}

function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    console.log(`[Fetch] Starting request to ${url.split('?')[0]} with ${timeoutMs}ms timeout`);

    const timeoutId = setTimeout(() => {
      console.error(`[Fetch] Timeout after ${timeoutMs}ms for ${url.split('?')[0]}`);
      reject(new Error(`Request timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    fetch(url, options)
      .then(response => {
        clearTimeout(timeoutId);
        console.log(`[Fetch] Got response (${response.status}) from ${url.split('?')[0]}`);
        resolve(response);
      })
      .catch(err => {
        clearTimeout(timeoutId);
        console.error(`[Fetch] Error from ${url.split('?')[0]}:`, err.message);
        reject(err);
      });
  });
}

function queryActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const err = chrome.runtime.lastError;
      if (err) reject(err);
      else resolve(tabs[0]);
    });
  });
}


function sendMessageToTab(tabId, message, options = {}) {
  return new Promise((resolve, reject) => {
    const sendOptions = { frameId: 0, ...options };
    chrome.tabs.sendMessage(tabId, message, sendOptions, response => {
      const err = chrome.runtime.lastError;
      if (err) reject(err);
      else resolve(response);
    });
  });
}

async function ensureContentScript(tabId) {
  try {
    await sendMessageToTab(tabId, { action: 'ping' }, { frameId: 0 });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}

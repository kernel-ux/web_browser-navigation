const INTERACTIVE_SELECTORS = [
    'button',
    'a',
    'input',
    'select',
    'textarea',
    'summary',
    'details',
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[role="tab"]',
    '[tabindex]:not([tabindex="-1"])'
].join(',');

const MAX_SCAN_DEPTH = 10;
const MAX_SCAN_ELEMENTS = 300;
const MAX_CONTENT_TEXT_CHARS = 1500;
const MAX_CONTENT_MARKDOWN_CHARS = 2000;

let elementsCache = [];
let lastHighlightTarget = null;
let lastHighlightMeta = null;
let highlightRaf = null;

function truncateText(text, maxChars) {
    if (!text) return '';
    const normalized = String(text).replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxChars) return normalized;
    return normalized.slice(0, maxChars - 3) + '...';
}

function extractReadableContent() {
    if (typeof Readability !== 'function') return null;
    try {
        const clone = document.cloneNode(true);
        const reader = new Readability(clone, { keepClasses: false });
        const article = reader.parse();
        if (!article) return null;

        let markdown = '';
        if (typeof TurndownService === 'function' && article.content) {
            const turndown = new TurndownService({ headingStyle: 'atx' });
            markdown = turndown.turndown(article.content);
        }

        return {
            title: article.title || document.title || '',
            byline: article.byline || '',
            excerpt: truncateText(article.excerpt || '', 240),
            text: truncateText(article.textContent || '', MAX_CONTENT_TEXT_CHARS),
            markdown: truncateText(markdown || '', MAX_CONTENT_MARKDOWN_CHARS)
        };
    } catch (e) {
        console.warn('[GhostGuide] Readability extract failed:', e.message);
        return null;
    }
}

class DOMScanner {
    getDeepDOM(root, depth = 0, maxDepth = MAX_SCAN_DEPTH) {
        if (!root || depth > maxDepth) return [];

        const elements = Array.from(root.querySelectorAll(INTERACTIVE_SELECTORS));
        const allElements = Array.from(root.querySelectorAll('*'));

        for (const el of allElements) {
            if (el.shadowRoot) {
                elements.push(...this.getDeepDOM(el.shadowRoot, depth + 1, maxDepth));
            }
        }

        return elements;
    }

    isVisible(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width < 5 || rect.height < 5) return false;
        const view = el.ownerDocument?.defaultView || window;
        const style = view.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        return true;
    }

    getElementInfo(el) {
        const text = this.getElementText(el);
        return {
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role') || '',
            inputType: el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text') : '',
            text,
            name: el.getAttribute('name') || '',
            ariaLabel: el.getAttribute('aria-label') || '',
            title: el.getAttribute('title') || '',
            placeholder: el.getAttribute('placeholder') || '',
            xpath: getXPath(el)
        };
    }

    getElementText(el) {
        let text = (
            el.innerText ||
            el.value ||
            el.placeholder ||
            el.getAttribute('aria-label') ||
            el.getAttribute('title') ||
            el.getAttribute('alt') ||
            ''
        ).trim();

        text = text.replace(/\s+/g, ' ');
        if (text.length > 80) text = text.slice(0, 77) + '...';
        return text;
    }
}

class IframeHandler {
    scanAccessibleIframes() {
        const accessible = [];
        const crossOrigin = [];
        const iframes = Array.from(document.querySelectorAll('iframe'));

        for (const iframe of iframes) {
            try {
                const doc = iframe.contentDocument;
                if (!doc) throw new Error('No iframe document');
                const frameXPath = getXPath(iframe);
                accessible.push({ doc, frameXPath });
            } catch {
                crossOrigin.push({
                    src: iframe.getAttribute('src') || '',
                    id: iframe.id || '',
                    name: iframe.getAttribute('name') || ''
                });
            }
        }

        return { accessible, crossOrigin };
    }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'ping') {
        sendResponse({ status: 'pong' });
        return false;
    }

    if (request.action === 'scan_context') {
        try {
            if (window.top !== window) {
                sendResponse({ skipped: true, reason: 'iframe' });
                return false;
            }

            const scanner = new DOMScanner();
            const iframeHandler = new IframeHandler();

            const elements = [];
            const cache = [];

            const mainElements = scanner.getDeepDOM(document);
            for (const el of mainElements) {
                if (elements.length >= MAX_SCAN_ELEMENTS) break;
                if (!scanner.isVisible(el)) continue;
                const info = scanner.getElementInfo(el);
                if (!info.text && !['input', 'select', 'textarea'].includes(info.tag)) continue;
                info.index = cache.length;
                elements.push(info);
                cache.push({
                    element: el,
                    xpath: info.xpath,
                    frameXPath: ''
                });
            }

            const iframeData = iframeHandler.scanAccessibleIframes();
            for (const frame of iframeData.accessible) {
                if (elements.length >= MAX_SCAN_ELEMENTS) break;
                const frameElements = scanner.getDeepDOM(frame.doc);
                for (const el of frameElements) {
                    if (elements.length >= MAX_SCAN_ELEMENTS) break;
                    if (!scanner.isVisible(el)) continue;
                    const info = scanner.getElementInfo(el);
                    if (!info.text && !['input', 'select', 'textarea'].includes(info.tag)) continue;
                    info.frameXPath = frame.frameXPath;
                    info.index = cache.length;
                    elements.push(info);
                    cache.push({
                        element: el,
                        xpath: info.xpath,
                        frameXPath: frame.frameXPath
                    });
                }
            }

            elementsCache = cache;

            const contentSummary = extractReadableContent();

            sendResponse({
                page: {
                    url: window.location.href,
                    title: document.title
                },
                elements,
                contentSummary,
                iframeSummary: {
                    crossOrigin: iframeData.crossOrigin,
                    accessibleCount: iframeData.accessible.length
                }
            });
        } catch (e) {
            console.error('[GhostGuide] Scan error:', e);
            sendResponse({ error: e.toString(), elements: [], iframeSummary: { crossOrigin: [], accessibleCount: 0 } });
        }
        return true;
    }

    if (request.action === 'visual_command') {
        const type = request.type || 'click';
        const label = request.text || type.toUpperCase();
        const typeValue = typeof request.value === 'string' ? request.value : '';
        const submitAfter = request.submitAfter === true;

        let target = null;

        if (typeof request.id === 'number' && request.id >= 0 && request.id < elementsCache.length) {
            target = elementsCache[request.id].element;
        } else if (request.xpath) {
            target = resolveByXPath(request.xpath, request.frameXPath);
        }

        if (!target) {
            sendResponse({ ok: false, reason: 'target_not_found' });
            return false;
        }

        if (!isVisibleTarget(target)) {
            sendResponse({ ok: false, reason: 'not_visible' });
            return false;
        }

        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        drawHighlight(target, getHighlightColor(type), label);
        if (type === 'type') {
            target.focus();
            if (typeValue) {
                applyTypeToTarget(target, typeValue);
            }

            // If submitAfter is true, press Enter to submit the form
            if (submitAfter) {
                const enterEvent = new KeyboardEvent('keydown', {
                    key: 'Enter',
                    code: 'Enter',
                    keyCode: 13,
                    which: 13,
                    bubbles: true,
                    cancelable: true
                });
                target.dispatchEvent(enterEvent);
                target.dispatchEvent(new KeyboardEvent('keyup', {
                    key: 'Enter',
                    code: 'Enter',
                    keyCode: 13,
                    which: 13,
                    bubbles: true,
                    cancelable: true
                }));
                console.log('[GhostGuide] Auto-submitted search field with Enter key');
            }
        }
        sendResponse({ ok: true });
        return false;
    }

    if (request.action === 'clear_highlight') {
        removeHighlightArtifacts(document);
        try {
            if (document.defaultView?.top?.document && document.defaultView.top.document !== document) {
                removeHighlightArtifacts(document.defaultView.top.document);
            }
        } catch {
            // ignore cross-origin access
        }
        const overlay = document.getElementById('ghostguide-overlay');
        if (overlay) overlay.remove();
        if (lastHighlightTarget) {
            restoreTargetHighlight(lastHighlightTarget);
            lastHighlightTarget = null;
        }
        sendResponse({ ok: true });
        return false;
    }

    if (request.action === 'find_search_input') {
        // Find and highlight a search input for visual navigation
        const searchRegex = /search/i;
        const iframeHandler = new IframeHandler();
        const searchTerm = typeof request.searchTerm === 'string' ? request.searchTerm.trim() : '';

        const isSearchCandidate = (el) => {
            if (!el || el.nodeType !== 1) return false;
            const tag = el.tagName.toLowerCase();
            const role = (el.getAttribute('role') || '').toLowerCase();
            if (role === 'searchbox') return true;
            if (tag !== 'input' && tag !== 'textarea') return false;
            const type = (el.getAttribute('type') || 'text').toLowerCase();
            if (type !== 'search' && type !== 'text') return false;
            const hay = [
                el.getAttribute('placeholder') || '',
                el.getAttribute('aria-label') || '',
                el.getAttribute('name') || '',
                el.getAttribute('id') || '',
                el.getAttribute('title') || ''
            ].join(' ');
            return type === 'search' || searchRegex.test(hay);
        };

        const collectSearchCandidates = (root, depth = 0) => {
            if (!root || depth > MAX_SCAN_DEPTH) return [];
            const list = Array.from(root.querySelectorAll('input, textarea, [role="searchbox"]'));
            const all = Array.from(root.querySelectorAll('*'));
            for (const el of all) {
                if (el.shadowRoot) {
                    list.push(...collectSearchCandidates(el.shadowRoot, depth + 1));
                }
            }
            return list;
        };

        const findSearchInRoot = (root) => {
            const candidates = collectSearchCandidates(root);
            for (const candidate of candidates) {
                if (!isSearchCandidate(candidate)) continue;
                const rect = candidate.getBoundingClientRect();
                if (rect.width > 0 || rect.height > 0) return candidate;
                return candidate;
            }
            return null;
        };

        let searchInput = findSearchInRoot(document);
        if (!searchInput) {
            const iframeData = iframeHandler.scanAccessibleIframes();
            for (const frame of iframeData.accessible) {
                searchInput = findSearchInRoot(frame.doc);
                if (searchInput) break;
            }
        }

        if (searchInput) {
            console.log('✅ Search input found, attempting to highlight...');
            try {
                searchInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
                setTimeout(() => {
                    searchInput.focus();
                    if (searchTerm) {
                        if (!searchInput.value) {
                            searchInput.value = searchTerm;
                        }
                        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
                        searchInput.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                    const label = searchTerm ? `Search: ${searchTerm}` : 'Type search query here';
                    drawHighlight(searchInput, '#2196F3', label);
                    sendResponse({ ok: true, found: true });
                }, 300);
            } catch (e) {
                console.log('❌ Could not highlight search input:', e.message);
                sendResponse({ ok: false, found: false });
            }
        } else {
            console.log('❌ Search input not found');
            sendResponse({ ok: false, found: false });
        }
        return true;
    }
});
function resolveByXPath(xpath, frameXPath) {
    try {
        if (frameXPath) {
            const frameEl = resolveXPathInDoc(document, frameXPath);
            if (!frameEl || !frameEl.contentDocument) return null;
            return resolveXPathInDoc(frameEl.contentDocument, xpath);
        }
        return resolveXPathInDoc(document, xpath);
    } catch {
        return null;
    }
}

function resolveXPathInDoc(doc, xpath) {
    const result = doc.evaluate(xpath, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    return result.singleNodeValue || null;
}


// Create or get highlight overlay container - this escapes all stacking contexts
function getHighlightOverlay() {
    let overlay = document.getElementById('ghostguide-overlay');
    if (!overlay) {
        const canUseDialog = typeof HTMLDialogElement !== 'undefined';
        if (canUseDialog) {
            overlay = document.createElement('dialog');
            overlay.id = 'ghostguide-overlay';
            overlay.style.cssText = `
                position: fixed;
                inset: 0;
                width: 100%;
                height: 100%;
                margin: 0;
                padding: 0;
                border: 0;
                background: transparent;
                pointer-events: none;
                z-index: 2147483647;
                isolation: isolate;
            `;

            const styleId = 'ghostguide-overlay-style';
            if (!document.getElementById(styleId)) {
                const style = document.createElement('style');
                style.id = styleId;
                style.textContent = `#ghostguide-overlay::backdrop { background: transparent; }`;
                document.documentElement.appendChild(style);
            }

            (document.documentElement || document.body).appendChild(overlay);
            try {
                overlay.showModal();
            } catch {
                overlay.setAttribute('open', '');
            }
            console.log('✅ Created highlight overlay (dialog top-layer)');
        } else {
            overlay = document.createElement('div');
            overlay.id = 'ghostguide-overlay';
            // Use highest possible z-index and isolation to create new stacking context on top
            overlay.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                pointer-events: none;
                z-index: 2147483647;
                isolation: isolate;
            `;
            (document.documentElement || document.body).appendChild(overlay);
            console.log('✅ Created highlight overlay');
        }
    }
    // Ensure overlay is last in DOM so it wins when z-index ties
    if (overlay.parentNode) {
        overlay.parentNode.appendChild(overlay);
    }
    return overlay;
}

function drawHighlight(target, color, labelText) {
    const doc = target.ownerDocument || document;
    removeHighlightArtifacts(doc);
    if (doc !== document) {
        removeHighlightArtifacts(document);
    }
    if (lastHighlightTarget && lastHighlightTarget !== target) {
        restoreTargetHighlight(lastHighlightTarget);
    }

    const inModal = isInModal(target) || hasTransformedAncestor(target);
    lastHighlightMeta = { target, color, labelText, inModal };
    if (inModal) {
        applyTargetHighlight(target, color);
        lastHighlightTarget = target;
    } else if (lastHighlightTarget) {
        restoreTargetHighlight(lastHighlightTarget);
        lastHighlightTarget = null;
    }

    // Get viewport-relative position (not affected by scrollbars)
    const rect = target.getBoundingClientRect();
    const viewW = Math.max(doc.documentElement.clientWidth, window.innerWidth || 0);
    const viewH = Math.max(doc.documentElement.clientHeight, window.innerHeight || 0);
    const oversized = rect.width > viewW * 1.5 || rect.height > viewH * 1.5;
    const offscreen = rect.bottom < 0 || rect.right < 0 || rect.top > viewH || rect.left > viewW;

    if (oversized || offscreen || rect.width <= 1 || rect.height <= 1) {
        if (lastHighlightTarget) {
            restoreTargetHighlight(lastHighlightTarget);
            lastHighlightTarget = null;
        }
        return;
    }

    if (!inModal) {
        const box = doc.createElement('div');
        box.id = 'ghost-box';

        Object.assign(box.style, {
            position: 'fixed',
            border: `4px solid ${color}`,
            boxShadow: `0 0 30px ${color}, 0 0 50px ${color}, inset 0 0 15px ${color}66`,
            backgroundColor: `${color}22`,
            borderRadius: '8px',
            zIndex: '2147483647',
            pointerEvents: 'none',
            width: Math.min(rect.width + 10, viewW - 8) + 'px',
            height: Math.min(rect.height + 10, viewH - 8) + 'px',
            top: (rect.top - 5) + 'px',
            left: (rect.left - 5) + 'px'
        });

        // Append to overlay instead of documentElement
        const overlay = getHighlightOverlay();
        overlay.appendChild(box);

        drawFloatingLabel(box, labelText, color, true);
    } else {
        drawFloatingLabel(target, labelText, color, false);
    }
}

function removeHighlightArtifacts(doc) {
    if (!doc) return;
    const oldBox = doc.getElementById('ghost-box');
    if (oldBox) oldBox.remove();
    const oldLabel = doc.getElementById('ghost-label');
    if (oldLabel) oldLabel.remove();
}

function isInModal(target) {
    if (!target || !target.closest) return false;
    return Boolean(
        target.closest('dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"], .modal, .popup, .overlay, .backdrop, .cdk-overlay-pane, .mat-dialog-container')
    );
}

function hasTransformedAncestor(target) {
    let el = target;
    while (el && el.nodeType === 1) {
        const view = el.ownerDocument?.defaultView || window;
        const style = view.getComputedStyle(el);
        if (style.transform && style.transform !== 'none') return true;
        if (style.filter && style.filter !== 'none') return true;
        if (style.perspective && style.perspective !== 'none') return true;
        el = el.parentElement;
    }
    return false;
}

function applyTargetHighlight(target, color) {
    if (!target || target.nodeType !== 1) return;
    if (!target.dataset) return;
    if (!target.dataset.ggPrevOutline) {
        target.dataset.ggPrevOutline = target.style.outline || '';
        target.dataset.ggPrevBoxShadow = target.style.boxShadow || '';
    }
    target.style.outline = `3px solid ${color}`;
    target.style.boxShadow = `0 0 16px ${color}`;
}

function restoreTargetHighlight(target) {
    if (!target || !target.dataset) return;
    if (target.dataset.ggPrevOutline !== undefined) {
        target.style.outline = target.dataset.ggPrevOutline;
        delete target.dataset.ggPrevOutline;
    }
    if (target.dataset.ggPrevBoxShadow !== undefined) {
        target.style.boxShadow = target.dataset.ggPrevBoxShadow;
        delete target.dataset.ggPrevBoxShadow;
    }
}

function drawFloatingLabel(parentOrTarget, text, color, isChild = false) {
    const doc = parentOrTarget.ownerDocument || document;
    let label = doc.getElementById('ghost-label');
    if (!label) {
        label = doc.createElement('div');
        label.id = 'ghost-label';
    }
    label.innerText = text;
    Object.assign(label.style, {
        position: isChild ? 'absolute' : 'fixed',
        background: color,
        color: '#fff',
        padding: '6px 12px',
        fontSize: '13px',
        fontWeight: 'bold',
        borderRadius: '4px',
        whiteSpace: 'nowrap',
        boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
        zIndex: '2147483647',
        fontFamily: 'Arial, sans-serif'
    });

    if (isChild) {
        label.style.bottom = '100%';
        label.style.left = '0';
        label.style.marginBottom = '5px';
        label.style.borderRadius = '4px 4px 4px 0';
        parentOrTarget.appendChild(label);
    } else {
        const rect = parentOrTarget.getBoundingClientRect();
        label.style.top = (rect.top - 35) + 'px';
        label.style.left = (rect.left) + 'px';
        doc.body.appendChild(label);
    }
}

function getHighlightColor(type) {
    if (type === 'type') return '#1e88e5';
    if (type === 'scroll') return '#f4b400';
    return '#0f9d58';
}

function applyTypeToTarget(target, value) {
    if (!target || target.nodeType !== 1) return;
    const tag = target.tagName.toLowerCase();
    const isInput = tag === 'input' || tag === 'textarea';
    const isEditable = Boolean(target.isContentEditable);

    if (isInput) {
        const setter = Object.getOwnPropertyDescriptor(target.__proto__, 'value')?.set;
        if (setter) {
            setter.call(target, value);
        } else {
            target.value = value;
        }
    } else if (isEditable) {
        target.innerText = value;
    } else {
        return;
    }

    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
}

function getXPath(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return `//*[@id=${escapeXPathValue(el.id)}]`;

    const parts = [];
    let current = el;

    while (current && current.nodeType === 1) {
        const tag = current.tagName.toLowerCase();
        const index = getSiblingIndex(current);
        parts.unshift(`${tag}[${index}]`);
        if (current === document.documentElement) break;
        current = current.parentNode;
    }

    return '/' + parts.join('/');
}

function getSiblingIndex(el) {
    let index = 1;
    let sibling = el.previousElementSibling;
    while (sibling) {
        if (sibling.tagName === el.tagName) index += 1;
        sibling = sibling.previousElementSibling;
    }
    return index;
}

function escapeXPathValue(value) {
    if (!value.includes('"')) return `"${value}"`;
    if (!value.includes("'")) return `'${value}'`;
    const parts = value.split('"').map(part => `"${part}"`);
    return `concat(${parts.join(', "\\"", ')})`;
}

function isVisibleTarget(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 5 || rect.height < 5) return false;
    const view = el.ownerDocument?.defaultView || window;
    const style = view.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    return true;
}

function scheduleHighlightRefresh() {
    if (!lastHighlightMeta || highlightRaf) return;
    highlightRaf = requestAnimationFrame(() => {
        highlightRaf = null;
        const meta = lastHighlightMeta;
        if (!meta || !meta.target || !meta.target.isConnected) return;
        drawHighlight(meta.target, meta.color, meta.labelText);
    });
}

window.addEventListener('scroll', scheduleHighlightRefresh, true);
window.addEventListener('resize', scheduleHighlightRefresh, true);
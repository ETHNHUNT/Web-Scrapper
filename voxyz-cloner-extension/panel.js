// ─── Config ───────────────────────────────────────────────────────────────────
const BASE_URL = 'https://www.voxyz.space';
const SETTLE_IDLE = 2500;   // ms of silence after last request
const MAX_WAIT = 30000;     // hard timeout per page
const CRAWL_DELAY = 1500;   // pause between page navigations

// ─── State ────────────────────────────────────────────────────────────────────
let captured = {
    requests: [],
    requestUrls: new Set(),
    pages: {},
    cookies: [],
    sse: [],   // #17: Store SSE messages
    storage: {}, // #26: Local/Session storage per URL
};
let isCapturing = false;
let isCrawling = false;
let cancelRequested = false;
let lastReqTime = Date.now();
let lastSaveTime = Date.now();
let crawlStats = {
    startTime: 0,
    times: [],
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const feed = document.getElementById('feed');
const pageList = document.getElementById('page-list');
const statusText = document.getElementById('status-text');
const statusbar = document.getElementById('statusbar');
const zipEstEl = document.getElementById('zip-est');
const progressBar = document.getElementById('progress-bar');
const progressContainer = document.getElementById('progress-container');

const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const btnCrawl = document.getElementById('btn-crawl');
const btnCancel = document.getElementById('btn-cancel');
const btnSnapshot = document.getElementById('btn-snapshot');
const btnDl = document.getElementById('btn-dl');
const btnClear = document.getElementById('btn-clear');

const chkFilter = document.getElementById('chk-filter');
const chkStealth = document.getElementById('chk-stealth');
const selDepth = document.getElementById('sel-depth');
const selUA = document.getElementById('sel-ua');

const counterEls = {
    total: document.getElementById('c-total'), html: document.getElementById('c-html'),
    css: document.getElementById('c-css'), js: document.getElementById('c-js'),
    json: document.getElementById('c-json'), img: document.getElementById('c-img'),
    font: document.getElementById('c-font'), pages: document.getElementById('c-pages'),
};
const counts = { total: 0, html: 0, css: 0, js: 0, json: 0, img: 0, font: 0, other: 0, pages: 0 };

// ─── Utils ────────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tryParseJSON = str => { try { return JSON.parse(str); } catch { return null; } };

/**
 * Safely send a message to the background service worker.
 * Chrome MV3 service workers can be suspended after ~30s idle.
 * We detect this, wait briefly to let Chrome revive the worker, then retry.
 */
async function safeMessage(msg, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (!isContextValid()) throw new Error('Extension context invalidated.');
        try {
            return await new Promise((resolve, reject) => {
                try {
                    chrome.runtime.sendMessage(msg, response => {
                        if (chrome.runtime.lastError) {
                            reject(new Error(chrome.runtime.lastError.message));
                        } else {
                            resolve(response);
                        }
                    });
                } catch (e) {
                    reject(e);
                }
            });
        } catch (e) {
            const msg_str = e.message || '';
            // Unrecoverable — context is gone entirely
            if (msg_str.includes('context invalidated') || msg_str.includes('Extension context')) {
                throw e; // bubble up immediately, no retry
            }
            // Could be a sleeping worker — wait and retry
            if (attempt < retries) {
                console.warn(`[Cloner] sendMessage failed (attempt ${attempt + 1}), retrying in 1s...`, e.message);
                await sleep(1000);
            } else {
                throw e;
            }
        }
    }
}

// Keep-alive: ping background every 20s so the MV3 service worker never sleeps during a crawl
let _keepAliveTimer = null;
function startKeepAlive() {
    if (_keepAliveTimer) return;
    _keepAliveTimer = setInterval(() => {
        if (!isContextValid()) { stopKeepAlive(); return; }
        try {
            chrome.runtime.sendMessage({ type: 'PING' }, () => void chrome.runtime.lastError);
        } catch (_) { stopKeepAlive(); }
    }, 20000);
    console.log('[Cloner] Keep-alive started');
}
function stopKeepAlive() {
    if (_keepAliveTimer) { clearInterval(_keepAliveTimer); _keepAliveTimer = null; }
    console.log('[Cloner] Keep-alive stopped');
}

async function fetchCookies(url) {
    try {
        const response = await safeMessage({ type: 'GET_COOKIES', url });
        return (response && response.cookies) ? response.cookies : [];
    } catch (e) {
        if (!(e.message || '').includes('context invalidated')) {
            console.warn('[Cloner] fetchCookies failed:', e.message);
        }
        return [];
    }
}

function classify(mime = '', url = '') {
    if (mime.includes('html')) return 'html';
    if (mime.includes('css')) return 'css';
    if (mime.includes('javascript') || mime.includes('ecmascript')) return 'js';
    if (mime.includes('json')) return 'json';
    if (mime.startsWith('image/')) return 'img';
    if (mime.includes('font') || /\.(woff2?|ttf|otf|eot)(\?|$)/i.test(url)) return 'font';
    return 'other';
}

function bumpCounter(type) {
    counts.total++;
    counts[type] = (counts[type] || 0) + 1;
    updateStatsUI();
}

function updateStatsUI() {
    counterEls.total.textContent = counts.total;
    ['html', 'css', 'js', 'json', 'img', 'font'].forEach(t => {
        if (counterEls[t]) counterEls[t].textContent = counts[t] || 0;
    });
    counterEls.pages.textContent = counts.pages || 0;
    updateZipEstimator();
}

function setStatus(msg, type = '') {
    statusText.textContent = msg;
    statusbar.className = 'statusbar' + (type ? ` ${type}` : '');
}

function addFeedRow(entry) {
    const type = classify(entry.mimeType, entry.url);
    const stCls = entry.status >= 400 ? 'st-err' : entry.status >= 300 ? 'st-redir' : 'st-ok';
    const size = entry.size > 0 ? formatBytes(entry.size) : '—';
    const lbl = type.toUpperCase();
    const row = document.createElement('div');
    row.className = 'feed-row';
    row.innerHTML = `
        <span class="badge b-${type}">${lbl}</span>
        <span class="st ${stCls}">${entry.status}</span>
        <span class="req-url" title="${entry.url}">${entry.url.replace(/^https?:\/\//, '')}</span>
        <span class="req-size">${size}</span>
    `;
    feed.appendChild(row);
    if (feed.scrollHeight - feed.scrollTop < 600) feed.scrollTop = feed.scrollHeight;
}

function addPageRow(page) {
    const row = document.createElement('div');
    row.className = 'page-row';
    const assetsCount = (page.stylesheets?.length || 0) + (page.scripts?.length || 0) + (page.images?.length || 0);
    row.innerHTML = `
        <span class="st st-ok">✓</span>
        <span class="page-url" title="${page.url}">${page.url.replace(BASE_URL, '') || '/'}</span>
        <span class="page-assets">${assetsCount} assets</span>
        <button class="btn-preview" title="Sandbox Preview">👁</button>
    `;
    row.querySelector('.btn-preview').addEventListener('click', () => previewPage(page.url));
    pageList.appendChild(row);
}

function previewPage(url) {
    const page = captured.pages[url];
    if (!page) return;
    const blob = new Blob([page.html], { type: 'text/html' });
    const blobUrl = URL.createObjectURL(blob);
    window.open(blobUrl, '_blank');
}

function formatBytes(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
}

// #14: Simple ZIP size estimator
function updateZipEstimator() {
    let size = 0;
    captured.requests.forEach(r => size += (r.size || 0));
    Object.values(captured.pages).forEach(p => size += (p.html?.length || 0));
    zipEstEl.textContent = `Est: ${formatBytes(size)}`;
}

// ─── Persistence (#6) ─────────────────────────────────────────────────────────
function isContextValid() {
    return typeof chrome !== 'undefined' && chrome.runtime && !!chrome.runtime.id;
}

async function saveToStorage() {
    if (!isContextValid()) return;
    if (Date.now() - lastSaveTime < 5000) return; // limit frequency

    const data = {
        requests: captured.requests,
        requestUrls: Array.from(captured.requestUrls),
        pages: captured.pages,
        storage: captured.storage,
        cookies: captured.cookies,
        counts
    };
    try {
        await chrome.storage.local.set({ 'voxyz_cloner_state': data });
        lastSaveTime = Date.now();
    } catch (e) {
        if (e.message.includes('context invalidated')) {
            console.warn('[Cloner] Extension context invalidated - stopping auto-save');
        } else {
            console.error('[Cloner] Storage error:', e);
        }
    }
}

async function loadFromStorage() {
    if (!isContextValid()) return;
    try {
        const res = await chrome.storage.local.get('voxyz_cloner_state');
        if (res.voxyz_cloner_state) {
            const data = res.voxyz_cloner_state;
            captured.requests = data.requests || [];
            captured.requestUrls = new Set(data.requestUrls || []);
            captured.pages = data.pages || {};
            Object.assign(counts, data.counts || {});

            // Rebuild UI
            feed.innerHTML = '';
            captured.requests.slice(-100).forEach(addFeedRow);
            pageList.innerHTML = '';
            Object.values(captured.pages).forEach(addPageRow);
            updateStatsUI();
            if (captured.requests.length > 0) btnDl.disabled = false;
            setStatus(`Loaded session: ${captured.requests.length} assets, ${Object.keys(captured.pages).length} pages`);
        }
    } catch (e) {
        if (!e.message.includes('context invalidated')) {
            console.error('[Cloner] Failed to load session:', e);
        }
    }
}

// ─── Network listener ─────────────────────────────────────────────────────────
function onRequestFinished(harEntry) {
    const req = harEntry.request;
    const res = harEntry.response;
    const url = req.url;

    // #7 Domain filter toggle
    if (chkFilter.checked && !url.includes(new URL(BASE_URL).hostname)) return;
    if (captured.requestUrls.has(url)) return;

    // #10 Stronger filter
    if (shouldSkipAsset(url)) return;

    captured.requestUrls.add(url);
    const entry = {
        url, method: req.method,
        status: res.status, mimeType: res.content.mimeType || '',
        size: res.content.size || 0,
        content: null, encoding: null,
    };

    harEntry.getContent((content, encoding) => {
        entry.content = content;
        entry.encoding = encoding;
        captured.requests.push(entry);
        lastReqTime = Date.now();
        bumpCounter(classify(entry.mimeType, url));
        addFeedRow(entry);
        saveToStorage();
    });
}

// ─── UI & Tabs ────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => {
        document.querySelectorAll('.tab, .pane').forEach(el => el.classList.remove('active'));
        t.classList.add('active');
        document.getElementById(t.dataset.pane).classList.add('active');
    });
});

function startCapture() {
    isCapturing = true;
    chrome.devtools.network.onRequestFinished.addListener(onRequestFinished);
    btnStart.disabled = true; btnStop.disabled = false;
    btnCrawl.disabled = false; btnDl.disabled = false;
    setStatus('🔴 Capturing… reload voxyz.space or Auto-Crawl', 'working');
}

function stopCapture() {
    isCapturing = false;
    chrome.devtools.network.onRequestFinished.removeListener(onRequestFinished);
    btnStart.disabled = false; btnStop.disabled = true;
    setStatus(`⏹ Stopped — ${captured.requests.length} unique assets captured`);
}

async function clearAll() {
    if (isCrawling) return;
    captured.requests = [];
    captured.requestUrls.clear();
    captured.pages = {};
    Object.keys(counts).forEach(k => counts[k] = 0);
    feed.innerHTML = '';
    pageList.innerHTML = '';
    updateStatsUI();
    btnDl.disabled = btnCrawl.disabled = true;
    await chrome.storage.local.remove('voxyz_cloner_state');
    setStatus('Cleared — press ▶ Start to begin');
}

btnStart.addEventListener('click', startCapture);
btnStop.addEventListener('click', stopCapture);
btnCrawl.addEventListener('click', autoCrawl);
btnSnapshot.addEventListener('click', takeManualSnapshot);
btnDl.addEventListener('click', downloadZip);
btnCancel.addEventListener('click', () => {
    cancelRequested = true;
    setStatus('🛑 Cancel requested...', 'working');
});
btnClear.addEventListener('click', clearAll);
selUA.addEventListener('change', () => {
    const ua = selUA.value;
    console.log('[Cloner] UA set to:', ua);
});

async function takeManualSnapshot() {
    setStatus('📸 Taking manual snapshot...', 'working');
    const state = await capturePageState();
    if (state) {
        captured.pages[state.url] = state;
        captured.storage[state.url] = state.storage;

        const cookies = await fetchCookies(state.url);
        if (cookies && cookies.length > 0) {
            const existingNames = new Set(captured.cookies.map(c => c.name));
            cookies.forEach(c => {
                if (!existingNames.has(c.name)) captured.cookies.push(c);
            });
        }

        addPageRow(state);
        updateStatsUI();
        saveToStorage();
        setStatus('✅ Snapshot captured!', 'done');
    } else {
        setStatus('❌ Snapshot failed', 'err');
    }
}

// ─── Stealth Scripts (#21, #33) ──────────────────────────────────────────────
function injectStealthScripts() {
    const script = `
        (function() {
            if (window._stealth_active) return;
            window._stealth_active = true;
            
            // #33: Adaptive Fingerprinting
            try {
                // Hide Webdriver
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                
                // Spoof Hardware
                Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => Math.floor(Math.random() * 8) + 4 });
                Object.defineProperty(navigator, 'deviceMemory', { get: () => [4, 8, 16][Math.floor(Math.random() * 3)] });
                
                // Spoof Plugins
                if (!navigator.plugins.length) {
                    const mockPlugins = [{ name: 'Chrome PDF Viewer' }, { name: 'Native Client' }];
                    Object.defineProperty(navigator, 'plugins', { get: () => mockPlugins });
                }
            } catch(e) {}

            // Mouse Jitter (#21)
            document.addEventListener('mousemove', (e) => {}, {passive: true});
            setInterval(() => {
                const x = Math.random() * window.innerWidth;
                const y = Math.random() * window.innerHeight;
                const event = new MouseEvent('mousemove', {
                    view: window, bubbles: true, cancelable: true, clientX: x, clientY: y
                });
                document.dispatchEvent(event);
            }, 3000 + Math.random() * 5000);

            console.log('[Cloner] Stealth & Fingerprinting Active');
        })();
    `;
    chrome.devtools.inspectedWindow.eval(script);
}

// ─── Auto-scroll (#3, #11, #20) ───────────────────────────────────────────────
function autoScrollPage() {
    const isStealth = chkStealth.checked;
    return new Promise(resolve => {
        chrome.devtools.inspectedWindow.eval('document.documentElement.scrollHeight', (totalHeight) => {
            if (!totalHeight || totalHeight < 400) { resolve(); return; }
            const stepPx = isStealth ? 600 : 800;
            const stepCount = Math.ceil(totalHeight / stepPx);

            const script = `
                (function() {
                    let i = 0;
                    const isStealth = ${isStealth};
                    const tick = () => {
                        let currentStep = i * ${stepPx};
                        if (isStealth) {
                            currentStep += (Math.random() - 0.5) * 200; // Jitter step
                        }
                        window.scrollTo(0, currentStep);
                        i++;
                        
                        if (i <= ${stepCount}) {
                            let wait = isStealth ? (200 + Math.random() * 300) : 250;
                            if (isStealth && Math.random() > 0.9) wait += 1500; // Occasional "reading" pause
                            setTimeout(tick, wait);
                        } else {
                            window.scrollTo(0, 0);
                            setTimeout(() => {}, 500); 
                        }
                    };
                    tick();
                })()
            `;
            const timeout = isStealth ? (stepCount * 500 + 3000) : (stepCount * 250 + 1000);
            chrome.devtools.inspectedWindow.eval(script, () => setTimeout(resolve, timeout));
        });
    });
}

// ─── Navigation (#4) ──────────────────────────────────────────────────────────
async function navigateTo(url) {
    return new Promise(resolve => {
        const tabId = chrome.devtools.inspectedWindow.tabId;
        chrome.runtime.sendMessage({ type: 'NAVIGATE', tabId, url }, () => {
            lastReqTime = Date.now();
            setTimeout(resolve, 800);
        });
    });
}

async function waitForSettle() {
    await sleep(2000);
    const start = Date.now();
    return new Promise(resolve => {
        const ticker = setInterval(() => {
            if (Date.now() - lastReqTime > SETTLE_IDLE || Date.now() - start > MAX_WAIT) {
                clearInterval(ticker);
                resolve();
            }
        }, 500);
    });
}

// ─── Auto-Crawl ───────────────────────────────────────────────────────────────
async function autoCrawl() {
    if (isCrawling || !isCapturing) return;

    isCrawling = true;
    cancelRequested = false;
    btnCrawl.disabled = true;
    btnCancel.disabled = false;
    btnDl.disabled = true;
    progressContainer.style.display = 'block';
    progressBar.style.width = '0%';
    crawlStats.startTime = Date.now();
    crawlStats.times = [];

    const queue = [{ url: BASE_URL, depth: 0, retry: 0 }]; // #8: track retry count
    const known = new Set([BASE_URL]);
    const crawled = new Set();
    const maxDepth = parseInt(selDepth.value);

    // #17: Start SSE Interception
    injectSSEInterceptor();
    if (chkStealth.checked) injectStealthScripts();

    // Keep background service worker alive for the duration of the crawl
    startKeepAlive();

    const maxWorkers = 3;
    let activeWorkers = 0;
    let contextLost = false; // Set true if extension context dies; stops all workers

    const worker = async () => {
        while (queue.length > 0 && !cancelRequested && !contextLost) {
            const task = queue.shift();
            if (crawled.has(task.url) && task.retry === 0) continue;

            activeWorkers++;
            const pageStart = Date.now();
            const label = task.url.replace(BASE_URL, '') || '/';

            try {
                setStatus(`🚀 Concurrent [${crawled.size + 1}/${crawled.size + queue.length + activeWorkers}] - ${label}`, 'working');

                const response = await safeMessage({ type: 'CRAWL_PAGE', url: task.url });

                if (response && response.status === 'ok') {
                    const state = response.data;
                    captured.pages[task.url] = state;
                    captured.storage[task.url] = state.storage;

                    const cookies = await fetchCookies(task.url);
                    if (cookies && cookies.length > 0) {
                        const existingNames = new Set(captured.cookies.map(c => c.name));
                        cookies.forEach(c => { if (!existingNames.has(c.name)) captured.cookies.push(c); });
                    }

                    crawled.add(task.url);
                    addPageRow(state);
                    updateStatsUI();

                    if (task.depth < maxDepth) {
                        for (const link of (state.internalLinks || [])) {
                            const clean = normaliseUrl(link);
                            if (clean && !known.has(clean)) {
                                known.add(clean);
                                queue.push({ url: clean, depth: task.depth + 1, retry: 0 });
                            }
                        }
                    }
                    crawlStats.times.push(Date.now() - pageStart);
                } else {
                    throw new Error(response?.message || 'Worker failure');
                }
            } catch (e) {
                const errMsg = e.message || '';
                // If the extension context itself died, stop all workers immediately
                if (errMsg.includes('context invalidated') || errMsg.includes('Extension context')) {
                    contextLost = true;
                    setStatus('⚠️ Extension reloaded — please re-open DevTools panel', 'err');
                    console.error('[Cloner] Extension context lost — aborting crawl.', e);
                } else {
                    console.error(`[Cloner] worker failed for ${task.url}:`, e);
                    // Only retry non-fatal errors, max 2 times
                    if (task.retry < 2) queue.push({ ...task, retry: task.retry + 1 });
                }
            } finally {
                activeWorkers--;
            }

            if (contextLost) break;

            // Randomized jitter between tasks
            await sleep(chkStealth.checked ? 500 + Math.random() * 1000 : 200);

            // Progress UI update
            const progress = Math.round((crawled.size / (crawled.size + queue.length + activeWorkers)) * 100);
            progressBar.style.width = `${progress}%`;
        }
    };

    // Start workers
    const workers = Array(maxWorkers).fill(null).map(() => worker());
    await Promise.all(workers);

    stopKeepAlive();
    isCrawling = false;
    btnCrawl.disabled = false;
    btnCancel.disabled = true;
    btnDl.disabled = Object.keys(captured.pages).length === 0;
    progressContainer.style.display = 'none';

    if (!contextLost) {
        try {
            await safeMessage({ type: 'NOTIFY', title: 'Crawl Complete', message: `Captured ${crawled.size} pages.` });
        } catch (_) { /* background may be gone after a very long crawl — that's fine */ }
        setStatus(cancelRequested ? `⏹ Cancelled - ${crawled.size} pages.` : `✅ Done - ${crawled.size} pages.`, cancelRequested ? 'working' : 'done');
    }
}

function calculateETA(done, total) {
    if (done === 0 || crawlStats.times.length === 0) return 'estimating...';
    const avg = crawlStats.times.reduce((a, b) => a + b, 0) / crawlStats.times.length;
    const remaining = total - done;
    const ms = remaining * (avg + CRAWL_DELAY);
    const mins = Math.floor(ms / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    return `${mins}m ${secs}s`;
}

// ─── Page Capture Logic (#23, #26, #28) ──────────────────────────────────────
function capturePageState() {
    return new Promise(resolve => {
        const script = `(function() {
            const serializeWithShadowDOM = (root) => {
                const serializeNode = (node) => {
                    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
                    if (node.nodeType === Node.COMMENT_NODE) return '<!--' + node.textContent + '-->';
                    if (node.nodeType !== Node.ELEMENT_NODE) return "";

                    // #28: Canvas to Image serialization
                    if (node.tagName.toLowerCase() === 'canvas') {
                        try {
                            const dataUrl = node.toDataURL('image/png');
                            return '<img src="' + dataUrl + '" style="' + node.style.cssText + '" class="' + node.className + '" data-voxyz-canvas="true">';
                        } catch (e) {
                            return '<!-- canvas capture failed -->';
                        }
                    }

                    let str = "<" + node.tagName.toLowerCase();
                    Array.from(node.attributes).forEach(attr => {
                        str += " " + attr.name + '="' + attr.value.replace(/"/g, '&quot;') + '"';
                    });
                    str += ">";

                    if (node.shadowRoot) {
                        str += '<template shadowrootmode="' + node.shadowRoot.mode + '">';
                        str += Array.from(node.shadowRoot.childNodes).map(serializeNode).join("");
                        str += "</template>";
                    }

                    if (!["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"].includes(node.tagName.toLowerCase())) {
                        str += Array.from(node.childNodes).map(serializeNode).join("");
                        str += "</" + node.tagName.toLowerCase() + ">";
                    }
                    return str;
                };

                const getDeepHTML = (el) => {
                    let opening = "<html";
                    Array.from(el.attributes).forEach(a => opening += ' ' + a.name + '="' + a.value.replace(/"/g, '&quot;') + '"');
                    opening += ">";
                    return opening + Array.from(el.childNodes).map(serializeNode).join("") + "</html>";
                };

                return getDeepHTML(document.documentElement);
            };

            // #26: Storage Snapshotting
            const getStorage = () => {
                const res = { local: {}, session: {} };
                try {
                    for(let i=0; i<localStorage.length; i++) {
                        const k = localStorage.key(i);
                        res.local[k] = localStorage.getItem(k);
                    }
                    for(let i=0; i<sessionStorage.length; i++) {
                        const k = sessionStorage.key(i);
                        res.session[k] = sessionStorage.getItem(k);
                    }
                } catch(e) {}
                return res;
            };

            return {
                url: window.location.href,
                title: document.title,
                html: serializeWithShadowDOM(document.documentElement),
                storage: getStorage(),
                inlineStyles: Array.from(document.querySelectorAll('style')).map(s => s.textContent || ''),
                internalLinks: Array.from(document.querySelectorAll('a[href]'))
                    .map(a => a.href)
                    .filter(h => h.startsWith(window.location.origin))
            };
        })()`;
        chrome.devtools.inspectedWindow.eval(script, (result, err) => {
            if (err) resolve(null);
            else resolve(result);
        });
    });
}

function normaliseUrl(url) {
    try {
        const u = new URL(url);
        u.hash = ''; // Remove fragments #10
        return u.origin + u.pathname.replace(/\/$/, ''); // Remove trailing slashes
    } catch { return null; }
}

function shouldSkipAsset(url) {
    return /\.(pdf|zip|exe|dmg|mp4|mp3)(\?|$)/i.test(url) ||
        url.includes('google-analytics') ||
        url.includes('tel:') || url.includes('mailto:');
}

// ─── #17: SSE Interception Logic ──────────────────────────────────────────────
async function injectSSEInterceptor() {
    // We inject a script that wraps EventSource to capture messages
    const script = `
        (function() {
            if (window._sse_interceptor_active) return;
            window._sse_interceptor_active = true;
            const RealEventSource = window.EventSource;
            window.EventSource = function(url, options) {
                const es = new RealEventSource(url, options);
                console.log('[Cloner] Intercepted SSE:', url);
                es.addEventListener('message', (e) => {
                    const msg = {
                        url: url,
                        data: e.data,
                        type: e.type,
                        timestamp: Date.now()
                    };
                    // Store locally in the page, we'll poll it
                    window._captured_sse = window._captured_sse || [];
                    window._captured_sse.push(msg);
                });
                return es;
            };
        })();
    `;
    if (isContextValid()) chrome.devtools.inspectedWindow.eval(script);

    // Set up polling in the extension panel — guard against context invalidation
    const poll = async () => {
        if (!isCrawling || !isContextValid()) return;
        try {
            chrome.devtools.inspectedWindow.eval('window._captured_sse; window._captured_sse = [];', (result) => {
                if (chrome.runtime.lastError) return; // context gone
                if (result && Array.isArray(result) && result.length > 0) {
                    captured.sse.push(...result);
                }
                setTimeout(poll, 2000);
            });
        } catch (_) { /* context gone */ }
    };
    poll();
}

// ─── Phase 4 SOTA: ZIP Assembly ──────────────────────────────────────────────
async function downloadZip() {
    btnDl.disabled = true;
    setStatus('📦 Assembling SOTA ZIP...', 'working');

    const zip = new JSZip();
    const assetMap = {};
    const apiMap = {}; // #24: API responses
    const R = captured.requests;

    // #25 Structural Refresh: Map assets to new folders
    R.forEach(r => {
        const type = classify(r.mimeType, r.url);

        // If it's JSON/API, save for mocking
        if (type === 'json' || r.mimeType.includes('application/json')) {
            const dataPath = `assets/data/${urlToFilename(r.url, 'json')}`;
            assetMap[r.url] = dataPath;
            if (r.content) apiMap[r.url] = r.content; // Store for mock-api-data.json
            return;
        }

        const folder = {
            html: 'pages', // Move HTML to pages/
            css: 'assets/css',
            js: 'assets/js',
            img: 'assets/images',
            font: 'assets/fonts'
        }[type] || 'assets/misc';

        const ext = extFromUrl(r.url) || extFromMime(r.mimeType) || (type === 'js' ? 'js' : type === 'css' ? 'css' : 'bin');
        assetMap[r.url] = `${folder}/${urlToFilename(r.url, ext)}`;
    });

    // Write Mock Handler (#24)
    zip.file('assets/js/_voxyz_mock_handler.js', generateMockHandlerScript());
    zip.file('assets/data/mock-api-data.json', JSON.stringify(apiMap, null, 2));

    // Write Combined Styles
    const allStyles = new Set();
    Object.values(captured.pages).forEach(p => p.inlineStyles?.forEach(s => allStyles.add(s.trim())));
    zip.file('assets/css/_inline-styles-combined.css', [...allStyles].join('\n\n/* next block */\n\n'));

    // Write Pages (#23, #24, #25)
    const urlsToReplace = Object.keys(assetMap).sort((a, b) => b.length - a.length); // Longest first to avoid partial matches
    const replacementRegex = urlsToReplace.length > 0
        ? new RegExp(urlsToReplace.map(u => u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
        : null;

    const pageEntries = Object.entries(captured.pages);
    for (let i = 0; i < pageEntries.length; i++) {
        const [url, state] = pageEntries[i];
        let html = state.html;

        setStatus(`📝 Processing page ${i + 1}/${pageEntries.length}...`, 'working');

        // Asset rewriting using fast regex
        if (replacementRegex) {
            html = html.replace(replacementRegex, (match) => {
                const local = assetMap[match];
                return local.startsWith('pages/') ? local.replace('pages/', '') : '../' + local;
            });
        }

        // Mock Injection & Styles
        html = injectSOTAMetadata(html);

        const slug = urlToPageSlug(url);
        zip.file(`pages/${slug}.html`, html);

        // UI Break every 2 pages to prevent hang
        if (i % 2 === 0) await new Promise(r => setTimeout(r, 0));
    }

    // Root Redirector (#25)
    const entrySlug = urlToPageSlug(BASE_URL);
    zip.file('index.html', `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0; url=pages/${entrySlug}.html"></head></html>`);

    // Write Assets & Deep CSS Rewriting (#27)
    for (let i = 0; i < R.length; i++) {
        const r = R[i];
        if (!r.content) continue;
        const type = classify(r.mimeType, r.url);
        let content = r.content;
        let isBase64 = r.encoding === 'base64';

        // #27: Deep CSS Asset Rewriting
        if (type === 'css' && replacementRegex) {
            let cssText = isBase64 ? atob(content) : content;
            cssText = cssText.replace(replacementRegex, (match) => {
                const local = assetMap[match];
                return local.replace('assets/', '../');
            });
            content = cssText;
            isBase64 = false;
        }

        const options = isBase64 ? { base64: true } : {};
        zip.file(assetMap[r.url], content, options);

        if (i % 20 === 0) await new Promise(r => setTimeout(r, 0));
    }

    // #26: Write Storage & Cookies
    zip.file('network/storage_and_state.json', JSON.stringify({
        storage: captured.storage,
        cookies: captured.cookies,
        timestamp: new Date().toISOString()
    }, null, 2));

    // #30: Sitemaps & Robots
    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${Object.keys(captured.pages).map(url => `  <url><loc>${url}</loc></url>`).join('\n')}
</urlset>`;
    zip.file('sitemap.xml', sitemap);
    zip.file('robots.txt', "User-agent: *\nDisallow:\n\nSitemap: sitemap.xml");

    // Write SSE log
    if (captured.sse && captured.sse.length > 0) {
        zip.file('network/sse-messages.json', JSON.stringify(captured.sse, null, 2));
    }

    // Final meta
    zip.file('__manifest.json', JSON.stringify({
        date: new Date().toISOString(),
        voxyz_cloner_version: '2.5.0-SOTA',
        pages: Object.keys(captured.pages).length,
        assets: R.length,
        api_mocks: Object.keys(apiMap).length,
        has_shadow_dom: true,
        has_canvas_captures: true
    }, null, 2));

    const ts = new Date().getTime();
    zip.generateAsync({ type: 'blob' }, metadata => {
        setStatus(`🗜 Compressing ${metadata.percent.toFixed(0)}%`, 'working');
    }).then(blob => {
        const url = URL.createObjectURL(blob);
        chrome.downloads.download({ url, filename: `voxyz_full_sota_${ts}.zip`, saveAs: true });
        setStatus('✅ Full SOTA Clone ready!', 'done');
        btnDl.disabled = false;
    });
}

function injectSOTAMetadata(html) {
    const stylesLink = '\n  <link rel="stylesheet" href="../assets/css/_inline-styles-combined.css">';
    const mockScript = '\n  <script src="../assets/js/_voxyz_mock_handler.js"></script>';

    let clean = html.replace(/<script\b[^>]*src="[^"]*(analytics|googletagmanager|hubspot)[^"]*"[^>]*><\/script>/gi, '<!-- removed analytics -->');

    // Inject Mock Script first so it catches early fetches
    clean = clean.replace(/<head>/i, `<head>${mockScript}`);
    return clean.replace(/<\/head>/i, `${stylesLink}\n</head>`);
}

function generateMockHandlerScript() {
    return `
/**
 * VoxYZ Cloner SOTA Mock Handler
 * Intercepts fetch and XHR to serve local captured data
 */
(function() {
    console.log('[Cloner] API Mock Handler Active');
    let mockData = null;

    async function loadMockData() {
        if (mockData) return;
        try {
            const resp = await fetch('../assets/data/mock-api-data.json');
            mockData = await resp.json();
            console.log('[Cloner] Loaded ' + Object.keys(mockData).length + ' mock endpoints');
        } catch (e) {
            console.error('[Cloner] Failed to load mock data:', e);
            mockData = {};
        }
    }

    // Monkey-patch fetch
    const originalFetch = window.fetch;
    window.fetch = async function(resource, init) {
        if (!mockData) await loadMockData();
        
        const url = (typeof resource === 'string') ? resource : resource.url;
        const cleanUrl = url.split('?')[0].split('#')[0];

        // Match exact or contains
        const match = Object.keys(mockData).find(m => m === url || m === cleanUrl || url.includes(m));

        if (match) {
            console.log('[Cloner Mock] Intercepted Fetch:', url);
            return new Response(mockData[match], {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        return originalFetch(resource, init);
    };

    // Monkey-patch XHR
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        this._url = url;
        return originalOpen.apply(this, arguments);
    };

    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function() {
        if (!mockData) {
            loadMockData().then(() => this.send.apply(this, arguments));
            return;
        }

        const match = Object.keys(mockData).find(m => m === this._url || this._url.includes(m));
        if (match) {
            console.log('[Cloner Mock] Intercepted XHR:', this._url);
            Object.defineProperty(this, 'status', { value: 200 });
            Object.defineProperty(this, 'responseText', { value: mockData[match] });
            Object.defineProperty(this, 'readyState', { value: 4 });
            this.dispatchEvent(new Event('load'));
            return;
        }
        return originalSend.apply(this, arguments);
    };

    loadMockData();
})();
`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function urlToFilename(url, fallbackExt) {
    try {
        const name = new URL(url).pathname.split('/').pop() || 'index';
        const hash = Math.random().toString(36).substring(7);
        return `${name.replace(/[^\w.-]/g, '_')}_${hash}.${fallbackExt}`;
    } catch { return `file_${Math.random().toString(36).substring(7)}.${fallbackExt}`; }
}

function urlToPageSlug(url) {
    try {
        return new URL(url).pathname.replace(/^\/|\/$/g, '').replace(/\//g, '__') || 'index';
    } catch { return 'page_' + Math.random().toString(36).substring(7); }
}

function extFromUrl(url) {
    try { return new URL(url).pathname.split('.').pop().split('?')[0].toLowerCase(); } catch { return null; }
}

function extFromMime(mime) {
    const map = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'font/woff2': 'woff2' };
    return map[mime] || null;
}

// Load previous session on startup
loadFromStorage();

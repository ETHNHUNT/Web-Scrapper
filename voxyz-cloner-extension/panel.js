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
    sse: [], // #17: Store SSE messages
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
const btnDl = document.getElementById('btn-dl');
const btnClear = document.getElementById('btn-clear');

const chkFilter = document.getElementById('chk-filter');
const chkStealth = document.getElementById('chk-stealth');
const selDepth = document.getElementById('sel-depth');

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
    `;
    pageList.appendChild(row);
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
async function saveToStorage() {
    if (Date.now() - lastSaveTime < 5000) return; // limit frequency
    const data = {
        requests: captured.requests,
        requestUrls: Array.from(captured.requestUrls),
        pages: captured.pages,
        counts
    };
    try {
        await chrome.storage.local.set({ 'voxyz_cloner_state': data });
        lastSaveTime = Date.now();
    } catch (e) {
        console.warn('[Cloner] Storage quota might be hit', e);
    }
}

async function loadFromStorage() {
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
btnClear.addEventListener('click', clearAll);
btnCrawl.addEventListener('click', autoCrawl);
btnCancel.addEventListener('click', () => {
    cancelRequested = true;
    setStatus('🛑 Cancel requested...', 'working');
});
btnDl.addEventListener('click', downloadZip);

// ─── Stealth Scripts (#21) ───────────────────────────────────────────────────
function injectStealthScripts() {
    const script = `
        (function() {
            if (window._stealth_active) return;
            window._stealth_active = true;
            
            // Mouse Jitter
            document.addEventListener('mousemove', (e) => {}, {passive: true});
            setInterval(() => {
                const x = Math.random() * window.innerWidth;
                const y = Math.random() * window.innerHeight;
                const event = new MouseEvent('mousemove', {
                    view: window,
                    bubbles: true,
                    cancelable: true,
                    clientX: x,
                    clientY: y
                });
                document.dispatchEvent(event);
            }, 3000 + Math.random() * 5000);

            console.log('[Cloner] Stealth scripts active');
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
                    const isStealth = \${isStealth};
                    const tick = () => {
                        let currentStep = i * \${stepPx};
                        if (isStealth) {
                            currentStep += (Math.random() - 0.5) * 200; // Jitter step
                        }
                        window.scrollTo(0, currentStep);
                        i++;
                        
                        if (i <= \${stepCount}) {
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

    while (queue.length > 0) {
        if (cancelRequested) break;

        const { url, depth, retry } = queue.shift();
        if (crawled.has(url) && retry === 0) continue;

        const label = url.replace(BASE_URL, '') || '/';
        const progress = Math.round((crawled.size / (crawled.size + queue.length + 1)) * 100);

        // #9: Progress & ETA
        const eta = calculateETA(crawled.size, crawled.size + queue.length + 1);
        progressBar.style.width = `${progress}%`;
        setStatus(`🕷 [${crawled.size + 1}/${crawled.size + queue.length + 1}] ${progress}% - ETA: ${eta} - ${label}`, 'working');

        const pageStart = Date.now();
        try {
            await navigateTo(url);
            await waitForSettle();
            await autoScrollPage();

            const state = await capturePageState();
            if (!state || !state.html) throw new Error('Capture failed');

            captured.pages[url] = state;
            crawled.add(url);
            counts.pages = Object.keys(captured.pages).length;
            addPageRow(state);
            updateStatsUI();

            if (depth < maxDepth) {
                for (const link of (state.internalLinks || [])) {
                    const clean = normaliseUrl(link);
                    if (clean && !known.has(clean)) {
                        known.add(clean);
                        queue.push({ url: clean, depth: depth + 1, retry: 0 });
                    }
                }
            }
            crawlStats.times.push(Date.now() - pageStart);
        } catch (e) {
            console.error(`[Cloner] Failed page ${url}:`, e);
            if (retry < 3) {
                console.warn(`[Cloner] Retrying ${url} (${retry + 1}/3)`);
                queue.push({ url, depth, retry: retry + 1 });
                setStatus(`🔄 Retrying [${retry + 1}/3] ${label}...`, 'working');
                await sleep(2000);
            } else {
                crawled.add(url); // Mark as attempted
                setStatus(`❌ Failed ${label} after 3 retries`, 'error');
                await sleep(1000);
            }
        }

        // #19: Randomized Delay (Jitter)
        let delay = CRAWL_DELAY;
        if (chkStealth.checked) {
            delay = CRAWL_DELAY * (0.8 + Math.random() * 0.7); // 80% to 150%
            if (Math.random() > 0.8) delay += 2000; // Occasional long pause
        }
        await sleep(delay);
    }

    isCrawling = false;
    btnCrawl.disabled = false;
    btnCancel.disabled = true;
    btnDl.disabled = Object.keys(captured.pages).length === 0;
    progressContainer.style.display = 'none';

    chrome.runtime.sendMessage({ type: 'NOTIFY', title: 'Crawl Complete', message: `Captured ${crawled.size} pages.` });
    setStatus(cancelRequested ? `⏹ Cancelled - ${crawled.size} pages.` : `✅ Done - ${crawled.size} pages.`, cancelRequested ? 'working' : 'done');
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

// ─── Page Capture Logic ───────────────────────────────────────────────────────
function capturePageState() {
    return new Promise(resolve => {
        const script = `(function() {
            const safe = f => { try { return f(); } catch { return null; } };
            return {
                url: window.location.href,
                title: document.title,
                html: document.documentElement.outerHTML,
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
    chrome.devtools.inspectedWindow.eval(script);

    // Set up polling in the extension panel
    const poll = async () => {
        if (!isCrawling) return;
        chrome.devtools.inspectedWindow.eval('window._captured_sse; window._captured_sse = [];', (result) => {
            if (result && Array.isArray(result) && result.length > 0) {
                captured.sse.push(...result);
            }
            setTimeout(poll, 2000);
        });
    };
    poll();
}

// ─── Styles & Save (#1, #16) ──────────────────────────────────────────────────
function injectInlineStylesLink(html) {
    const linkTag = '\n  <link rel="stylesheet" href="../assets/css/_inline-styles-combined.css">';
    // #16: Also clean up script tags for analytics
    let clean = html.replace(/<script\b[^>]*src="[^"]*(analytics|googletagmanager|hubspot)[^"]*"[^>]*><\/script>/gi, '<!-- removed analytics -->');
    return clean.replace(/<\/head>/i, `${linkTag}\n</head>`);
}

async function downloadZip() {
    btnDl.disabled = true;
    setStatus('📦 Assembling ZIP...', 'working');

    const zip = new JSZip();
    const assetMap = {};
    const R = captured.requests;

    // Build unique asset map
    R.forEach(r => {
        const type = classify(r.mimeType, r.url);
        const folder = { html: 'dom', css: 'assets/css', js: 'assets/js', img: 'assets/images', font: 'assets/fonts' }[type] || 'assets/misc';
        const ext = extFromUrl(r.url) || extFromMime(r.mimeType) || (type === 'js' ? 'js' : type === 'css' ? 'css' : 'bin');
        assetMap[r.url] = `${folder}/${urlToFilename(r.url, ext)}`;
    });

    // Write Combined Styles
    const allStyles = new Set();
    Object.values(captured.pages).forEach(p => p.inlineStyles?.forEach(s => allStyles.add(s.trim())));
    zip.file('assets/css/_inline-styles-combined.css', [...allStyles].join('\n\n/* next block */\n\n'));

    // Write Pages
    for (const [url, state] of Object.entries(captured.pages)) {
        let html = state.html;
        // Asset rewriting
        for (const [orig, local] of Object.entries(assetMap)) {
            html = html.split(orig).join('../' + local);
        }
        html = injectInlineStylesLink(html);
        const slug = urlToPageSlug(url);
        zip.file(`dom/${slug}.html`, html);
    }

    // Write Assets
    R.forEach(r => {
        if (!r.content) return;
        const options = r.encoding === 'base64' ? { base64: true } : {};
        zip.file(assetMap[r.url], r.content, options);
    });

    // Write SSE log
    if (captured.sse.length > 0) {
        zip.file('network/sse-messages.json', JSON.stringify(captured.sse, null, 2));
    }

    // Final meta
    zip.file('__manifest.json', JSON.stringify({
        date: new Date().toISOString(),
        pages: Object.keys(captured.pages).length,
        assets: R.length
    }, null, 2));

    const ts = new Date().getTime();
    zip.generateAsync({ type: 'blob' }, metadata => {
        setStatus(`🗜 Compressing ${metadata.percent.toFixed(0)}%`, 'working');
    }).then(blob => {
        const url = URL.createObjectURL(blob);
        chrome.downloads.download({ url, filename: `voxyz_clone_${ts}.zip`, saveAs: true });
        setStatus('✅ Download started', 'done');
        btnDl.disabled = false;
    });
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

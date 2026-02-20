// ─── Config ───────────────────────────────────────────────────────────────────
const BASE_URL = 'https://www.voxyz.space';
const SETTLE_IDLE = 2500;   // ms of silence after last request = page settled
const MAX_WAIT = 25000;  // hard timeout per page (full reload needs more time)
const CRAWL_DELAY = 1200;   // pause between page navigations

// ─── State ────────────────────────────────────────────────────────────────────
const captured = {
    requests: [],
    requestUrls: new Set(),
    pages: {},
    cookies: [],
};
let isCapturing = false;
let isCrawling = false;
let cancelRequested = false;    // Fix #2: flag checked every loop iteration
let lastReqTime = Date.now();

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const feed = document.getElementById('feed');
const statusbar = document.getElementById('statusbar');
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const btnCrawl = document.getElementById('btn-crawl');
const btnCancel = document.getElementById('btn-cancel');  // Fix #2
const btnDl = document.getElementById('btn-dl');
const btnClear = document.getElementById('btn-clear');
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
    counterEls.total.textContent = counts.total;
    if (counterEls[type]) counterEls[type].textContent = counts[type];
}

function setStatus(msg, type = '') {
    statusbar.textContent = msg;
    statusbar.className = 'statusbar' + (type ? ` ${type}` : '');
}

function addFeedRow(entry) {
    const type = classify(entry.mimeType, entry.url);
    const stCls = entry.status >= 400 ? 'st-err' : entry.status >= 300 ? 'st-redir' : 'st-ok';
    const size = entry.size > 0 ? formatBytes(entry.size) : '—';
    const lbl = { html: 'HTML', css: 'CSS', js: 'JS', json: 'JSON', img: 'IMG', font: 'FONT', other: '…' }[type];
    const row = document.createElement('div');
    row.className = 'feed-row';
    row.innerHTML = `
    <span class="badge b-${type}">${lbl}</span>
    <span class="st ${stCls}">${entry.status}</span>
    <span class="req-url" title="${entry.url}">${entry.url.replace(/^https?:\/\//, '')}</span>
    <span class="req-size">${size}</span>
  `;
    feed.appendChild(row);
    feed.scrollTop = feed.scrollHeight;
}

function formatBytes(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
}

// ─── Network listener ─────────────────────────────────────────────────────────
function onRequestFinished(harEntry) {
    const req = harEntry.request;
    const res = harEntry.response;
    const url = req.url;

    if (captured.requestUrls.has(url)) return;   // dedup
    captured.requestUrls.add(url);

    const entry = {
        url, method: req.method,
        status: res.status, statusText: res.statusText,
        mimeType: res.content.mimeType || '',
        size: res.content.size || 0,
        time: harEntry.time, startedAt: harEntry.startedDateTime,
        requestHeaders: req.headers, responseHeaders: res.headers,
        queryString: req.queryString, postData: req.postData || null,
        timing: harEntry.timings,
        content: null, encoding: null,
    };

    harEntry.getContent((content, encoding) => {
        entry.content = content;
        entry.encoding = encoding;
        captured.requests.push(entry);
        lastReqTime = Date.now();
        bumpCounter(classify(entry.mimeType, url));
        addFeedRow(entry);
    });
}

// ─── Start / Stop / Clear ─────────────────────────────────────────────────────
function startCapture() {
    isCapturing = true;
    chrome.devtools.network.onRequestFinished.addListener(onRequestFinished);
    btnStart.disabled = true; btnStop.disabled = false;
    btnCrawl.disabled = false; btnDl.disabled = false;
    setStatus('🔴 Capturing… reload voxyz.space or click 🕷 Auto-Crawl', 'working');
}

function stopCapture() {
    isCapturing = false;
    chrome.devtools.network.onRequestFinished.removeListener(onRequestFinished);
    btnStart.disabled = false; btnStop.disabled = true;
    setStatus(`⏹ Stopped — ${captured.requests.length} unique assets captured`);
}

function clearAll() {
    if (isCrawling) return;
    captured.requests.length = 0;
    captured.requestUrls.clear();
    captured.pages = {};
    captured.cookies = [];
    Object.keys(counts).forEach(k => { counts[k] = 0; if (counterEls[k]) counterEls[k].textContent = '0'; });
    feed.innerHTML = '';
    btnDl.disabled = btnCrawl.disabled = true;
    setStatus('Cleared — press ▶ Start to begin');
}

btnStart.addEventListener('click', startCapture);
btnStop.addEventListener('click', stopCapture);
btnClear.addEventListener('click', clearAll);
btnCrawl.addEventListener('click', autoCrawl);
btnDl.addEventListener('click', downloadZip);

// Fix #2: Cancel sets the flag — the crawl loop checks it on every iteration
btnCancel.addEventListener('click', () => {
    if (!isCrawling) return;
    cancelRequested = true;
    btnCancel.disabled = true;
    setStatus('⏳ Finishing current page then stopping…', 'working');
});

// ─── Fix #3: Auto-scroll ──────────────────────────────────────────────────────
// Scrolls the page incrementally from top to bottom, triggering lazy-loaded
// images and below-fold content, then returns to the top before capture.
function autoScrollPage() {
    return new Promise(resolve => {
        // Step 1: measure the page height
        chrome.devtools.inspectedWindow.eval(
            'document.documentElement.scrollHeight',
            (totalHeight) => {
                if (!totalHeight || totalHeight < 300) { resolve(); return; }

                const stepPx = 700;
                const stepCount = Math.ceil(totalHeight / stepPx);
                const stepMs = 220;   // ms per scroll step

                // Step 2: inject a scroll loop into the page
                // Each step scrolls down by stepPx, waits stepMs, then resets to top
                const scrollScript = `
          (function() {
            let i = 0;
            const steps = ${stepCount};
            const tick = () => {
              window.scrollTo(0, i * ${stepPx});
              i++;
              if (i <= steps) {
                setTimeout(tick, ${stepMs});
              } else {
                // scroll back to top when done
                setTimeout(() => window.scrollTo(0, 0), 300);
              }
            };
            tick();
          })()
        `;

                chrome.devtools.inspectedWindow.eval(scrollScript, () => {
                    // Wait for all scroll steps + a buffer for lazy images to fire requests
                    const totalScrollTime = (stepCount + 2) * stepMs + 1200;
                    setTimeout(resolve, totalScrollTime);
                });
            }
        );
    });
}

// ─── Capture full DOM state ───────────────────────────────────────────────────
function capturePageState() {
    return new Promise(resolve => {
        const fn = function () {
            const safe = f => { try { return f(); } catch { return null; } };
            return {
                url: window.location.href,
                title: document.title,
                html: document.documentElement.outerHTML,
                viewport: {
                    width: window.innerWidth, height: window.innerHeight,
                    scrollHeight: document.documentElement.scrollHeight,
                    devicePixelRatio: window.devicePixelRatio,
                },
                meta: Array.from(document.querySelectorAll('meta')).map(m => ({
                    name: m.name, property: m.getAttribute('property'),
                    httpEquiv: m.httpEquiv, content: m.content,
                })),
                // Inline <style> blocks — where Next.js puts ALL Tailwind/CSS-in-JS
                inlineStyles: Array.from(document.querySelectorAll('style')).map((s, i) => ({
                    index: i, media: s.getAttribute('media') || '', content: s.textContent || '',
                })),
                cssVariables: safe(() => {
                    const vars = {}, cs = window.getComputedStyle(document.documentElement);
                    for (const p of cs) { if (p.startsWith('--')) vars[p] = cs.getPropertyValue(p).trim(); }
                    return vars;
                }),
                scripts: Array.from(document.querySelectorAll('script[src]')).map(s => s.src),
                stylesheets: Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map(l => l.href),
                images: Array.from(document.querySelectorAll('img')).map(img => ({
                    src: img.src, alt: img.alt, width: img.naturalWidth, height: img.naturalHeight,
                })),
                internalLinks: safe(() => [...new Set(
                    Array.from(document.querySelectorAll('a[href]'))
                        .map(a => a.href)
                        .filter(h => h.startsWith(window.location.origin))
                )]) || [],
                externalLinks: safe(() => [...new Set(
                    Array.from(document.querySelectorAll('a[href]'))
                        .map(a => a.href)
                        .filter(h => !h.startsWith(window.location.origin) && h.startsWith('http'))
                )]) || [],
                localStorage: safe(() => Object.fromEntries(Object.entries(localStorage))) || {},
                sessionStorage: safe(() => Object.fromEntries(Object.entries(sessionStorage))) || {},
                canonicalLinks: Array.from(document.querySelectorAll('link[rel]')).map(l => ({
                    rel: l.rel, href: l.href,
                })),
            };
        };

        chrome.devtools.inspectedWindow.eval(`(${fn.toString()})()`, (result, err) => {
            if (err) { console.error('[Cloner] capturePageState:', err); resolve(null); return; }
            resolve(result);
        });
    });
}

// ─── Fix #4: Navigate via chrome.tabs.update ──────────────────────────────────
// window.location.href  →  Next.js intercepts as pushState, CSS/JS never reload
// chrome.tabs.update    →  real browser navigation, all assets reload from scratch
async function navigateTo(url) {
    return new Promise(resolve => {
        const tabId = chrome.devtools.inspectedWindow.tabId;
        chrome.runtime.sendMessage({ type: 'NAVIGATE', tabId, url }, () => {
            // Reset idle timer AFTER background confirms navigation was initiated
            lastReqTime = Date.now();
            setTimeout(resolve, 600);
        });
    });
}

// Wait until no new network requests arrive for SETTLE_IDLE ms.
// minWait is longer (1800ms) here because real full-page reloads
// take longer to start than pushState navigations did.
async function waitForSettle() {
    await sleep(1800);
    const start = Date.now();
    return new Promise(resolve => {
        const ticker = setInterval(() => {
            if (Date.now() - lastReqTime > SETTLE_IDLE || Date.now() - start > MAX_WAIT) {
                clearInterval(ticker);
                resolve();
            }
        }, 400);
    });
}

// ─── Auto-Crawl ───────────────────────────────────────────────────────────────
async function autoCrawl() {
    if (isCrawling || !isCapturing) {
        setStatus('⚠ Press ▶ Start first, then Auto-Crawl', 'error');
        return;
    }

    isCrawling = true;
    cancelRequested = false;
    btnCrawl.disabled = true;
    btnCancel.disabled = false;   // Fix #2: enable cancel as soon as crawl starts
    btnDl.disabled = true;

    const queue = new Set();
    const crawled = new Set();
    let cancelled = false;

    // Seed with known VoxYZ static routes
    [BASE_URL, '/insights', '/about', '/stage', '/radar', '/privacy', '/terms']
        .forEach(p => queue.add(p.startsWith('http') ? p : BASE_URL + p));

    while (queue.size > 0) {

        // Fix #2: check cancel flag at the top of every iteration
        if (cancelRequested) {
            cancelled = true;
            break;
        }

        const [url] = queue;
        queue.delete(url);
        if (crawled.has(url)) continue;
        crawled.add(url);

        const label = url.replace(BASE_URL, '') || '/';
        setStatus(`🕷 [${crawled.size} / ~${crawled.size + queue.size}]  ${label}`, 'working');

        // Fix #4: real full-page reload via background → chrome.tabs.update
        await navigateTo(url);
        await waitForSettle();

        // Fix #3: scroll to bottom to trigger lazy-loaded images, then back to top
        setStatus(`↕ Scrolling ${label} for lazy images…`, 'working');
        await autoScrollPage();
        await sleep(800);   // short buffer for lazy-triggered requests to finish

        const state = await capturePageState();
        if (state) {
            captured.pages[url] = state;
            counts.pages = Object.keys(captured.pages).length;
            counterEls.pages.textContent = counts.pages;

            // Discover new internal links from this page
            for (const link of (state.internalLinks || [])) {
                const clean = normaliseUrl(link);
                if (clean && clean.startsWith(BASE_URL) && !crawled.has(clean)) {
                    queue.add(clean);
                }
            }
        }

        await sleep(CRAWL_DELAY);
    }

    // ── Cleanup ──────────────────────────────────────────────────────────────
    isCrawling = false;
    cancelRequested = false;
    btnCrawl.disabled = false;
    btnCancel.disabled = true;

    if (cancelled) {
        setStatus(
            `⚠ Cancelled — ${crawled.size} pages captured. You can still Download ZIP.`,
            'working'
        );
        btnDl.disabled = Object.keys(captured.pages).length === 0;
    } else {
        btnDl.disabled = false;
        setStatus(
            `✅ Crawl done — ${crawled.size} pages, ${captured.requests.length} assets. Click ⬇ Download ZIP`,
            'done'
        );
    }
}

// Strip fragments + trailing slashes to avoid treating /about and /about#team as different pages
function normaliseUrl(url) {
    try {
        const u = new URL(url);
        if (u.hostname !== new URL(BASE_URL).hostname) return null;
        return u.origin + u.pathname.replace(/\/$/, '') + u.search;
    } catch { return null; }
}

function shouldSkipAsset(url) {
    return /\.(pdf|zip|mp4|mp3|exe|dmg)(\?|$)/i.test(url) ||
        url.includes('mailto:') || url.includes('javascript:') ||
        url.includes('tel:');
}

// ─── Asset path rewriting ─────────────────────────────────────────────────────
function rewriteAssetPaths(html, assetMap) {
    let out = html;
    for (const [originalUrl, localZipPath] of Object.entries(assetMap)) {
        out = out.split(originalUrl).join('../' + localZipPath);
    }
    return out;
}

// ─── Fix #1: Inject inline styles <link> into HTML <head> ─────────────────────
// Without this, _inline-styles-combined.css exists in the ZIP but nothing
// references it, so the cloned page still loads without Tailwind styles.
function injectInlineStylesLink(html) {
    const linkTag = '  <link rel="stylesheet" href="../assets/css/_inline-styles-combined.css">';
    // Insert just before </head> — works whether </head> is uppercase or lowercase
    return html.replace(/<\/head>/i, `${linkTag}\n</head>`);
}

// ─── Download as ZIP ──────────────────────────────────────────────────────────
async function downloadZip() {
    btnDl.disabled = true;
    setStatus('📸 Final DOM snapshot + scroll…', 'working');

    // Scroll and capture the currently visible page one last time
    await autoScrollPage();   // Fix #3: scroll even for single-page manual download
    await sleep(600);
    const currentState = await capturePageState();
    if (currentState) {
        captured.pages[currentState.url] = currentState;
        counts.pages = Object.keys(captured.pages).length;
        counterEls.pages.textContent = counts.pages;
    }

    // Cookies
    const anyUrl = Object.keys(captured.pages)[0] || BASE_URL;
    const cookies = await new Promise(resolve =>
        chrome.runtime.sendMessage({ type: 'GET_COOKIES', url: anyUrl }, res => resolve(res?.cookies ?? []))
    );

    const R = captured.requests;
    const cssR = R.filter(r => classify(r.mimeType, r.url) === 'css');
    const jsR = R.filter(r => classify(r.mimeType, r.url) === 'js');
    const jsonR = R.filter(r => classify(r.mimeType, r.url) === 'json');
    const imgR = R.filter(r => classify(r.mimeType, r.url) === 'img');
    const fontR = R.filter(r => classify(r.mimeType, r.url) === 'font');

    // URL → local ZIP path map (used for both saving + HTML path rewriting)
    const assetMap = {};
    cssR.forEach(r => { assetMap[r.url] = `assets/css/${urlToFilename(r.url, 'css')}`; });
    jsR.forEach(r => { assetMap[r.url] = `assets/js/${urlToFilename(r.url, 'js')}`; });
    imgR.forEach(r => {
        const ext = extFromUrl(r.url) || extFromMime(r.mimeType) || 'png';
        assetMap[r.url] = `assets/images/${urlToFilename(r.url, ext)}`;
    });
    fontR.forEach(r => {
        assetMap[r.url] = `assets/fonts/${urlToFilename(r.url, extFromUrl(r.url) || 'woff2')}`;
    });

    setStatus('📦 Assembling ZIP…', 'working');
    const zip = new JSZip();

    // ── Collect ALL inline style blocks across every crawled page ────────────
    // We do this first (before the page loop) so we know what CSS to write
    const allInlineStyles = new Set();
    for (const state of Object.values(captured.pages)) {
        (state?.inlineStyles || []).forEach(s => {
            if (s.content?.trim()) allInlineStyles.add(s.content.trim());
        });
    }

    // ── Always write the combined inline styles file ─────────────────────────
    // Fix #1: this file must exist so the injected <link> tag doesn't 404
    zip.file(
        'assets/css/_inline-styles-combined.css',
        [...allInlineStyles].join('\n\n/* ─── next block ─── */\n\n')
    );

    // ── One HTML file per page, with rewritten paths + injected <link> ───────
    for (const [url, state] of Object.entries(captured.pages)) {
        if (!state?.html) continue;
        const slug = urlToPageSlug(url);

        let html = state.html;
        html = rewriteAssetPaths(html, assetMap);   // replace CDN URLs with ../assets/...
        html = injectInlineStylesLink(html);         // Fix #1: inject the <link> tag

        zip.file(`dom/${slug}.html`, html);
        zip.file(`dom/${slug}.state.json`, JSON.stringify({
            url: state.url, title: state.title,
            meta: state.meta, viewport: state.viewport,
            cssVariables: state.cssVariables,
            localStorage: state.localStorage,
            sessionStorage: state.sessionStorage,
            internalLinks: state.internalLinks,
            externalLinks: state.externalLinks,
        }, null, 2));
    }

    // ── Master index ──────────────────────────────────────────────────────────
    zip.file('__index.json', JSON.stringify({
        clonedAt: new Date().toISOString(),
        sourceUrl: BASE_URL,
        pagesCrawled: Object.keys(captured.pages).length,
        stats: {
            totalAssets: R.length,
            css: cssR.length, js: jsR.length,
            apiResponses: jsonR.length, images: imgR.length,
            fonts: fontR.length,
            inlineStyleBlocks: allInlineStyles.size,
        },
        crawledPages: Object.keys(captured.pages),
    }, null, 2));

    // ── Cookies ───────────────────────────────────────────────────────────────
    zip.file('dom/cookies.json', JSON.stringify(cookies, null, 2));

    // ── Full HAR ──────────────────────────────────────────────────────────────
    zip.file('network/full.har', JSON.stringify({
        log: {
            version: '1.2',
            creator: { name: 'VoxYZ Site Cloner', version: '2.1' },
            entries: R.map(r => ({
                startedDateTime: r.startedAt, time: r.time,
                request: { method: r.method, url: r.url, headers: r.requestHeaders, queryString: r.queryString, postData: r.postData },
                response: { status: r.status, statusText: r.statusText, headers: r.responseHeaders, content: { mimeType: r.mimeType, size: r.size } },
                timings: r.timing,
            })),
        },
    }, null, 2));

    // ── API responses ─────────────────────────────────────────────────────────
    zip.file('network/api-responses.json', JSON.stringify(
        jsonR.map(r => ({ url: r.url, method: r.method, status: r.status, body: tryParseJSON(r.content) ?? r.content })),
        null, 2
    ));

    // ── CSS, JS, Images, Fonts ────────────────────────────────────────────────
    cssR.forEach(r => { if (r.content) zip.file(assetMap[r.url], r.content); });
    jsR.forEach(r => { if (r.content) zip.file(assetMap[r.url], r.content); });
    imgR.forEach(r => {
        if (!r.content) return;
        r.encoding === 'base64'
            ? zip.file(assetMap[r.url], r.content, { base64: true })
            : zip.file(assetMap[r.url], r.content);
    });
    fontR.forEach(r => {
        if (!r.content) return;
        r.encoding === 'base64'
            ? zip.file(assetMap[r.url], r.content, { base64: true })
            : zip.file(assetMap[r.url], r.content);
    });

    // ── Generate + download ───────────────────────────────────────────────────
    const fileCount = Object.keys(zip.files).length;
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    setStatus(`🗜 Compressing ${fileCount} files…`, 'working');

    zip.generateAsync(
        { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
        meta => setStatus(`🗜 Compressing… ${meta.percent.toFixed(0)}%`, 'working')
    ).then(blob => {
        const objUrl = URL.createObjectURL(blob);
        const zipName = `voxyz-clone__${ts}.zip`;
        chrome.downloads.download({ url: objUrl, filename: zipName, saveAs: true }, () => {
            URL.revokeObjectURL(objUrl);
            setStatus(`✅ Saved ${zipName}  (${fileCount} files, ${formatBytes(blob.size)})`, 'done');
            btnDl.disabled = false;
        });
    });
}

// ─── Filename helpers ─────────────────────────────────────────────────────────
function urlToFilename(url, fallbackExt = '') {
    try {
        const u = new URL(url);
        let name = u.pathname.split('/').pop() || 'file';
        if (name.length > 80) name = name.slice(0, 80);
        const hash = Math.abs(
            url.split('').reduce((h, c) => (Math.imul(31, h) + c.charCodeAt(0)) | 0, 0)
        ).toString(36);
        if (!extFromUrl(url) && fallbackExt) name += '.' + fallbackExt;
        const dot = name.lastIndexOf('.');
        return dot > 0 ? `${name.slice(0, dot)}_${hash}${name.slice(dot)}` : `${name}_${hash}`;
    } catch {
        return `file_${Math.random().toString(36).slice(2)}.${fallbackExt}`;
    }
}

function urlToPageSlug(url) {
    try {
        const path = new URL(url).pathname.replace(/^\/|\/$/g, '').replace(/\//g, '__');
        return path || 'index';
    } catch { return 'page_' + Math.random().toString(36).slice(2); }
}

function extFromUrl(url) {
    try {
        const e = new URL(url).pathname.split('.').pop()?.split('?')[0]?.toLowerCase();
        return e && e.length <= 5 ? e : null;
    } catch { return null; }
}

function extFromMime(mime = '') {
    const m = {
        'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/svg+xml': 'svg',
        'image/webp': 'webp', 'image/avif': 'avif', 'image/x-icon': 'ico',
        'font/woff2': 'woff2', 'font/woff': 'woff', 'font/ttf': 'ttf', 'font/otf': 'otf',
    };
    return m[mime] || null;
}

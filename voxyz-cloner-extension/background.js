chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

    // Keep-alive ping from panel — prevents MV3 service worker from sleeping during long crawls
    if (msg.type === 'PING') {
        sendResponse({ ok: true });
        return false; // sync response, no need to keep channel open
    }

    // Fetch all cookies for a URL
    if (msg.type === 'GET_COOKIES') {
        chrome.cookies.getAll({ url: msg.url }, cookies => sendResponse({ cookies }));
        return true;
    }

    // Force a REAL full-page navigation — bypasses Next.js client-side routing
    if (msg.type === 'NAVIGATE') {
        chrome.tabs.update(msg.tabId, { url: msg.url }, () => sendResponse({ ok: true }));
        return true;
    }

    // #31: Concurrent Background Crawler Worker
    if (msg.type === 'CRAWL_PAGE') {
        crawlPageInBackground(msg.url, sendResponse);
        return true;
    }

    // Desktop notification when crawl ends
    if (msg.type === 'NOTIFY') {
        chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icon128.png',
            title: msg.title,
            message: msg.message,
            priority: 2
        });
        return true;
    }

});

/**
 * Opens a background tab, navigates, captures state, and closes
 */
async function crawlPageInBackground(url, callback) {
    let tab;
    try {
        tab = await chrome.tabs.create({ url, active: false });

        // Wait for page load
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject('timeout'), 20000);
            const listener = (tabId, info) => {
                if (tabId === tab.id && info.status === 'complete') {
                    clearTimeout(timeout);
                    chrome.tabs.onUpdated.removeListener(listener);
                    // Settle delay
                    setTimeout(resolve, 3000);
                }
            };
            chrome.tabs.onUpdated.addListener(listener);
        });

        // Script to run in the background tab
        const captureScript = () => {
            const serializeNode = (node) => {
                if (node.nodeType === Node.TEXT_NODE) return node.textContent;
                if (node.nodeType === Node.COMMENT_NODE) return '<!--' + node.textContent + '-->';
                if (node.nodeType !== Node.ELEMENT_NODE) return "";
                if (node.tagName.toLowerCase() === 'canvas') {
                    try { return '<img src="' + node.toDataURL('image/png') + '" style="' + node.style.cssText + '" class="' + node.className + '" data-voxyz-canvas="true">'; } catch (e) { return '<!-- canvas fail -->'; }
                }
                let str = "<" + node.tagName.toLowerCase();
                Array.from(node.attributes).forEach(attr => str += " " + attr.name + '="' + attr.value.replace(/"/g, '&quot;') + '"');
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

            const getStorage = () => {
                const res = { local: {}, session: {} };
                try {
                    for (let i = 0; i < localStorage.length; i++) res.local[localStorage.key(i)] = localStorage.getItem(localStorage.key(i));
                    for (let i = 0; i < sessionStorage.length; i++) res.session[sessionStorage.key(i)] = sessionStorage.getItem(sessionStorage.key(i));
                } catch (e) { }
                return res;
            };

            return {
                url: window.location.href,
                title: document.title,
                html: "<html" + Array.from(document.documentElement.attributes).map(a => ' ' + a.name + '="' + a.value.replace(/"/g, '&quot;') + '"').join("") + ">" + Array.from(document.documentElement.childNodes).map(serializeNode).join("") + "</html>",
                storage: getStorage(),
                inlineStyles: Array.from(document.querySelectorAll('style')).map(s => s.textContent || ''),
                internalLinks: Array.from(document.querySelectorAll('a[href]')).map(a => a.href).filter(h => h.startsWith(window.location.origin))
            };
        };

        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: captureScript
        });

        callback({ status: 'ok', data: results[0].result });
    } catch (e) {
        callback({ status: 'error', message: e.toString() });
    } finally {
        if (tab) chrome.tabs.remove(tab.id);
    }
}

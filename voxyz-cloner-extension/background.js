chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

    // Fetch all cookies for a URL
    if (msg.type === 'GET_COOKIES') {
        chrome.cookies.getAll({ url: msg.url }, cookies => sendResponse({ cookies }));
        return true;
    }

    // Force a REAL full-page navigation — bypasses Next.js client-side routing
    // window.location.href only triggers pushState on Next.js, meaning CSS/JS
    // bundles are reused and never hit onRequestFinished again on page 2+
    if (msg.type === 'NAVIGATE') {
        chrome.tabs.update(msg.tabId, { url: msg.url }, () => sendResponse({ ok: true }));
        return true;
    }

});

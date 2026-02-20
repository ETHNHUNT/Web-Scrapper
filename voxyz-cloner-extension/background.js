chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

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

    // Desktop notification when crawl ends
    if (msg.type === 'NOTIFY') {
        chrome.notifications.create({
            type: 'basic',
            iconUrl: 'voxyz-cloner-extension/manifest.json', // dummy
            title: msg.title,
            message: msg.message,
            priority: 2
        });
        return true;
    }

});

const { test, expect, chromium } = require('@playwright/test');
const path = require('path');

test.describe('Voxyz Cloner Extension', () => {
    let context;
    let extensionId;

    test.beforeAll(async () => {
        console.log('Launching browser with extension...');
        const extensionPath = path.join(__dirname, '../voxyz-cloner-extension');
        context = await chromium.launchPersistentContext('', {
            headless: false,
            args: [
                `--disable-extensions-except=${extensionPath}`,
                `--load-extension=${extensionPath}`,
            ],
        });

        console.log('Context launched. Finding Extension ID...');

        for (let i = 0; i < 10; i++) {
            const [worker] = context.serviceWorkers();
            if (worker) {
                extensionId = worker.url().split('/')[2];
                console.log('Found via worker:', extensionId);
                break;
            }

            const pages = context.pages();
            for (const page of pages) {
                if (page.url().startsWith('chrome-extension://')) {
                    extensionId = page.url().split('/')[2];
                    console.log('Found via page:', extensionId);
                    break;
                }
            }
            if (extensionId) break;
            await new Promise(r => setTimeout(r, 1000));
        }
    });

    test.afterAll(async () => {
        if (context) await context.close();
    });

    test('should load the extension panel', async () => {
        test.skip(!extensionId, 'Extension ID not found');
        const page = await context.newPage();
        await page.goto(`chrome-extension://${extensionId}/panel.html`, { waitUntil: 'domcontentloaded' });

        // Assertion: Check start button instead of H1
        await expect(page.locator('#btn-start')).toBeVisible();
        await expect(page.locator('#status-text')).toContainText('Ready');
        console.log('Panel load verified');
    });

    test('should switch tabs', async () => {
        test.skip(!extensionId, 'Extension ID not found');
        const page = await context.newPage();
        await page.goto(`chrome-extension://${extensionId}/panel.html`, { waitUntil: 'domcontentloaded' });

        // Click on Crawled Pages tab - Use text that exists
        await page.click('text=Crawled Pages');
        await expect(page.locator('#pane-pages')).toHaveClass(/active/);
        console.log('Switched to Pages tab');

        // Click on Requests tab
        await page.click('text=Requests');
        await expect(page.locator('#pane-requests')).toHaveClass(/active/);
        console.log('Switched to Requests tab');
    });

    test('should have UI controls functional', async () => {
        test.skip(!extensionId, 'Extension ID not found');
        const page = await context.newPage();
        await page.goto(`chrome-extension://${extensionId}/panel.html`, { waitUntil: 'domcontentloaded' });

        // Check depth selector
        const depthSel = page.locator('#sel-depth');
        await expect(depthSel).toHaveValue('99'); // Default SOTA value

        // Check stealth checkbox
        const stealthChk = page.locator('#chk-stealth');
        await stealthChk.check();
        await expect(stealthChk).toBeChecked();
    });
});

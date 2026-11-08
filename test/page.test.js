const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const settingsJs = fs.readFileSync(path.join(__dirname, '..', 'settings.js'), 'utf8');
// jsdom does not fetch external scripts, so inline the shared settings script
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
    .replace('<script src="/settings.js"></script>', () => `<script>${settingsJs}</script>`);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (fn()) return; await tick(10); }
    throw new Error('timed out waiting for: ' + fn);
};

describe('upload page', function () {
    let dom, window, document, requests;

    class FakeXHR {
        constructor() { this.upload = {}; this.status = 0; this.responseText = ''; this.aborted = false; requests.push(this); }
        open(method, url) { this.method = method; this.url = url; }
        send(body) { this.body = body; }
        abort() { this.aborted = true; this.onabort && this.onabort(); }
        progress(loaded, total) { this.upload.onprogress({ lengthComputable: true, loaded, total }); }
        getResponseHeader(name) { return (this.headers || {})[name] || null; }
        respond(status, data, headers) {
            this.headers = headers;
            this.upload.onload && this.upload.onload();
            this.status = status;
            this.responseText = JSON.stringify(data);
            this.onload();
        }
        ok(src) { this.respond(200, [{ src }]); }
    }

    let fetchLog;

    // config: what /config answers (null = the request fails, as if the server were unreachable)
    function makePage(storedSettings, config) {
        fetchLog = [];
        dom = new JSDOM(html, {
            url: 'https://host.test/',
            runScripts: 'dangerously',
            pretendToBeVisual: true,
            beforeParse(win) {
                win.XMLHttpRequest = FakeXHR;
                // shorteners fail -> the full URL is kept
                win.fetch = (url) => {
                    if (String(url) === '/config') {
                        return config ? Promise.resolve(Response.json(config)) : Promise.reject(new Error('offline'));
                    }
                    fetchLog.push(String(url));
                    return Promise.reject(new Error('offline'));
                };
                Object.defineProperty(win, 'crypto', { value: require('crypto').webcrypto, configurable: true });
                if (storedSettings) win.localStorage.setItem('th_settings', JSON.stringify(storedSettings));
            },
        });
        window = dom.window;
        document = window.document;
    }

    beforeEach(function () {
        requests = [];
        makePage();
    });
    afterEach(function () { window.close(); });

    const rows = () => Array.from(document.querySelectorAll('#trayList .job'));
    const names = () => rows().map(r => r.querySelector('.job-name').textContent);
    const label = i => rows()[i].querySelector('.job-label').textContent;
    const history = () => JSON.parse(window.localStorage.getItem('th_history') || '[]');

    function pick(...fileNames) {
        const files = fileNames.map(n => new window.File(['x'.repeat(100)], n, { type: 'image/png' }));
        const input = document.getElementById('fileInput');
        Object.defineProperty(input, 'files', { value: files, configurable: true });
        input.dispatchEvent(new window.Event('change'));
    }

    it('starts with only the drop zone and a collapsed Options link', function () {
        assert.ok(document.getElementById('optionsPanel').hidden);
        assert.ok(document.getElementById('tray').hidden);
        assert.strictEqual(document.getElementById('optionsBtn').getAttribute('aria-expanded'), 'false');
        document.getElementById('optionsBtn').click();
        assert.ok(!document.getElementById('optionsPanel').hidden);
    });

    it('runs two uploads at a time with live progress, then moves links to history', async function () {
        pick('a.png', 'b.png', 'c.png');
        await tick();
        assert.deepStrictEqual(names(), ['a.png', 'b.png', 'c.png']);
        assert.strictEqual(requests.length, 2, 'the third file waits for a free slot');
        assert.strictEqual(label(2), 'Waiting');
        assert.ok(document.getElementById('tray').classList.contains('stacked'));

        requests[0].progress(50, 100);
        assert.strictEqual(rows()[0].querySelector('.job-pct').textContent, '50%');
        assert.strictEqual(document.getElementById('trayPct').textContent, '17%', '(50% + 0% + 0%) of three equal files');
        assert.strictEqual(document.getElementById('trayCount').textContent, '3');

        requests[0].ok('/file/AAAA1.png');
        await tick();
        assert.strictEqual(requests.length, 3, 'a finished upload frees its slot immediately');
        requests[1].ok('/file/BBBB2.png');
        requests[2].ok('/file/CCCC3.png');
        await tick(20);

        assert.deepStrictEqual(history().map(e => e.url).sort(), [
            'https://host.test/file/AAAA1.png', 'https://host.test/file/BBBB2.png', 'https://host.test/file/CCCC3.png',
        ]);
        assert.ok(document.getElementById('history').classList.contains('visible'));
        assert.strictEqual(document.querySelectorAll('#historyList .result-item').length, 3);
    });

    it('cancels an upload in flight and lets the queue continue', async function () {
        pick('a.png', 'b.png');
        await tick();
        rows()[0].querySelector('.job-x').click();
        await tick();
        assert.ok(requests[0].aborted);
        assert.deepStrictEqual(names(), ['b.png']);
        assert.strictEqual(requests.length, 2, 'b was already running');
        requests[1].ok('/file/BBBB2.png');
        await tick(20);
        assert.deepStrictEqual(history().map(e => e.url), ['https://host.test/file/BBBB2.png']);
    });

    it('cancels a waiting upload without ever sending it', async function () {
        pick('a.png', 'b.png', 'c.png');
        await tick();
        assert.strictEqual(requests.length, 2);
        rows()[2].querySelector('.job-x').click();
        requests[0].ok('/file/AAAA1.png');
        requests[1].ok('/file/BBBB2.png');
        await tick(20);
        assert.strictEqual(requests.length, 2, 'the cancelled file was never sent');
        assert.strictEqual(history().length, 2);
    });

    it('keeps a failed upload with Retry, and retry re-sends it', async function () {
        pick('a.png');
        await tick();
        // The page makes 3 attempts, waiting 1s then 2s between them.
        for (let i = 0; i < 3; i++) {
            while (requests.length <= i) await tick(50);
            requests[i].respond(500, { error: 'boom' });
        }
        await tick();
        const row = rows()[0];
        assert.strictEqual(row.dataset.state, 'error');
        assert.strictEqual(label(0), 'boom');
        assert.ok(!row.querySelector('.job-retry').hidden);
        const before = requests.length;
        row.querySelector('.job-retry').click();
        await tick();
        assert.strictEqual(requests.length, before + 1);
        requests[requests.length - 1].ok('/file/AAAA1.png');
        await tick(20);
        assert.strictEqual(history().length, 1);
    }).timeout(15000);

    it('waits out a Telegram rate limit with a countdown, then retries without failing', async function () {
        pick('a.png');
        await tick();
        requests[0].respond(429, { error: 'busy', retryAfter: 1 }, { 'Retry-After': '1' });
        await tick();
        assert.strictEqual(label(0), 'Telegram is busy — retrying in 1s');
        assert.strictEqual(rows()[0].dataset.state, 'uploading');
        await tick(1200);
        assert.strictEqual(requests.length, 2, 'retried after the wait');
        requests[1].ok('/file/AAAA1.png');
        await tick(20);
        assert.strictEqual(history().length, 1);
    });

    it('sends the options chosen at drop time, then resets them', async function () {
        const sel = document.getElementById('expirySel');
        sel.value = '3600';
        sel.dispatchEvent(new window.Event('change'));
        assert.strictEqual(document.getElementById('optionsSummary').textContent, 'Expires in 1 hour');

        pick('a.png');
        await tick();
        assert.strictEqual(requests[0].body.get('expiresIn'), '3600');
        assert.strictEqual(sel.value, '');
        assert.strictEqual(document.getElementById('optionsSummary').textContent, '');

        pick('b.png');
        await tick();
        requests[0].ok('/s/MMMM.png');
        await tick();
        assert.strictEqual(requests[1].body.get('expiresIn'), null, 'next batch is not expiring');
    });

    it('shows a single upload as one card with one progress bar', async function () {
        pick('a.png');
        await tick();
        const tray = document.getElementById('tray');
        assert.ok(tray.classList.contains('single'));
        assert.ok(!tray.classList.contains('stacked'));
        requests[0].progress(43, 100);
        assert.strictEqual(rows()[0].querySelector('.job-pct').textContent, '43%');
        assert.strictEqual(document.querySelectorAll('.tray .job-bar, .tray .tray-total').length, 2, 'the header bar exists in the DOM but is hidden by CSS for a single upload');
    });

    it('uploads a big file as encrypted parts, finalizes them, and links /s/ in the history', async function () {
        const finalizeCalls = [];
        window.fetch = async (url, init) => {
            finalizeCalls.push({ url: String(url), body: JSON.parse(init.body) });
            return new window.Response(JSON.stringify([{ src: '/s/ABCDEFGHIJKLMNOPQRSTUVWXYZ' }]), { status: 200 });
        };
        window.Response = window.Response || Response;
        const sel = document.getElementById('expirySel');
        sel.value = '3600';
        sel.dispatchEvent(new window.Event('change'));
        const pw = document.getElementById('passwordInput');
        pw.value = 'hunter2';
        pw.dispatchEvent(new window.Event('input'));

        const big = new window.File([new Uint8Array(19 * 1024 * 1024 + 10)], 'movie.bin', { type: 'application/octet-stream' });
        const input = document.getElementById('fileInput');
        Object.defineProperty(input, 'files', { value: [big], configurable: true });
        input.dispatchEvent(new window.Event('change'));

        const receipt = n => ({ fileId: `P${n}`.padEnd(30, 'x'), msgId: n, size: 1, sig: 's' });
        for (let n = 1; n <= 2; n++) {
            await until(() => requests.length >= n);
            const body = requests[n - 1].body;
            assert.strictEqual(body.get('part'), '1');
            assert.strictEqual(body.get('file').name, `part${n}.bin`, 'encrypted parts do not carry the file name');
            assert.strictEqual(body.get('encSalt'), null);
            requests[n - 1].respond(200, [{ src: `/file/P${n}.bin`, receipt: receipt(n) }]);
        }
        await until(() => finalizeCalls.length === 1);
        assert.strictEqual(finalizeCalls[0].url, '/finalize');
        const sent = finalizeCalls[0].body;
        assert.deepStrictEqual(sent.receipts.map(r => r.msgId), [1, 2]);
        assert.strictEqual(sent.expiresIn, '3600');
        assert.strictEqual(sent.name, 'movie.bin');
        assert.ok(sent.enc.salt && sent.enc.ivp && sent.enc.iter === 600000);
        assert.strictEqual(sent.enc.iv, undefined);

        await until(() => history().length === 1);
        assert.strictEqual(history()[0].url, 'https://host.test/s/ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    }).timeout(15000);

    it('toggles the tray list on tap for touch screens', async function () {
        pick('a.png');
        await tick();
        const tray = document.getElementById('tray');
        document.getElementById('trayHead').click();
        assert.ok(tray.classList.contains('open'));
        assert.strictEqual(document.getElementById('trayHead').getAttribute('aria-expanded'), 'true');
    });

    it('keeps every link of a batch bigger than the old history cap', async function () {
        const total = 25;
        pick(...Array.from({ length: total }, (_, i) => `f${i}.png`));
        for (let i = 0; i < total; i++) {
            await tick();
            requests[i].ok(`/file/ID${String(i).padStart(4, '0')}.png`);
        }
        await tick(30);
        assert.strictEqual(history().length, total);
    }).timeout(10000);

    it('only the dropzone itself opens the file picker from the keyboard', function () {
        let opened = 0;
        document.getElementById('fileInput').click = () => { opened++; };
        const pw = document.getElementById('passwordInput');
        pw.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
        assert.strictEqual(opened, 0);
        document.getElementById('dropzone').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        assert.strictEqual(opened, 1);
    });

    describe('"Open HTML files in the browser" option', function () {
        beforeEach(async function () {
            window.close();
            makePage(undefined, { htmlRender: true }); // the operator has switched rendering on
            await tick(30);
        });

        const checkbox = () => document.getElementById('renderHtml');
        const flip = on => { checkbox().checked = on; checkbox().dispatchEvent(new window.Event('change')); };

        it('is hidden unless the server says rendering is on', async function () {
            const label = () => document.getElementById('renderHtmlLabel');
            assert.strictEqual(label().hidden, false, 'on');
            for (const config of [{ htmlRender: false }, {}, { htmlRender: 'true' }, null]) {
                window.close();
                makePage(undefined, config);
                await tick(30);
                assert.strictEqual(label().hidden, true, JSON.stringify(config));
            }
        });

        it('is never sent, even if ticked on an earlier visit, while the server has rendering off', async function () {
            window.close();
            makePage(undefined, { htmlRender: false });
            window.localStorage.setItem('th_render', '1');
            await tick(30);
            document.getElementById('renderHtml').checked = true;
            pick('page.html');
            await tick();
            assert.strictEqual(requests[0].body.get('render'), null);
            assert.doesNotMatch(document.getElementById('optionsSummary').textContent, /HTML/);
        });

        it('sends render=1 for HTML files only, and only when ticked', async function () {
            pick('page.html', 'pic.png');
            await tick();
            assert.strictEqual(requests[0].body.get('render'), null, 'unticked');
            requests[0].ok('/file/A0000.html'); requests[1].ok('/file/B0000.png');
            await tick(30);

            flip(true);
            pick('site.htm', 'pic.png');
            await until(() => requests.length >= 4);
            const sent = Object.fromEntries(requests.slice(2).map(r => [r.body.get('file').name, r.body.get('render')]));
            assert.deepStrictEqual(sent, { 'site.htm': '1', 'pic.png': null });
        });

        it('is remembered between visits and shows in the options summary', async function () {
            flip(true);
            assert.strictEqual(window.localStorage.getItem('th_render'), '1');
            assert.match(document.getElementById('optionsSummary').textContent, /HTML opens in browser/);
            const settingsKept = window.localStorage.getItem('th_render');
            window.close();
            makePage();
            window.localStorage.setItem('th_render', settingsKept);
            window.close();
            // a fresh page reads the saved choice
            const html2 = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8')
                .replace('<script src="/settings.js"></script>', () => `<script>${settingsJs}</script>`);
            const dom2 = new JSDOM(html2, { url: 'https://host.test/', runScripts: 'dangerously', beforeParse(win) { win.localStorage.setItem('th_render', '1'); win.fetch = () => Promise.reject(new Error('x')); } });
            assert.strictEqual(dom2.window.document.getElementById('renderHtml').checked, true);
            dom2.window.close();
            makePage();
        });

        it("shows the server's note next to the link when it cannot open it in the browser", async function () {
            flip(true);
            pick('page.html');
            await tick();
            requests[0].respond(200, [{ src: '/file/NOTEID0000.html', note: 'Opening HTML in the browser is turned off on this deployment, so this link downloads the file.' }]);
            await tick(30);
            assert.match(document.querySelector('#historyList .result-note').textContent, /turned off on this deployment/);
        });
    });

    describe('copy as Markdown / HTML / BBCode', function () {
        let copied;

        beforeEach(function () {
            copied = [];
            Object.defineProperty(window.navigator, 'clipboard', {
                value: { writeText: async text => { copied.push(text); } },
                configurable: true,
            });
        });

        async function copyVia(row, label) {
            const button = Array.from(row.querySelectorAll('.more-menu button')).find(b => b.textContent === label);
            button.click();
            await tick();
            return copied[copied.length - 1];
        }

        async function addHistoryRow(src) {
            pick('a.png');
            await tick();
            requests[requests.length - 1].ok(src);
            await tick(30);
            return document.querySelector('#historyList .result-item');
        }

        it('offers image snippets for an image link', async function () {
            const row = await addHistoryRow('/file/IMG1.png');
            const url = 'https://host.test/file/IMG1.png';
            assert.strictEqual(await copyVia(row, 'Markdown'), `![](${url})`);
            assert.strictEqual(await copyVia(row, 'HTML'), `<img src="${url}">`);
            assert.strictEqual(await copyVia(row, 'BBCode'), `[img]${url}[/img]`);
        });

        it('offers link snippets for anything else, including /s/ links', async function () {
            const row = await addHistoryRow('/s/ABCDEFGHIJKLMNOPQRSTUVWXYZ');
            const url = 'https://host.test/s/ABCDEFGHIJKLMNOPQRSTUVWXYZ';
            assert.strictEqual(await copyVia(row, 'Markdown'), `[${url}](${url})`);
            assert.strictEqual(await copyVia(row, 'HTML'), `<a href="${url}">${url}</a>`);
            assert.strictEqual(await copyVia(row, 'BBCode'), `[url]${url}[/url]`);
        });

        it('escapes quotes and angle brackets so a URL cannot break out of the snippet', async function () {
            window.close();
            makePage({ shortener: 'custom', customShortener: 'https://short.example/s?u={url}' });
            Object.defineProperty(window.navigator, 'clipboard', {
                value: { writeText: async text => { copied.push(text); } },
                configurable: true,
            });
            window.fetch = async () => ({ text: async () => 'https://short.example/a"><script>alert(1)</script>' });
            const row = await addHistoryRow('/file/IMG1.png');
            await tick(30);
            const html = await copyVia(document.querySelector('#historyList .result-item'), 'HTML');
            assert.ok(html.startsWith('<a href="https://short.example/a%22%3E%3Cscript%3E'), html);
            assert.ok(!html.includes('<script>'));
            assert.ok(row);
        });
    });

    describe('with power-user settings', function () {
        const finish = async (n) => {
            for (let i = 0; i < n; i++) {
                await until(() => requests.length > i);
                requests[i].ok(`/file/ID${String(i).padStart(4, '0')}.png`);
                await tick();
            }
            await tick(30);
        };

        it('history size 0 keeps links for the session only, and stores nothing', async function () {
            window.close();
            makePage({ historyMax: 0 });
            assert.strictEqual(document.getElementById('historyTitle').textContent, 'This session');
            pick('a.png');
            await finish(1);
            assert.strictEqual(document.querySelectorAll('#historyList .result-item').length, 1);
            assert.strictEqual(window.localStorage.getItem('th_history'), null);
            document.getElementById('historyClear').click();
            assert.strictEqual(document.querySelectorAll('#historyList .result-item').length, 0);
        });

        it('a history size limit keeps only the newest links', async function () {
            window.close();
            makePage({ historyMax: 2 });
            pick('a.png', 'b.png', 'c.png');
            await finish(3);
            assert.strictEqual(history().length, 2);
        });

        it('shortener "none" never contacts a shortening service', async function () {
            window.close();
            makePage({ shortener: 'none' });
            pick('a.png');
            await finish(1);
            assert.deepStrictEqual(fetchLog, []);
            assert.strictEqual(history().length, 1);
        });

        it('a custom shortener gets the URL-encoded link and its short link is used', async function () {
            window.close();
            makePage({ shortener: 'custom', customShortener: 'https://short.example/s?u={url}' });
            window.fetch = async (url) => {
                fetchLog.push(String(url));
                return { text: async () => 'https://short.example/abc' };
            };
            pick('a.png');
            await finish(1);
            await tick(30);
            assert.deepStrictEqual(fetchLog, ['https://short.example/s?u=' + encodeURIComponent('https://host.test/file/ID0000.png')]);
            assert.deepStrictEqual(history().map(e => e.url), ['https://short.example/abc']);
        });

        it('an invalid custom shortener is ignored and falls back to automatic', async function () {
            window.close();
            makePage({ shortener: 'custom', customShortener: 'http://insecure.example/?u={url}' });
            pick('a.png');
            await finish(1);
            assert.ok(fetchLog.length > 0);
            assert.ok(fetchLog.every(u => u.startsWith('https://da.gd/') || u.startsWith('https://tinyurl.com/')));
        });

        it('concurrency 1 uploads one file at a time', async function () {
            window.close();
            makePage({ concurrency: 1 });
            pick('a.png', 'b.png');
            await tick();
            assert.strictEqual(requests.length, 1);
            requests[0].ok('/file/ID0000.png');
            await tick();
            assert.strictEqual(requests.length, 2);
        });
    });
});

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

describe('upload page', function () {
    let dom, window, document, requests;

    class FakeXHR {
        constructor() { this.upload = {}; this.status = 0; this.responseText = ''; this.aborted = false; requests.push(this); }
        open(method, url) { this.method = method; this.url = url; }
        send(body) { this.body = body; }
        abort() { this.aborted = true; this.onabort && this.onabort(); }
        progress(loaded, total) { this.upload.onprogress({ lengthComputable: true, loaded, total }); }
        respond(status, data) {
            this.upload.onload && this.upload.onload();
            this.status = status;
            this.responseText = JSON.stringify(data);
            this.onload();
        }
        ok(src) { this.respond(200, [{ src }]); }
    }

    beforeEach(function () {
        requests = [];
        dom = new JSDOM(html, {
            url: 'https://host.test/',
            runScripts: 'dangerously',
            pretendToBeVisual: true,
            beforeParse(win) {
                win.XMLHttpRequest = FakeXHR;
                win.fetch = () => Promise.reject(new Error('offline')); // shorteners fail -> full URL is kept
            },
        });
        window = dom.window;
        document = window.document;
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

    it('uploads files one at a time with live progress, then moves links to history', async function () {
        pick('a.png', 'b.png');
        await tick();
        assert.deepStrictEqual(names(), ['a.png', 'b.png']);
        assert.strictEqual(requests.length, 1, 'second file waits for its turn');
        assert.strictEqual(label(1), 'Waiting');
        assert.ok(document.getElementById('tray').classList.contains('stacked'));

        requests[0].progress(50, 100);
        assert.strictEqual(rows()[0].querySelector('.job-pct').textContent, '50%');
        assert.strictEqual(document.getElementById('trayPct').textContent, '25%', 'combined: (50% + 0%) of two equal files');
        assert.strictEqual(document.getElementById('trayCount').textContent, '2');

        requests[0].ok('/file/AAAA1.png');
        await tick();
        assert.strictEqual(requests.length, 2);
        requests[1].ok('/file/BBBB2.png');
        await tick(20);

        assert.deepStrictEqual(history().map(e => e.url), ['https://host.test/file/BBBB2.png', 'https://host.test/file/AAAA1.png']);
        assert.ok(document.getElementById('history').classList.contains('visible'));
        assert.strictEqual(document.querySelectorAll('#historyList .result-item').length, 2);
    });

    it('cancels an upload in flight and lets the queue continue', async function () {
        pick('a.png', 'b.png');
        await tick();
        rows()[0].querySelector('.job-x').click();
        await tick();
        assert.ok(requests[0].aborted);
        assert.deepStrictEqual(names(), ['b.png']);
        assert.strictEqual(requests.length, 2, 'next file started');
        requests[1].ok('/file/BBBB2.png');
        await tick(20);
        assert.deepStrictEqual(history().map(e => e.url), ['https://host.test/file/BBBB2.png']);
    });

    it('cancels a waiting upload without ever sending it', async function () {
        pick('a.png', 'b.png');
        await tick();
        rows()[1].querySelector('.job-x').click();
        requests[0].ok('/file/AAAA1.png');
        await tick(20);
        assert.strictEqual(requests.length, 1);
        assert.strictEqual(history().length, 1);
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
});

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const inline = html => html.replace('<script src="/settings.js"></script>', () => `<script>${read('settings.js')}</script>`);

describe('settings', function () {
    function open(page, stored) {
        return new JSDOM(inline(read(page)), {
            url: 'https://host.test/' + (page === 'settings.html' ? 'settings' : ''),
            runScripts: 'dangerously',
            beforeParse(win) { if (stored !== undefined) win.localStorage.setItem('th_settings', stored); },
        }).window;
    }

    describe('settings.js', function () {
        it('falls back to defaults for missing, corrupt or hostile stored values', function () {
            for (const stored of [undefined, 'not json', 'null', '[]', '{"historyMax":"abc","shortener":"evil","concurrency":99}']) {
                const win = open('index.html', stored);
                const s = win.THSettings.load();
                assert.strictEqual(s.shortener, 'auto');
                assert.ok(s.concurrency >= 1 && s.concurrency <= 3);
                assert.ok(s.historyMax >= 0 && s.historyMax <= 500);
                win.close();
            }
        });

        it('clamps numbers and validates the custom template', function () {
            const win = open('index.html');
            const { normalize, validTemplate } = win.THSettings;
            assert.strictEqual(normalize({ historyMax: 9999 }).historyMax, 500);
            assert.strictEqual(normalize({ historyMax: -5 }).historyMax, 0);
            assert.strictEqual(normalize({ concurrency: 0 }).concurrency, 1);
            assert.ok(validTemplate('https://a.example/s?u={url}'));
            assert.ok(!validTemplate('http://a.example/s?u={url}'));
            assert.ok(!validTemplate('https://a.example/s'));
            assert.ok(!validTemplate('javascript:alert({url})'));
            assert.strictEqual(normalize({ shortener: 'custom', customShortener: 'nope' }).shortener, 'auto');
            win.close();
        });
    });

    describe('/settings page', function () {
        const change = (win, id, value) => {
            const el = win.document.getElementById(id);
            el.value = value;
            el.dispatchEvent(new win.Event('change', { bubbles: true }));
        };
        const stored = win => JSON.parse(win.localStorage.getItem('th_settings'));

        it('shows the current values and saves changes', function () {
            const win = open('settings.html', JSON.stringify({ historyMax: 30, shortener: 'tinyurl', concurrency: 3 }));
            const d = win.document;
            assert.strictEqual(d.getElementById('historyMax').value, '30');
            assert.strictEqual(d.getElementById('shortener').value, 'tinyurl');
            assert.strictEqual(d.getElementById('concurrency').value, '3');
            change(win, 'historyMax', '12');
            change(win, 'shortener', 'dagd');
            change(win, 'concurrency', '1');
            assert.deepStrictEqual(
                { h: stored(win).historyMax, s: stored(win).shortener, c: stored(win).concurrency },
                { h: 12, s: 'dagd', c: 1 }
            );
            win.close();
        });

        it('only saves a custom shortener that is https and contains {url}', function () {
            const win = open('settings.html');
            const d = win.document;
            change(win, 'shortener', 'custom');
            assert.ok(!d.getElementById('customRow').classList.contains('hidden'));
            change(win, 'customShortener', 'http://x.example/?u={url}');
            assert.ok(d.getElementById('customHint').classList.contains('error'));
            assert.notStrictEqual((stored(win) || {}).shortener, 'custom');
            change(win, 'customShortener', 'https://x.example/?u={url}');
            assert.ok(!d.getElementById('customHint').classList.contains('error'));
            assert.strictEqual(stored(win).shortener, 'custom');
            win.close();
        });

        it('turning history off also deletes the stored history', function () {
            const win = open('settings.html');
            win.localStorage.setItem('th_history', JSON.stringify([{ url: 'https://host.test/file/x', ts: 1 }]));
            change(win, 'historyMax', '0');
            assert.strictEqual(win.localStorage.getItem('th_history'), null);
            win.close();
        });

        it('clears history and partial uploads, and resets everything', function () {
            const win = open('settings.html', JSON.stringify({ historyMax: 5, concurrency: 3 }));
            win.localStorage.setItem('th_history', '[]');
            win.localStorage.setItem('th_resume:a:1:2:3', '{}');
            win.localStorage.setItem('th_mode', 'original');
            win.document.getElementById('clearHistory').click();
            win.document.getElementById('clearResume').click();
            assert.strictEqual(win.localStorage.getItem('th_history'), null);
            assert.strictEqual(win.localStorage.getItem('th_resume:a:1:2:3'), null);
            assert.strictEqual(win.localStorage.getItem('th_mode'), 'original', 'unrelated keys are untouched');
            win.document.getElementById('reset').click();
            assert.deepStrictEqual(stored(win), { historyMax: 100, shortener: 'auto', customShortener: '', concurrency: 2 });
            win.close();
        });

        it('is not linked from the main page', function () {
            assert.ok(!read('index.html').includes('href="/settings"'));
        });
    });
});

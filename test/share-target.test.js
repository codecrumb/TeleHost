const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const root = f => path.join(__dirname, '..', f);
const read = f => fs.readFileSync(root(f), 'utf8');

describe('Android share target', function () {
    describe('manifest', function () {
        const manifest = JSON.parse(read('manifest.webmanifest'));

        it('is installable and declares a file share target', function () {
            assert.strictEqual(manifest.start_url, '/');
            assert.strictEqual(manifest.display, 'standalone');
            assert.ok(manifest.name && manifest.short_name);
            assert.deepStrictEqual(manifest.share_target, {
                action: '/share-target',
                method: 'POST',
                enctype: 'multipart/form-data',
                params: { files: [{ name: 'files', accept: ['*/*'] }] },
            });
        });

        it('points at icons that exist, including 192 and 512', function () {
            const sizes = manifest.icons.map(i => i.sizes);
            assert.ok(sizes.includes('192x192') && sizes.includes('512x512'));
            for (const icon of manifest.icons) assert.ok(fs.existsSync(root(icon.src.replace(/^\//, ''))), icon.src);
        });

        it('is linked from the page, which also registers the worker', function () {
            const html = read('index.html');
            assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
            assert.match(html, /serviceWorker\.register\('\/sw\.js'\)/);
        });
    });

    describe('service worker', function () {
        let listeners, store, ctx;

        function boot() {
            listeners = {};
            store = new Map();
            const cache = {
                keys: async () => Array.from(store.keys()).map(url => new Request(url)),
                delete: async request => store.delete(request.url),
                put: async (request, response) => { store.set(request.url, response); },
            };
            ctx = {
                self: {
                    location: new URL('https://host.test/sw.js'),
                    addEventListener: (type, fn) => { listeners[type] = fn; },
                    skipWaiting: () => {},
                    clients: { claim: async () => {} },
                },
                caches: { open: async () => cache },
                Request, Response, URL, File, Blob, FormData, encodeURIComponent,
            };
            vm.createContext(ctx);
            vm.runInContext(read('sw.js'), ctx);
        }

        beforeEach(boot);

        async function dispatch(request) {
            let answered;
            listeners.fetch({ request, respondWith: p => { answered = p; } });
            return answered ? await answered : null;
        }

        const post = (files, url = 'https://host.test/share-target') => {
            const body = new FormData();
            for (const f of files) body.append('files', f);
            return new Request(url, { method: 'POST', body });
        };

        it('parks shared files in a cache and redirects to the upload page', async function () {
            const res = await dispatch(post([
                new File(['hello'], 'שלום photo.png', { type: 'image/png' }),
                new File(['x'], 'notes', { type: '' }),
            ]));
            assert.strictEqual(res.status, 303);
            assert.strictEqual(res.headers.get('Location'), 'https://host.test/?shared=2');
            assert.strictEqual(store.size, 2);
            const first = store.get('https://host.test/shared/0');
            assert.strictEqual(first.headers.get('Content-Type'), 'image/png');
            assert.strictEqual(decodeURIComponent(first.headers.get('X-File-Name')), 'שלום photo.png');
            assert.strictEqual(await first.text(), 'hello');
            assert.strictEqual(store.get('https://host.test/shared/1').headers.get('Content-Type'), 'application/octet-stream');
        });

        it('replaces the leftovers of an earlier share instead of mixing them in', async function () {
            await dispatch(post([new File(['a'], 'a.txt'), new File(['b'], 'b.txt')]));
            await dispatch(post([new File(['c'], 'c.txt')]));
            assert.strictEqual(store.size, 1);
        });

        it('caps the number of files', async function () {
            const files = Array.from({ length: 60 }, (_, i) => new File(['x'], `f${i}.txt`));
            const res = await dispatch(post(files));
            assert.strictEqual(res.headers.get('Location'), 'https://host.test/?shared=50');
        });

        it('reports an error when nothing usable arrives', async function () {
            const res = await dispatch(post([]));
            assert.strictEqual(res.headers.get('Location'), 'https://host.test/?shared=error');
        });

        it('leaves every other request alone', async function () {
            assert.strictEqual(await dispatch(new Request('https://host.test/share-target')), null, 'GET');
            assert.strictEqual(await dispatch(new Request('https://host.test/upload', { method: 'POST', body: new FormData() })), null, 'other POST');
            assert.strictEqual(await dispatch(new Request('https://host.test/')), null, 'page');
            assert.strictEqual(await dispatch(post([new File(['x'], 'x')], 'https://evil.test/share-target')), null, 'other origin');
        });
    });

    describe('fallback route', function () {
        it('sends a share that reached the server (no worker yet) back with an explanation', async function () {
            const { onRequest } = await import('../functions/share-target.js');
            const res = onRequest({ request: new Request('https://host.test/share-target', { method: 'POST' }) });
            assert.strictEqual(res.status, 303);
            assert.strictEqual(res.headers.get('Location'), 'https://host.test/?shared=unavailable');
        });
    });

    describe('upload page intake', function () {
        const settingsJs = read('settings.js');
        const html = read('index.html').replace('<script src="/settings.js"></script>', () => `<script>${settingsJs}</script>`);
        const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
        let requests;

        class FakeXHR {
            constructor() { this.upload = {}; requests.push(this); }
            open() {}
            send(body) { this.body = body; }
            abort() {}
        }

        function open(query, entries, answer) {
            requests = [];
            const confirms = [];
            const cache = new Map(entries.map((e, i) => [`https://host.test/shared/${i}`, e]));
            const dom = new JSDOM(html, {
                url: `https://host.test/${query}`,
                runScripts: 'dangerously',
                pretendToBeVisual: true,
                beforeParse(win) {
                    win.XMLHttpRequest = FakeXHR;
                    win.fetch = () => Promise.reject(new Error('offline'));
                    win.confirm = message => { confirms.push(message); return answer; };
                    win.caches = {
                        open: async () => ({
                            keys: async () => Array.from(cache.keys()).map(url => ({ url })),
                            match: async req => cache.get(req.url),
                            delete: async req => cache.delete(req.url),
                        }),
                    };
                },
            });
            return { win: dom.window, doc: dom.window.document, confirms, cache };
        }

        const shared = (name, body, type) => new Response(body, {
            headers: { 'Content-Type': type, 'X-File-Name': encodeURIComponent(name) },
        });

        it('asks first, then uploads the shared files through the normal queue, with their names', async function () {
            const { win, doc, confirms } = open('?shared=2',
                [shared('a b.png', 'AAA', 'image/png'), shared('שלום.txt', 'BBB', 'text/plain')], true);
            await tick(50);
            assert.strictEqual(confirms.length, 1);
            assert.match(confirms[0], /Upload 2 shared files\?/);
            assert.match(confirms[0], /a b\.png/);
            assert.strictEqual(requests.length, 2);
            assert.deepStrictEqual(
                requests.map(r => r.body.get('file').name).sort(),
                ['a b.png', 'שלום.txt'].sort()
            );
            assert.strictEqual(win.location.search, '', 'the ?shared flag is removed from the address');
            assert.strictEqual(doc.querySelectorAll('#trayList .job').length, 2);
            win.close();
        });

        it('uploads nothing when the user declines, and still clears the parked files', async function () {
            const { win, cache } = open('?shared=1', [shared('x.png', 'XXX', 'image/png')], false);
            await tick(50);
            assert.strictEqual(requests.length, 0);
            assert.strictEqual(cache.size, 0);
            win.close();
        });

        it('explains when the share reached the server instead of the worker', async function () {
            const { win, doc, confirms } = open('?shared=unavailable', [], true);
            await tick(30);
            assert.strictEqual(confirms.length, 0);
            assert.match(doc.querySelector('#trayList .job-label').textContent, /Sharing is ready after the app has been opened once/);
            win.close();
        });

        it('does nothing on a normal page load', async function () {
            const { win, confirms } = open('', [shared('x.png', 'XXX', 'image/png')], true);
            await tick(30);
            assert.strictEqual(confirms.length, 0);
            assert.strictEqual(requests.length, 0);
            win.close();
        });
    });
});

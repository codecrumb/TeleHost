const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
const { JSDOM } = require('jsdom');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const until = async (fn, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 10)); }
    throw new Error('timed out waiting for: ' + fn);
};

// Browser encrypts the parts -> real /upload, /finalize, /s handlers -> real viewer page.
describe('big file end to end: encrypt, upload parts, finalize, download, decrypt', function () {
    this.timeout(20000);
    const env = { TG_Bot_Token: 'SECRET:TOKEN', TG_Chat_ID: '-100' };
    const manifestId = 'M'.repeat(30);
    const realFetch = global.fetch;
    let store, nextId, nextMsg, partFetches;

    beforeEach(function () {
        store = {};
        nextId = 0;
        nextMsg = 100;
        partFetches = [];
        global.fetch = async (url, init = {}) => {
            url = String(url);
            if (url.includes('/getFile')) {
                const id = new URL(url).searchParams.get('file_id');
                return store[id] ? Response.json({ ok: true, result: { file_path: `f/${id}` } }) : Response.json({ ok: false }, { status: 400 });
            }
            if (url.includes('/file/bot')) return new Response(store[url.split('/f/')[1]]);
            if (url.includes('/deleteMessage')) return Response.json({ ok: true });
            const doc = init.body.get('document');
            const id = doc.name === 'link.bin' ? manifestId : `P${++nextId}`.padEnd(30, 'x');
            store[id] = new Uint8Array(await doc.arrayBuffer());
            return Response.json({ ok: true, result: { message_id: nextMsg++, document: { file_id: id } } });
        };
    });
    afterEach(function () { global.fetch = realFetch; });

    function browserEncryptor() {
        const html = read('index.html');
        const src = html.slice(html.indexOf('const PBKDF2_ITER'), html.indexOf('// Grab a frame about'));
        const factory = new Function('window', 'crypto', 'File', 'btoa', `${src}; return makePartEncryptor;`);
        return factory({ crypto: webcrypto }, webcrypto, File, btoa);
    }

    async function uploadParts(chunks, encrypt) {
        const { onRequestPost } = await import('../functions/upload.js');
        const receipts = [];
        for (let i = 0; i < chunks.length; i++) {
            const bytes = new TextEncoder().encode(chunks[i]);
            const body = new FormData();
            body.append('file', new File([encrypt ? await encrypt(bytes, i) : bytes], `part${i}.bin`, { type: 'application/octet-stream' }));
            body.append('part', '1');
            const res = await onRequestPost({ request: new Request('https://x.test/upload', { method: 'POST', body }), env });
            receipts.push((await res.json())[0].receipt);
        }
        return receipts;
    }

    async function finalize(payload) {
        const { onRequestPost } = await import('../functions/finalize.js');
        const res = await onRequestPost({ request: new Request('https://x.test/finalize', { method: 'POST', body: JSON.stringify(payload) }), env });
        assert.strictEqual(res.status, 200, await res.clone().text());
    }

    async function openViewer(settings) {
        const { onRequest } = await import('../functions/s/[id].js');
        const created = [];
        const clicks = [];
        const html = read('unlock.html').replace('<script src="/settings.js"></script>', () => `<script>${read('settings.js')}</script>`);
        const dom = new JSDOM(html, {
            url: `https://x.test/s/${manifestId}`,
            runScripts: 'dangerously',
            pretendToBeVisual: true,
            beforeParse(win) {
                if (settings) win.localStorage.setItem('th_settings', JSON.stringify(settings));
                win.HTMLAnchorElement.prototype.click = function () { clicks.push(this.download); };
                Object.defineProperty(win, 'crypto', { value: webcrypto, configurable: true });
                win.URL.createObjectURL = blob => { created.push(blob); return `blob:${created.length}`; };
                win.URL.revokeObjectURL = () => {};
                win.fetch = async (u) => {
                    const url = new URL(u, 'https://x.test');
                    if (url.searchParams.has('part')) partFetches.push(Number(url.searchParams.get('part')));
                    return onRequest({ request: new Request(url), env: { ...env, ASSETS: { fetch: async () => new Response('') } }, params: { id: manifestId } });
                };
            },
        });
        return { win: dom.window, doc: dom.window.document, created, clicks };
    }

    const text = el => el.textContent;

    it('round-trips a password-protected multi-part file, and fails fast on a wrong password', async function () {
        const chunks = ['AAAA', 'BBBB', 'CC'];
        const encryptor = await browserEncryptor()('correct horse');
        const receipts = await uploadParts(chunks, encryptor.encrypt);
        assert.ok(!Buffer.from(store[receipts[0].fileId]).includes('AAAA'), 'only ciphertext is stored');
        await finalize({ receipts, name: 'notes.txt', type: 'text/plain', size: 10, enc: encryptor.params });

        const { win, doc, created } = await openViewer();
        await until(() => !doc.getElementById('form').classList.contains('hidden'));
        assert.strictEqual(text(doc.getElementById('name')), 'notes.txt');
        assert.match(text(doc.getElementById('meta')), /3 parts/);

        const submit = async password => {
            doc.getElementById('password').value = password;
            doc.getElementById('form').dispatchEvent(new win.Event('submit', { cancelable: true }));
            await new Promise(r => setTimeout(r, 20));
        };

        await submit('wrong password');
        await until(() => /Wrong password/.test(text(doc.getElementById('status'))));
        assert.deepStrictEqual(partFetches, [0], 'only the first part was downloaded to check the password');

        await submit('correct horse');
        await until(() => !doc.getElementById('result').classList.contains('hidden'));
        assert.deepStrictEqual(partFetches, [0, 1, 2], 'first part is reused, the rest follow in order');

        doc.getElementById('download').click();
        assert.strictEqual(await created[created.length - 1].text(), 'AAAABBBBCC');
        assert.strictEqual(doc.getElementById('pRight').textContent, '100%');
    });

    it('round-trips an expiring (unencrypted) multi-part file with no password prompt', async function () {
        const receipts = await uploadParts(['one-', 'two-', 'three']);
        await finalize({ receipts, name: 'a.bin', type: 'application/octet-stream', size: 13, expiresIn: 3600 });

        const { doc, created } = await openViewer();
        await until(() => !doc.getElementById('result').classList.contains('hidden'));
        assert.ok(doc.getElementById('form').classList.contains('hidden'));
        doc.getElementById('download').click();
        assert.strictEqual(await created[created.length - 1].text(), 'one-two-three');
    });

    it('shows a clear message once the link has expired', async function () {
        const receipts = await uploadParts(['x', 'y']);
        await finalize({ receipts, name: 'a.bin', type: '', size: 2, expiresIn: 60 });
        const { openManifest, sealManifest } = await import('../functions/_lib/manifest.js');
        const manifest = await openManifest(env, store[manifestId]);
        store[manifestId] = await sealManifest(env, { ...manifest, exp: Date.now() - 1 });

        const { doc } = await openViewer();
        await until(() => /expired/.test(text(doc.getElementById('status'))));
        assert.ok(doc.getElementById('status').classList.contains('error'));
    });

    describe('after unlocking', function () {
        async function publishAndOpen(type, name, settings) {
            const receipts = await uploadParts(['ab', 'cd']);
            await finalize({ receipts, name, type, size: 4, expiresIn: 3600 });
            const viewer = await openViewer(settings);
            await until(() => !viewer.doc.getElementById('result').classList.contains('hidden'));
            return viewer;
        }

        async function unlockEncrypted(type, name, settings) {
            const encryptor = await browserEncryptor()('pw');
            const receipts = await uploadParts(['ab', 'cd'], encryptor.encrypt);
            await finalize({ receipts, name, type, size: 4, enc: encryptor.params });
            const viewer = await openViewer(settings);
            await until(() => !viewer.doc.getElementById('form').classList.contains('hidden'));
            viewer.doc.getElementById('password').value = 'pw';
            viewer.doc.getElementById('form').dispatchEvent(new viewer.win.Event('submit', { cancelable: true }));
            await until(() => !viewer.doc.getElementById('result').classList.contains('hidden'));
            return viewer;
        }

        it('smart (the default) downloads a file right after a password is entered', async function () {
            const { doc, clicks } = await unlockEncrypted('application/zip', 'bundle.zip');
            assert.deepStrictEqual(clicks, ['bundle.zip']);
            assert.strictEqual(doc.getElementById('status').textContent, 'Download started.');
        });

        it('smart shows a photo after a password unlock instead of downloading it', async function () {
            const { doc, clicks } = await unlockEncrypted('image/png', 'pic.png');
            assert.deepStrictEqual(clicks, []);
            assert.ok(doc.querySelector('#previewBox img'));
        });

        it('smart never starts a download by itself for a link that needs no password', async function () {
            const { doc, clicks } = await publishAndOpen('application/zip', 'bundle.zip');
            assert.deepStrictEqual(clicks, [], 'merely opening a link must not download anything');
            doc.getElementById('download').click();
            assert.deepStrictEqual(clicks, ['bundle.zip']);
        });

        it('never leaves a password-unlocked file to the button too', async function () {
            const { doc, clicks } = await unlockEncrypted('application/zip', 'bundle.zip', { autoDownload: 'never' });
            assert.deepStrictEqual(clicks, []);
            doc.getElementById('download').click();
            assert.deepStrictEqual(clicks, ['bundle.zip']);
        });

        it('smart shows a photo instead of downloading it, and the button still works', async function () {
            const { doc, clicks } = await publishAndOpen('image/png', 'pic.png');
            assert.deepStrictEqual(clicks, []);
            assert.ok(doc.querySelector('#previewBox img'));
            doc.getElementById('download').click();
            assert.deepStrictEqual(clicks, ['pic.png']);
        });

        it('always downloads, even something it also previews, and even without a password', async function () {
            const { clicks } = await publishAndOpen('image/png', 'pic.png', { autoDownload: 'always' });
            assert.deepStrictEqual(clicks, ['pic.png']);
        });
    });
});

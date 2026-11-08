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
            const id = doc.name === 'link.json' ? manifestId : `P${++nextId}`.padEnd(30, 'x');
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

    async function openViewer() {
        const { onRequest } = await import('../functions/s/[id].js');
        const created = [];
        const dom = new JSDOM(read('unlock.html'), {
            url: `https://x.test/s/${manifestId}`,
            runScripts: 'dangerously',
            pretendToBeVisual: true,
            beforeParse(win) {
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
        return { win: dom.window, doc: dom.window.document, created };
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
        const manifest = JSON.parse(Buffer.from(store[manifestId]).toString());
        manifest.exp = Date.now() - 1;
        const { signManifest } = await import('../functions/_lib/manifest.js');
        store[manifestId] = new TextEncoder().encode(JSON.stringify(await signManifest(env, { ...manifest, sig: undefined })));

        const { doc } = await openViewer();
        await until(() => /expired/.test(text(doc.getElementById('status'))));
        assert.ok(doc.getElementById('status').classList.contains('error'));
    });
});

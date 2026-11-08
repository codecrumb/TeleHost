const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// Slice a top-level function/const out of a page script by its first line.
function slice(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    assert.ok(start >= 0, `marker not found: ${startMarker}`);
    const end = source.indexOf(endMarker, start);
    assert.ok(end > start, `end marker not found: ${endMarker}`);
    return source.slice(start, end);
}

describe('password protection', function () {
    const env = { TG_Bot_Token: 'SECRET:TOKEN', TG_Chat_ID: '-100' };
    const realFetch = global.fetch;
    const cipherId = 'C'.repeat(30);
    const manifestId = 'M'.repeat(30);
    let stored; // what Telegram "holds"

    beforeEach(function () {
        stored = {};
        global.fetch = async (url, init = {}) => {
            url = String(url);
            if (url.includes('/getFile')) {
                const id = new URL(url).searchParams.get('file_id');
                return Response.json({ ok: true, result: { file_path: id === manifestId ? 'm.json' : 'c.bin' } });
            }
            if (url.includes('/file/bot')) {
                return new Response(url.endsWith('m.json') ? stored.manifest : stored.cipher);
            }
            const body = init.body;
            const doc = body.get('document');
            if (doc.name === 'link.json') {
                stored.manifest = await doc.text();
                return Response.json({ ok: true, result: { message_id: 6, document: { file_id: manifestId } } });
            }
            stored.cipher = new Uint8Array(await doc.arrayBuffer());
            stored.cipherName = doc.name;
            return Response.json({ ok: true, result: { message_id: 5, document: { file_id: cipherId } } });
        };
    });
    afterEach(function () { global.fetch = realFetch; });

    async function browserEncrypt(plaintext, password) {
        const src = slice(read('index.html'), 'const PBKDF2_ITER', '// Grab a frame about');
        const factory = new Function('window', 'crypto', 'File', 'btoa', `${src}; return encryptFile;`);
        const encryptFile = factory({ crypto: globalThis.crypto }, globalThis.crypto, File, btoa);
        return encryptFile(new File([plaintext], 'secret.txt', { type: 'text/plain' }), password);
    }

    async function uploadEncrypted(extra = {}) {
        const { file, fields } = await browserEncrypt('top secret bytes', 'hunter2');
        const body = new FormData();
        body.append('file', file);
        for (const [k, v] of Object.entries({ ...fields, ...extra })) body.append(k, v);
        const { onRequestPost } = await import('../functions/upload.js');
        const res = await onRequestPost({ request: new Request('https://x.test/upload', { method: 'POST', body }), env });
        return { res, fields };
    }

    async function visit(query = '') {
        const { onRequest } = await import('../functions/s/[id].js');
        const env2 = { ...env, ASSETS: { fetch: async () => new Response('<html>unlock</html>') } };
        const id = manifestId;
        return onRequest({ request: new Request(`https://x.test/s/${id}${query}`), env: env2, params: { id } });
    }

    it('uploads only ciphertext and returns an extensionless /s link', async function () {
        const { res } = await uploadEncrypted();
        const data = await res.json();
        assert.strictEqual(data[0].src, `/s/${manifestId}`);
        assert.strictEqual(stored.cipherName, 'encrypted.bin');
        assert.ok(!Buffer.from(stored.cipher).includes('top secret'));
        const manifest = JSON.parse(stored.manifest);
        assert.strictEqual(manifest.name, 'secret.txt');
        assert.strictEqual(manifest.enc.alg, 'AES-GCM');
        assert.strictEqual(manifest.exp, undefined);
    });

    it('serves the unlock page, meta, and ciphertext; the unlock page can decrypt it', async function () {
        await uploadEncrypted();

        const page = await visit();
        assert.strictEqual(page.headers.get('Content-Type'), 'text/html;charset=UTF-8');

        const meta = await (await visit('?meta=1')).json();
        assert.strictEqual(meta.name, 'secret.txt');
        assert.ok(!('fileId' in meta));

        const raw = await visit('?raw=1');
        assert.strictEqual(raw.headers.get('Content-Type'), 'application/octet-stream');
        const cipher = await raw.arrayBuffer();

        const html = read('unlock.html');
        const unb64 = slice(html, 'function unb64', 'var id =');
        const decryptSrc = slice(html, 'async function decrypt', 'form.addEventListener');
        const factory = new Function('crypto', 'atob', 'TextEncoder', 'fetch', 'id',
            `var info, cipher; ${unb64}; ${decryptSrc}; return { set: function (i, c) { info = i; cipher = c; }, decrypt: decrypt, decryptPart: decryptPart };`);
        const page2 = factory(globalThis.crypto, atob, TextEncoder, null, manifestId);
        page2.set(meta, cipher);

        const plain = await page2.decrypt('hunter2');
        assert.strictEqual(Buffer.from(plain).toString(), 'top secret bytes');
        await assert.rejects(() => page2.decrypt('wrong'), /Wrong password/);
    });

    it('still honours expiry on password links', async function () {
        await uploadEncrypted({ expiresIn: '60' });
        const manifest = JSON.parse(stored.manifest);
        assert.ok(manifest.exp > Date.now());
        manifest.exp = Date.now() - 1;
        const { signManifest } = await import('../functions/_lib/manifest.js');
        stored.manifest = JSON.stringify(await signManifest(env, { ...manifest, sig: undefined }));
        assert.strictEqual((await visit('?meta=1')).status, 410);
        assert.strictEqual((await visit('?raw=1')).status, 410);
    });

    it('rejects absurd key-derivation parameters', async function () {
        const { res } = await uploadEncrypted({ encIter: '99999999' });
        assert.strictEqual(res.status, 500);
        assert.strictEqual(stored.cipher, undefined);
    });
});

const assert = require('assert');

describe('/upload caption', function () {
    const env = { TG_Bot_Token: 't', TG_Chat_ID: '-1' };
    const realFetch = global.fetch;
    let sent;

    beforeEach(function () {
        sent = [];
        global.fetch = async (url, init) => {
            sent.push(init.body);
            return Response.json({ ok: true, result: { document: { file_id: 'F'.repeat(30) } } });
        };
    });
    afterEach(function () { global.fetch = realFetch; });

    async function upload(extraEnv, headers = {}) {
        const { onRequestPost } = await import('../functions/upload.js');
        const body = new FormData();
        body.append('file', new File(['hi'], 'a.txt', { type: 'text/plain' }));
        const request = new Request('https://x.test/upload', { method: 'POST', body, headers });
        const res = await onRequestPost({ request, env: { ...env, ...extraEnv } });
        assert.strictEqual(res.status, 200);
        return sent[0].get('caption');
    }

    it('adds no caption by default', async function () {
        assert.strictEqual(await upload({}, { 'CF-Connecting-IP': '1.2.3.4' }), null);
    });

    it('adds the IP when LOG_UPLOADER_IP=true', async function () {
        assert.strictEqual(await upload({ LOG_UPLOADER_IP: 'true' }, { 'CF-Connecting-IP': '1.2.3.4' }), 'Uploader: 1.2.3.4');
    });

    it('ignores X-Forwarded-For', async function () {
        assert.strictEqual(await upload({ LOG_UPLOADER_IP: 'true' }, { 'X-Forwarded-For': '9.9.9.9' }), null);
    });
});

describe('/upload expiry', function () {
    const env = { TG_Bot_Token: 't', TG_Chat_ID: '-1' };
    const realFetch = global.fetch;
    let sends;

    beforeEach(function () {
        sends = [];
        global.fetch = async (url, init) => {
            const kind = String(url).split('/').pop();
            sends.push({ kind, body: init.body });
            const id = (kind === 'sendDocument' && init.body.get('document').name === 'link.bin') ? 'M'.repeat(30) : 'F'.repeat(30);
            return Response.json({ ok: true, result: { message_id: 5, document: { file_id: id } } });
        };
    });
    afterEach(function () { global.fetch = realFetch; });

    async function upload(expiresIn) {
        const { onRequestPost } = await import('../functions/upload.js');
        const body = new FormData();
        body.append('file', new File(['hi'], 'a.txt', { type: 'text/plain' }));
        if (expiresIn !== undefined) body.append('expiresIn', expiresIn);
        const request = new Request('https://x.test/upload', { method: 'POST', body });
        return onRequestPost({ request, env });
    }

    it('keeps normal uploads on /file with no manifest', async function () {
        const data = await (await upload()).json();
        assert.strictEqual(data[0].src, `/file/${'F'.repeat(30)}.txt`);
        assert.strictEqual(sends.length, 1);
    });

    it('returns a sealed /s link for expiring uploads', async function () {
        const data = await (await upload('3600')).json();
        assert.strictEqual(data[0].src, `/s/${'M'.repeat(30)}.txt`);
        const { openManifest } = await import('../functions/_lib/manifest.js');
        const bytes = new Uint8Array(await sends[1].body.get('document').arrayBuffer());
        const manifest = await openManifest(env, bytes);
        assert.strictEqual(manifest.fileId, 'F'.repeat(30));
        assert.strictEqual(manifest.msgId, 5);
        assert.ok(!Buffer.from(bytes).includes('F'.repeat(30)), 'sealed, not readable');
    });

    it('rejects out-of-range expiry', async function () {
        assert.strictEqual((await upload('5')).status, 500);
        assert.strictEqual(sends.length, 0);
    });
});

describe('Telegram rate limiting', function () {
    const env = { TG_Bot_Token: 't', TG_Chat_ID: '-1' };
    const realFetch = global.fetch;
    afterEach(function () { global.fetch = realFetch; });

    it('answers 429 with Retry-After instead of sleeping or failing', async function () {
        const calls = [];
        global.fetch = async url => {
            calls.push(String(url).split('/').pop());
            return Response.json({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 12', parameters: { retry_after: 12 } }, { status: 429 });
        };
        const { onRequestPost } = await import('../functions/upload.js');
        const body = new FormData();
        body.append('file', new File(['x'], 'a.png', { type: 'image/png' }));
        const started = Date.now();
        const res = await onRequestPost({ request: new Request('https://x.test/upload', { method: 'POST', body }), env });
        assert.strictEqual(res.status, 429);
        assert.strictEqual(res.headers.get('Retry-After'), '12');
        assert.strictEqual((await res.json()).retryAfter, 12);
        assert.deepStrictEqual(calls, ['sendPhoto'], 'no immediate document fallback on a rate limit');
        assert.ok(Date.now() - started < 500, 'the worker does not sleep');
    });

    it('/file and /s answer 429 when getFile is rate limited', async function () {
        global.fetch = async () => Response.json({ ok: false, error_code: 429, parameters: { retry_after: 7 } }, { status: 429 });
        const id = 'A'.repeat(30);
        const { onRequest: file } = await import('../functions/file/[id].js');
        const res = await file({ request: new Request(`https://x.test/file/${id}.png`), env, params: { id: `${id}.png` } });
        assert.strictEqual(res.status, 429);
        assert.strictEqual(res.headers.get('Retry-After'), '7');
        const { onRequest: share } = await import('../functions/s/[id].js');
        const res2 = await share({ request: new Request(`https://x.test/s/${id}`), env, params: { id } });
        assert.strictEqual(res2.status, 429);
    });
});

describe('/upload link extension', function () {
    const realFetch = global.fetch;
    beforeEach(function () {
        global.fetch = async () => Response.json({ ok: true, result: { document: { file_id: 'F'.repeat(30) } } });
    });
    afterEach(function () { global.fetch = realFetch; });

    async function srcFor(name) {
        const { onRequestPost } = await import('../functions/upload.js');
        const body = new FormData();
        body.append('file', new File(['hi'], name, { type: 'text/plain' }));
        const res = await onRequestPost({ request: new Request('https://x.test/upload', { method: 'POST', body }), env: { TG_Bot_Token: 't', TG_Chat_ID: '-1' } });
        return (await res.json())[0].src;
    }

    it('keeps a normal extension, lower-cased', async function () {
        assert.strictEqual(await srcFor('Photo.JPG'), `/file/${'F'.repeat(30)}.jpg`);
    });

    it('never lets a crafted name put odd characters or path segments in the link', async function () {
        for (const name of ['x.<b>', 'x.y/../../v/abc', 'x.%2e%2e', 'README', 'archive.verylongext', 'x.\u05e2\u05d1']) {
            assert.strictEqual(await srcFor(name), `/file/${'F'.repeat(30)}.bin`, name);
        }
    });
});

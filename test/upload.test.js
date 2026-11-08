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
            const id = (kind === 'sendDocument' && init.body.get('document').name === 'link.json') ? 'M'.repeat(30) : 'F'.repeat(30);
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

    it('returns a signed /s link for expiring uploads', async function () {
        const data = await (await upload('3600')).json();
        assert.strictEqual(data[0].src, `/s/${'M'.repeat(30)}.txt`);
        const manifest = JSON.parse(await sends[1].body.get('document').text());
        assert.strictEqual(manifest.fileId, 'F'.repeat(30));
        assert.strictEqual(manifest.msgId, 5);
        assert.ok(manifest.sig);
    });

    it('rejects out-of-range expiry', async function () {
        assert.strictEqual((await upload('5')).status, 500);
        assert.strictEqual(sends.length, 0);
    });
});

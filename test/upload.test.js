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

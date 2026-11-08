const assert = require('assert');

describe('/s/:id expiring links', function () {
    const env = { TG_Bot_Token: 'SECRET:TOKEN', TG_Chat_ID: '-100' };
    const manifestId = 'M'.repeat(30);
    const fileId = 'F'.repeat(30);
    const realFetch = global.fetch;
    let calls;
    let manifestBody;

    beforeEach(function () {
        calls = [];
        global.fetch = async (url, init = {}) => {
            url = String(url);
            calls.push({ url, init });
            if (url.includes('/deleteMessage')) return Response.json({ ok: true });
            if (url.includes('/getFile')) {
                const id = new URL(url).searchParams.get('file_id');
                return Response.json({ ok: true, result: { file_path: id === manifestId ? 'documents/m.json' : 'videos/v.mp4' } });
            }
            if (url.endsWith('documents/m.json')) return new Response(manifestBody);
            return new Response('video-bytes', { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
        };
    });
    afterEach(function () { global.fetch = realFetch; });

    async function setManifest(patch = {}, tamper = {}) {
        const { signManifest } = await import('../functions/_lib/manifest.js');
        const signed = await signManifest(env, {
            v: 1, fileId, msgId: 7, name: 'clip.mp4', type: 'video/mp4', size: 11,
            exp: Date.now() + 60000, ...patch,
        });
        manifestBody = JSON.stringify({ ...signed, ...tamper });
    }

    async function open(id = `${manifestId}.mp4`) {
        const { onRequest } = await import('../functions/s/[id].js');
        return onRequest({ request: new Request(`https://x.test/s/${id}`), env, params: { id } });
    }

    it('serves the file before expiry and hides the real file id', async function () {
        await setManifest();
        const res = await open();
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.headers.get('Content-Type'), 'video/mp4');
        assert.strictEqual(await res.text(), 'video-bytes');
        assert.ok(!calls.some(c => c.url.includes('/deleteMessage')));
    });

    it('returns 410 and deletes the message after expiry', async function () {
        await setManifest({ exp: Date.now() - 1 });
        const res = await open();
        assert.strictEqual(res.status, 410);
        const del = calls.find(c => c.url.includes('/deleteMessage'));
        assert.deepStrictEqual(JSON.parse(del.init.body), { chat_id: '-100', message_id: 7 });
    });

    it('rejects a manifest whose fields were edited', async function () {
        await setManifest({}, { msgId: 99, exp: Date.now() + 1e9 });
        const res = await open();
        assert.strictEqual(res.status, 404);
        assert.ok(!calls.some(c => c.url.includes('/deleteMessage')));
    });

    it('rejects an unsigned manifest', async function () {
        manifestBody = JSON.stringify({ v: 1, fileId, msgId: 1, exp: 1 });
        assert.strictEqual((await open()).status, 404);
        assert.ok(!calls.some(c => c.url.includes('/deleteMessage')));
    });
});

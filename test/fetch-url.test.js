const assert = require('assert');

describe('/fetch-url', function () {
    const env = { TG_Bot_Token: 't', TG_Chat_ID: '-1', LINK_SECRET: 's'.repeat(40) };
    const realFetch = global.fetch;
    let sends, telegram;

    beforeEach(function () {
        sends = [];
        telegram = null; // set to override Telegram's answer
        global.fetch = async (url, init) => {
            const kind = String(url).split('/').pop();
            sends.push({ kind, body: init.body });
            if (telegram) return telegram;
            const isManifest = kind === 'sendDocument' && typeof init.body.get('document') !== 'string';
            return Response.json({ ok: true, result: {
                message_id: 5,
                document: { file_id: (isManifest ? 'M' : 'F').repeat(30), file_name: 'cat.jpg', mime_type: 'image/jpeg', file_size: 1234 },
            } });
        };
    });
    afterEach(function () { global.fetch = realFetch; });

    async function post(payload, { extraEnv = {}, headers = {} } = {}) {
        const { onRequestPost } = await import('../functions/fetch-url.js');
        const request = new Request('https://x.test/fetch-url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: typeof payload === 'string' ? payload : JSON.stringify(payload),
        });
        return onRequestPost({ request, env: { ...env, ...extraEnv } });
    }

    it('hands the link to Telegram and returns a /file link', async function () {
        const res = await post({ url: 'https://example.com/a/cat.jpg' });
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(await res.json(), [{ src: `/file/${'F'.repeat(30)}.jpg` }]);
        assert.strictEqual(sends.length, 1);
        assert.strictEqual(sends[0].kind, 'sendDocument');
        assert.strictEqual(sends[0].body.get('document'), 'https://example.com/a/cat.jpg');
        assert.strictEqual(sends[0].body.get('caption'), null);
    });

    it('seals a manifest for an expiring link', async function () {
        const res = await post({ url: 'https://example.com/cat.jpg', expiresIn: 3600 });
        assert.strictEqual(res.status, 200);
        const [item] = await res.json();
        assert.strictEqual(item.src, `/s/${'M'.repeat(30)}.jpg`);
        assert.ok(item.expires > Date.now());
        assert.strictEqual(sends.length, 2); // the file, then link.bin
    });

    it('refuses an expiring link without a usable LINK_SECRET, before sending anything', async function () {
        const res = await post({ url: 'https://example.com/cat.jpg', expiresIn: 3600 }, { extraEnv: { LINK_SECRET: 'short' } });
        assert.strictEqual(res.status, 500);
        assert.strictEqual(sends.length, 0);
    });

    it('rejects anything but a plain http(s) link', async function () {
        for (const url of ['ftp://example.com/a', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url',
            'https://user:pw@example.com/a', 'https://example.com/' + 'a'.repeat(2100), 42, null]) {
            const res = await post({ url });
            assert.strictEqual(res.status, 400, String(url).slice(0, 40));
        }
        assert.strictEqual((await post('not json')).status, 400);
        assert.strictEqual((await post({ url: 'https://example.com/a', expiresIn: 5 })).status, 400);
        assert.strictEqual(sends.length, 0);
    });

    it('picks the extension from the mime type when the name has none', async function () {
        telegram = Response.json({ ok: true, result: { message_id: 5, document: { file_id: 'F'.repeat(30), file_name: 'download', mime_type: 'video/mp4' } } });
        const [item] = await (await post({ url: 'https://example.com/get?id=1' })).json();
        assert.strictEqual(item.src, `/file/${'F'.repeat(30)}.mp4`);
    });

    it('reads the name and type of a link Telegram turned into a video message', async function () {
        telegram = Response.json({ ok: true, result: { message_id: 5, video: { file_id: 'V'.repeat(30), file_name: 'clip.mp4', mime_type: 'video/mp4', file_size: 99 } } });
        const [item] = await (await post({ url: 'https://example.com/get?id=1' })).json();
        assert.strictEqual(item.src, `/file/${'V'.repeat(30)}.mp4`);
    });

    it('adds the uploader caption only when LOG_UPLOADER_IP=true', async function () {
        await post({ url: 'https://example.com/cat.jpg' }, { extraEnv: { LOG_UPLOADER_IP: 'true' }, headers: { 'CF-Connecting-IP': '1.2.3.4' } });
        assert.strictEqual(sends[0].body.get('caption'), 'Uploader: 1.2.3.4');
    });

    it('reports a Telegram refusal as an error the page can fall back from', async function () {
        telegram = Response.json({ ok: false, error_code: 400, description: 'Bad Request: failed to get HTTP URL content' }, { status: 400 });
        const res = await post({ url: 'https://example.com/huge.mp4' });
        assert.strictEqual(res.status, 500);
        assert.match((await res.json()).error, /failed to get HTTP URL content/);
    });

    it('passes Telegram rate limiting on as 429', async function () {
        telegram = Response.json({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 7 } }, { status: 429 });
        const res = await post({ url: 'https://example.com/cat.jpg' });
        assert.strictEqual(res.status, 429);
        assert.strictEqual(res.headers.get('Retry-After'), '7');
    });

    it('keeps the upload gates: basic auth and cross-site origins', async function () {
        const auth = { UPLOAD_BASIC_USER: 'u', UPLOAD_BASIC_PASS: 'p' };
        assert.strictEqual((await post({ url: 'https://example.com/a.jpg' }, { extraEnv: auth })).status, 401);
        const ok = await post({ url: 'https://example.com/a.jpg' }, { extraEnv: auth, headers: { Authorization: 'Basic ' + Buffer.from('u:p').toString('base64') } });
        assert.strictEqual(ok.status, 200);
        const foreign = await post({ url: 'https://example.com/a.jpg' }, { headers: { Origin: 'https://evil.test', 'Sec-Fetch-Site': 'cross-site' } });
        assert.strictEqual(foreign.status, 403);
    });
});

const assert = require('assert');

describe('/file/:id', function () {
    const fileId = 'AgACAgEAAxkDAAMDZt1Gzs4W8dQPWiQJxO5YSH5X';
    const env = { TG_Bot_Token: 'SECRET:TOKEN' };
    let calls;
    const realFetch = global.fetch;

    beforeEach(function () {
        calls = [];
        global.fetch = async (url, init = {}) => {
            calls.push({ url: String(url), init });
            if (String(url).includes('/getFile')) {
                return Response.json({ ok: true, result: { file_path: 'photos/file_1.jpg' } });
            }
            return new Response('bytes', { status: 206, headers: { 'Content-Type': 'application/octet-stream' } });
        };
    });
    afterEach(function () { global.fetch = realFetch; });

    async function call(headers = {}, id = `${fileId}.jpg`) {
        const { onRequest } = await import('../functions/file/[id].js');
        const request = new Request(`https://x.test/file/${id}`, { headers });
        return onRequest({ request, env, params: { id } });
    }

    it('forwards only Range to Telegram', async function () {
        const res = await call({ Range: 'bytes=0-4', Cookie: 'a=b', Authorization: 'Bearer z' });
        assert.strictEqual(res.status, 206);
        const download = calls.find(c => c.url.includes('/file/bot'));
        assert.deepStrictEqual([...new Headers(download.init.headers).keys()], ['range']);
        assert.strictEqual(download.init.body, undefined);
    });

    it('fixes the content type from the extension', async function () {
        const res = await call();
        assert.strictEqual(res.headers.get('Content-Type'), 'image/jpeg');
    });

    it('rejects malformed ids without calling Telegram', async function () {
        const res = await call({}, 'abc.png');
        assert.strictEqual(res.status, 404);
        assert.strictEqual(calls.length, 0);
    });
});

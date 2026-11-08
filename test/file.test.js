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

describe('content type hardening', function () {
    const fileId = 'AgACAgEAAxkDAAMDZt1Gzs4W8dQPWiQJxO5YSH5X';
    const env = { TG_Bot_Token: 'T' };
    const realFetch = global.fetch;
    afterEach(function () { global.fetch = realFetch; });

    async function serve(ext, upstreamType) {
        global.fetch = async url => String(url).includes('/getFile')
            ? Response.json({ ok: true, result: { file_path: `docs/f.${ext}` } })
            : new Response('<script>alert(1)</script>', { headers: { 'Content-Type': upstreamType } });
        const { onRequest } = await import('../functions/file/[id].js');
        const id = `${fileId}.${ext}`;
        return onRequest({ request: new Request(`https://x.test/file/${id}`), env, params: { id } });
    }

    for (const [ext, type] of [['html', 'text/html'], ['svg', 'image/svg+xml'], ['xhtml', 'application/xhtml+xml'], ['xml', 'text/xml'], ['js', 'text/javascript']]) {
        it(`serves .${ext} (${type}) as a download, never inline`, async function () {
            const res = await serve(ext, type);
            assert.strictEqual(res.headers.get('Content-Type'), 'application/octet-stream');
            assert.match(res.headers.get('Content-Disposition'), /^attachment/);
            assert.strictEqual(res.headers.get('X-Content-Type-Options'), 'nosniff');
        });
    }

    it('still shows images inline, sandboxed', async function () {
        const res = await serve('png', 'image/png');
        assert.strictEqual(res.headers.get('Content-Type'), 'image/png');
        assert.match(res.headers.get('Content-Disposition'), /^inline/);
        assert.strictEqual(res.headers.get('Content-Security-Policy'), 'sandbox');
    });

    it('shows PDFs inline without a sandbox policy (Chrome would block them)', async function () {
        const res = await serve('pdf', 'application/octet-stream');
        assert.strictEqual(res.headers.get('Content-Type'), 'application/pdf');
        assert.strictEqual(res.headers.get('Content-Security-Policy'), null);
    });
});

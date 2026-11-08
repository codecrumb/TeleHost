const assert = require('assert');

describe('who may upload from a web page', function () {
    const realFetch = global.fetch;
    afterEach(function () { global.fetch = realFetch; });

    const listed = { TG_Bot_Token: 'T:T', TG_Chat_ID: '-1', ALLOWED_UPLOAD_ORIGINS: 'good.example,*.fine.example,localhost' };
    const own = 'https://host.test';

    const gate = async (env, headers) => {
        const { checkUploadOrigin } = await import('../functions/_lib/origin.js');
        return checkUploadOrigin(new Request(`${own}/upload`, { method: 'POST', headers }), env);
    };

    describe('the policy', function () {
        it('welcomes programs (no browser headers) and this site\'s own pages', async function () {
            assert.deepStrictEqual(await gate(listed, {}), { ok: true, origin: null }, 'curl, ShareX, phone apps');
            assert.deepStrictEqual(await gate({}, {}), { ok: true, origin: null }, 'with nothing configured');
            assert.deepStrictEqual(await gate(listed, { Origin: own, 'Sec-Fetch-Site': 'same-origin' }), { ok: true, origin: null });
            assert.deepStrictEqual(await gate(listed, { 'Sec-Fetch-Site': 'none' }), { ok: true, origin: null });
        });

        it('refuses any other site by default, with or without a list', async function () {
            for (const env of [{}, { ALLOWED_UPLOAD_ORIGINS: '' }, { ALLOWED_UPLOAD_ORIGINS: 'good.example' }]) {
                assert.strictEqual((await gate(env, { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' })).ok, false);
            }
            assert.strictEqual((await gate({}, { 'Sec-Fetch-Site': 'cross-site' })).ok, false, 'cross-site, no Origin');
            assert.strictEqual((await gate({}, { 'Sec-Fetch-Site': 'same-site' })).ok, false, 'a sibling subdomain is another site');
        });

        it('lets listed sites through (exact hosts, wildcards) and says which origin to answer', async function () {
            assert.deepStrictEqual(await gate(listed, { Origin: 'https://good.example' }), { ok: true, origin: 'https://good.example' });
            assert.deepStrictEqual(await gate(listed, { Origin: 'https://a.b.fine.example' }), { ok: true, origin: 'https://a.b.fine.example' });
            assert.deepStrictEqual(await gate(listed, { Origin: 'https://fine.example' }), { ok: true, origin: 'https://fine.example' });
            assert.deepStrictEqual(await gate(listed, { Origin: 'https://good.example:8443' }), { ok: true, origin: 'https://good.example:8443' });
        });

        it('is not fooled by look-alikes, plain http, opaque origins or junk', async function () {
            for (const origin of ['https://evilgood.example', 'https://good.example.evil.test', 'https://www.good.example',
                'http://good.example', 'null', 'not a url', 'https://', 'file://good.example', 'javascript:alert(1)']) {
                assert.strictEqual((await gate(listed, { Origin: origin })).ok, false, origin);
            }
        });

        it('allows plain http only for localhost, so a local dev page can be listed', async function () {
            assert.strictEqual((await gate(listed, { Origin: 'http://localhost:5173' })).ok, true);
            assert.strictEqual((await gate({ ...listed, ALLOWED_UPLOAD_ORIGINS: 'good.example' }, { Origin: 'http://localhost:5173' })).ok, false);
        });

        it('still reads the older ALLOWED_REFERERS name, and the new name wins when both are set', async function () {
            const old = { ALLOWED_REFERERS: 'good.example' };
            assert.strictEqual((await gate(old, { Origin: 'https://good.example' })).ok, true);
            assert.strictEqual((await gate({ ...old, ALLOWED_UPLOAD_ORIGINS: 'other.example' }, { Origin: 'https://good.example' })).ok, false);
        });
    });

    describe('/upload', function () {
        let telegramCalls;
        beforeEach(function () {
            telegramCalls = 0;
            global.fetch = async () => { telegramCalls++; return Response.json({ ok: true, result: { message_id: 1, document: { file_id: 'F'.repeat(30) } } }); };
        });

        async function upload(env, headers = {}, fields = {}) {
            const { onRequestPost } = await import('../functions/upload.js');
            const body = new FormData();
            body.append('file', new File(['hi'], 'a.txt', { type: 'text/plain' }));
            for (const [k, v] of Object.entries(fields)) body.append(k, v);
            return onRequestPost({ request: new Request(`${own}/upload`, { method: 'POST', body, headers }), env });
        }

        it('a page on an unlisted site gets 403 and nothing reaches Telegram', async function () {
            const res = await upload(listed, { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' });
            assert.strictEqual(res.status, 403);
            assert.strictEqual(res.headers.get('Access-Control-Allow-Origin'), null, 'and no CORS: it cannot read why');
            assert.strictEqual(telegramCalls, 0);
        });

        it('a listed site can upload and read the link, credentials allowed', async function () {
            const res = await upload(listed, { Origin: 'https://good.example', 'Sec-Fetch-Site': 'cross-site' });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.headers.get('Access-Control-Allow-Origin'), 'https://good.example');
            assert.strictEqual(res.headers.get('Access-Control-Allow-Credentials'), 'true');
            assert.match(res.headers.get('Vary'), /Origin/);
            assert.match((await res.json())[0].src, /^\/file\//);
        });

        it('error answers carry CORS too, so the listed page can show them', async function () {
            const bad = await upload(listed, { Origin: 'https://good.example' }, { expiresIn: '5' });
            assert.strictEqual(bad.status, 500);
            assert.strictEqual(bad.headers.get('Access-Control-Allow-Origin'), 'https://good.example');
            const needsLogin = await upload({ ...listed, UPLOAD_BASIC_USER: 'u', UPLOAD_BASIC_PASS: 'p' }, { Origin: 'https://good.example' });
            assert.strictEqual(needsLogin.status, 401);
            assert.strictEqual(needsLogin.headers.get('Access-Control-Allow-Origin'), 'https://good.example');
        });

        it('a listed site can upload to a password-protected deployment with the credentials', async function () {
            const env = { ...listed, UPLOAD_BASIC_USER: 'u', UPLOAD_BASIC_PASS: 'p' };
            const res = await upload(env, { Origin: 'https://good.example', Authorization: 'Basic ' + Buffer.from('u:p').toString('base64') });
            assert.strictEqual(res.status, 200);
        });

        it('curl-style uploads and this site\'s own page work and get no CORS headers', async function () {
            for (const headers of [{}, { Origin: own, 'Sec-Fetch-Site': 'same-origin' }]) {
                const res = await upload(listed, headers);
                assert.strictEqual(res.status, 200);
                assert.strictEqual(res.headers.get('Access-Control-Allow-Origin'), null);
            }
        });

        it('works the same with no list at all: others refused, programs welcome', async function () {
            const env = { TG_Bot_Token: 'T:T', TG_Chat_ID: '-1' };
            assert.strictEqual((await upload(env, { Origin: 'https://good.example' })).status, 403);
            assert.strictEqual((await upload(env, {})).status, 200);
        });
    });

    describe('preflight and /finalize', function () {
        const ask = async (route, env, headers) => {
            const mod = await import(`../functions/${route}.js`);
            return mod.onRequestOptions({ request: new Request(`${own}/${route}`, { method: 'OPTIONS', headers }), env });
        };

        it('answers a listed site\'s preflight for both routes', async function () {
            for (const route of ['upload', 'finalize']) {
                const res = await ask(route, listed, { Origin: 'https://good.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' });
                assert.strictEqual(res.status, 204, route);
                assert.strictEqual(res.headers.get('Access-Control-Allow-Origin'), 'https://good.example');
                assert.strictEqual(res.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');
                assert.match(res.headers.get('Access-Control-Allow-Headers'), /Content-Type/);
                assert.match(res.headers.get('Access-Control-Allow-Headers'), /Authorization/);
                assert.strictEqual(res.headers.get('Access-Control-Allow-Credentials'), 'true');
                assert.ok(Number(res.headers.get('Access-Control-Max-Age')) > 0);
            }
        });

        it('refuses everyone else\'s preflight without any CORS headers', async function () {
            for (const route of ['upload', 'finalize']) {
                const res = await ask(route, listed, { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' });
                assert.strictEqual(res.status, 403);
                assert.strictEqual(res.headers.get('Access-Control-Allow-Origin'), null);
            }
        });

        it('/finalize refuses unlisted sites and gives listed ones CORS', async function () {
            const { onRequestPost } = await import('../functions/finalize.js');
            const post = headers => onRequestPost({ request: new Request(`${own}/finalize`, { method: 'POST', headers, body: '{}' }), env: listed });
            assert.strictEqual((await post({ Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' })).status, 403);
            const ok = await post({ Origin: 'https://good.example', 'Sec-Fetch-Site': 'cross-site' });
            assert.strictEqual(ok.status, 400, 'it got as far as validating the (empty) body');
            assert.strictEqual(ok.headers.get('Access-Control-Allow-Origin'), 'https://good.example');
        });
    });

    describe('embedding and link clicks are never restricted', function () {
        it('/file ignores the Referer and the kind of load', async function () {
            global.fetch = async url => String(url).includes('/getFile')
                ? Response.json({ ok: true, result: { file_path: 'photos/p.png' } })
                : new Response('png', { headers: { 'Content-Type': 'image/png' } });
            const { onRequest } = await import('../functions/file/[id].js');
            const id = `${'A'.repeat(30)}.png`;
            for (const headers of [
                { 'Sec-Fetch-Dest': 'image', Referer: 'https://evil.example/page' },
                { 'Sec-Fetch-Dest': 'iframe', Referer: 'https://evil.example/page' },
                { 'Sec-Fetch-Dest': 'document', Referer: 'https://web.whatsapp.com/' },
                { Referer: 'https://da.gd/abc' },
            ]) {
                const res = await onRequest({ request: new Request(`${own}/file/${id}`, { headers }), env: { ...listed, ALLOWED_REFERERS: 'good.example' }, params: { id } });
                assert.strictEqual(res.status, 200, JSON.stringify(headers));
            }
        });

        it('/s serves its page whatever the Referer', async function () {
            const env = { TG_Bot_Token: 'T:T', ASSETS: { fetch: async () => new Response('<html>unlock</html>') }, ALLOWED_UPLOAD_ORIGINS: 'good.example' };
            const { sealManifest } = await import('../functions/_lib/manifest.js');
            const sealed = await sealManifest(env, { v: 1, parts: [{ fileId: 'P'.repeat(30), msgId: 1, size: 1 }], name: 'x', type: '', size: 1, exp: Date.now() + 60000 });
            global.fetch = async u => String(u).includes('/getFile')
                ? Response.json({ ok: true, result: { file_path: 'documents/m.bin' } })
                : new Response(sealed);
            const { onRequest } = await import('../functions/s/[id].js');
            const id = 'M'.repeat(30);
            for (const headers of [{ 'Sec-Fetch-Dest': 'document', Referer: 'https://da.gd/x' }, { 'Sec-Fetch-Dest': 'iframe', Referer: 'https://evil.example/' }]) {
                const res = await onRequest({ request: new Request(`${own}/s/${id}`, { headers }), env, params: { id } });
                assert.strictEqual(res.status, 200, JSON.stringify(headers));
            }
        });
    });
});

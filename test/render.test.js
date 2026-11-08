const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

describe('rendering uploaded HTML in the browser (/v/)', function () {
    const id = 'H'.repeat(30);
    const realFetch = global.fetch;
    const on = { TG_Bot_Token: 'T:T', TG_Chat_ID: '-1', ALLOW_HTML_RENDER: 'true' };
    const assets = { ASSETS: { fetch: async () => new Response('<html><title>External Content Notice | TeleHost</title></html>') } };

    beforeEach(function () {
        global.fetch = async url => String(url).includes('/getFile')
            ? Response.json({ ok: true, result: { file_path: 'documents/page.html' } })
            : new Response('<h1>hi</h1><script>alert(1)</script>', { headers: { 'Content-Type': 'text/html' } });
    });
    afterEach(function () { global.fetch = realFetch; });

    async function visit({ env = on, query = '', headers = {}, name = `${id}.html`, method = 'GET' } = {}) {
        const { onRequest } = await import('../functions/v/[id].js');
        const request = new Request(`https://host.test/v/${name}${query}`, { method, headers });
        return onRequest({ request, env: { ...env, ...assets }, params: { id: name } });
    }
    const ours = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Dest': 'document' };

    describe('the operator switch', function () {
        it('is off unless ALLOW_HTML_RENDER=true', async function () {
            for (const env of [{ TG_Bot_Token: 'T:T' }, { TG_Bot_Token: 'T:T', ALLOW_HTML_RENDER: 'false' }, { TG_Bot_Token: 'T:T', ALLOW_HTML_RENDER: 'yes please' }]) {
                assert.strictEqual((await visit({ env })).status, 404);
                assert.strictEqual((await visit({ env, query: '?open=1', headers: ours })).status, 404);
            }
        });
    });

    describe('the notice', function () {
        it('is what a shared link shows, and cannot be framed', async function () {
            const res = await visit();
            assert.strictEqual(res.status, 200);
            assert.match(await res.text(), /External Content Notice \| TeleHost/);
            assert.strictEqual(res.headers.get('X-Frame-Options'), 'DENY');
        });

        it('has the title, logo, warning and both buttons', function () {
            const dom = new JSDOM(read('view.html'), { url: 'https://files.example.com/v/x.html', runScripts: 'dangerously' });
            const d = dom.window.document;
            assert.strictEqual(d.title, 'External Content Notice | TeleHost');
            assert.ok(d.querySelector('img[src="/assets/icons/icon-192.png"]'), 'logo');
            assert.strictEqual(d.getElementById('host').textContent, 'files.example.com');
            assert.match(d.body.textContent, /does not review third-party content/);
            assert.strictEqual(d.querySelector('a.primary').getAttribute('href'), '?open=1');
            assert.strictEqual(d.querySelector('a.primary').textContent, 'Open the page');
            assert.strictEqual(d.querySelector('a[href="/"].btn').textContent, 'Go to homepage');
            dom.window.close();
        });
    });

    describe('the page itself', function () {
        it('is served in a sandbox with no origin of its own', async function () {
            const res = await visit({ query: '?open=1', headers: ours });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.headers.get('Content-Type'), 'text/html; charset=utf-8');
            const csp = res.headers.get('Content-Security-Policy');
            assert.match(csp, /^sandbox /);
            assert.match(csp, /allow-scripts/);
            assert.ok(!/allow-same-origin|allow-top-navigation|allow-popups-to-escape-sandbox/.test(csp), csp);
            assert.match(csp, /frame-ancestors 'none'/);
            assert.strictEqual(res.headers.get('X-Content-Type-Options'), 'nosniff');
            assert.strictEqual(res.headers.get('Referrer-Policy'), 'no-referrer');
            assert.match(res.headers.get('Cache-Control'), /private/);
            assert.match(await res.text(), /<h1>hi<\/h1>/);
        });

        it('cannot be reached by skipping the notice', async function () {
            for (const headers of [{ 'Sec-Fetch-Site': 'none' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, {}, { Referer: 'https://evil.example/' }]) {
                const res = await visit({ query: '?open=1', headers });
                assert.strictEqual(res.status, 303, JSON.stringify(headers));
                assert.strictEqual(res.headers.get('Location'), `https://host.test/v/${id}.html`);
            }
        });

        it('accepts a click from the notice in browsers without Fetch Metadata (same-origin Referer)', async function () {
            const res = await visit({ query: '?open=1', headers: { Referer: `https://host.test/v/${id}.html` } });
            assert.strictEqual(res.status, 200);
        });

        it('still refuses other sites embedding it when a referer allowlist is set', async function () {
            const env = { ...on, ALLOWED_REFERERS: 'good.example' };
            const embedded = await visit({ env, query: '?open=1', headers: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Dest': 'iframe', Referer: 'https://evil.example/' } });
            assert.strictEqual(embedded.status, 403);
        });
    });

    describe('what it will and will not serve', function () {
        it('only .html and .htm, with a valid id, over GET/HEAD', async function () {
            assert.strictEqual((await visit({ name: `${id}.htm` })).status, 200);
            for (const name of [`${id}.svg`, `${id}.png`, `${id}.js`, `${id}`, 'short.html', `${id}.html.exe`]) {
                assert.strictEqual((await visit({ name })).status, 404, name);
            }
            assert.strictEqual((await visit({ method: 'POST' })).status, 405);
        });

        it('turns a Telegram rate limit into 429 with Retry-After', async function () {
            global.fetch = async () => Response.json({ ok: false, error_code: 429, parameters: { retry_after: 9 } }, { status: 429 });
            const res = await visit({ query: '?open=1', headers: ours });
            assert.strictEqual(res.status, 429);
            assert.strictEqual(res.headers.get('Retry-After'), '9');
        });

        it('plain /file links still download HTML, never render it', async function () {
            const { onRequest } = await import('../functions/file/[id].js');
            const name = `${id}.html`;
            const res = await onRequest({ request: new Request(`https://host.test/file/${name}`), env: on, params: { id: name } });
            assert.match(res.headers.get('Content-Disposition'), /^attachment/);
            assert.strictEqual(res.headers.get('Content-Type'), 'application/octet-stream');
        });
    });

    describe('uploading with "open in browser"', function () {
        async function upload(fields, env, fileName = 'page.html', type = 'text/html') {
            global.fetch = async () => Response.json({ ok: true, result: { message_id: 3, document: { file_id: 'D'.repeat(30) } } });
            const { onRequestPost } = await import('../functions/upload.js');
            const body = new FormData();
            body.append('file', new File(['<h1>x</h1>'], fileName, { type }));
            for (const [k, v] of Object.entries(fields)) body.append(k, v);
            const res = await onRequestPost({ request: new Request('https://host.test/upload', { method: 'POST', body }), env });
            return (await res.json())[0];
        }

        it('gives an HTML file a /v/ link when asked and allowed', async function () {
            const item = await upload({ render: '1' }, on);
            assert.strictEqual(item.src, `/v/${'D'.repeat(30)}.html`);
            assert.strictEqual(item.note, undefined);
        });

        it('falls back to a download link, and says why, when the operator has not enabled it', async function () {
            const item = await upload({ render: '1' }, { TG_Bot_Token: 'T:T', TG_Chat_ID: '-1' });
            assert.strictEqual(item.src, `/file/${'D'.repeat(30)}.html`);
            assert.match(item.note, /turned off on this deployment/);
        });

        it('leaves everything else alone: no flag, other file types, other options', async function () {
            assert.strictEqual((await upload({}, on)).src, `/file/${'D'.repeat(30)}.html`);
            const png = await upload({ render: '1' }, on, 'pic.png', 'image/png');
            assert.match(png.src, /^\/file\//);
            assert.strictEqual(png.note, undefined);
            const expiring = await upload({ render: '1', expiresIn: '3600', }, { ...on, LINK_SECRET: 'x'.repeat(32) });
            assert.match(expiring.src, /^\/s\//);
            assert.match(expiring.note, /not available for expiring or password-protected links/);
        });
    });
});

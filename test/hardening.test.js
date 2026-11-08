const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

describe('review fixes', function () {
    const realFetch = global.fetch;
    afterEach(function () {
        global.fetch = realFetch;
        delete global.caches;
    });

    describe('upload auth', function () {
        const creds = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
        const env = { UPLOAD_BASIC_USER: 'admin', UPLOAD_BASIC_PASS: 'correct horse battery' };
        const call = async (headers, e = env) => {
            const { authenticateUpload } = await import('../functions/_lib/auth.js');
            return authenticateUpload(new Request('https://host.test/upload', { method: 'POST', headers }), e);
        };

        it('lets the operator (and scripts with no browser headers) through', async function () {
            assert.strictEqual(await call({ Authorization: creds('admin', 'correct horse battery') }), null);
            assert.strictEqual(await call({ Authorization: creds('admin', 'correct horse battery'), 'Sec-Fetch-Site': 'same-origin' }), null);
            assert.strictEqual(await call({ Authorization: creds('admin', 'correct horse battery'), Origin: 'https://host.test' }), null);
        });

        it('refuses cross-site requests even with valid cached credentials', async function () {
            const good = creds('admin', 'correct horse battery');
            assert.strictEqual((await call({ Authorization: good, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
            assert.strictEqual((await call({ Authorization: good, 'Sec-Fetch-Site': 'same-site' })).status, 403);
            assert.strictEqual((await call({ Authorization: good, Origin: 'https://evil.test' })).status, 403);
        });

        it('rejects wrong credentials, including a different-length password', async function () {
            assert.strictEqual((await call({ Authorization: creds('admin', 'nope') })).status, 401);
            assert.strictEqual((await call({ Authorization: creds('admin', 'correct horse battery staple') })).status, 401);
            assert.strictEqual((await call({ Authorization: creds('admin', 'correct horse batterX') })).status, 401);
            assert.strictEqual((await call({})).status, 401);
        });

        it('fails closed when the variables are blank or half set, and is open only when both are unset', async function () {
            assert.strictEqual((await call({}, { UPLOAD_BASIC_USER: '', UPLOAD_BASIC_PASS: '' })).status, 500);
            assert.strictEqual((await call({}, { UPLOAD_BASIC_USER: 'admin' })).status, 500);
            assert.strictEqual((await call({}, { UPLOAD_BASIC_PASS: 'x' })).status, 500);
            assert.strictEqual(await call({}, {}), null);
        });
    });

    describe('non-ASCII file names', function () {
        it('builds a header Latin-1 safe, with no way to inject CR/LF or quotes', async function () {
            const { contentDisposition } = await import('../functions/_lib/serve.js');
            const value = contentDisposition('inline', 'שלום "x"\r\nSet-Cookie: a=b.pdf');
            assert.doesNotThrow(() => new Headers().set('Content-Disposition', value));
            assert.ok(!/[\r\n]/.test(value));
            assert.match(value, /^inline; filename="[\x20-\x7e]*"; filename\*=UTF-8''%D7%A9/);
            assert.ok(!value.includes('"x"'), 'inner quotes are neutralised');
        });

        it('serves an expiring file with a Hebrew name instead of failing', async function () {
            const env = { TG_Bot_Token: 'SECRET:TOKEN', TG_Chat_ID: '-100' };
            const manifestId = 'M'.repeat(30);
            const { sealManifest } = await import('../functions/_lib/manifest.js');
            const sealed = await sealManifest(env, {
                v: 1, fileId: 'F'.repeat(30), msgId: 7, name: 'שלום.png', type: 'image/png', size: 3, exp: Date.now() + 60000,
            });
            global.fetch = async url => {
                url = String(url);
                if (url.includes('/getFile')) {
                    return Response.json({ ok: true, result: { file_path: new URL(url).searchParams.get('file_id') === manifestId ? 'documents/m.bin' : 'photos/p.png' } });
                }
                return new Response(url.endsWith('m.bin') ? sealed : 'png-bytes');
            };
            const { onRequest } = await import('../functions/s/[id].js');
            const id = `${manifestId}.png`;
            const res = await onRequest({ request: new Request(`https://x.test/s/${id}`), env, params: { id } });
            assert.strictEqual(res.status, 200);
            assert.match(res.headers.get('Content-Disposition'), /filename\*=UTF-8''%D7%A9%D7%9C%D7%95%D7%9D\.png/);
        });
    });

    describe('cleanup of expired links', function () {
        const env = { TG_Bot_Token: 'SECRET:TOKEN', TG_Chat_ID: '-100' };
        const manifestId = 'M'.repeat(30);
        let deleted;

        async function expiredLink(parts) {
            const { sealManifest } = await import('../functions/_lib/manifest.js');
            const sealed = await sealManifest(env, {
                v: 1,
                parts: Array.from({ length: parts }, (_, i) => ({ fileId: `P${i}`.padEnd(30, 'x'), msgId: 1000 + i, size: 1 })),
                name: 'big.bin', type: '', size: parts, exp: Date.now() - 1,
            });
            deleted = [];
            global.fetch = async (url, init = {}) => {
                url = String(url);
                if (url.includes('/deleteMessage')) { deleted.push(JSON.parse(init.body).message_id); return Response.json({ ok: true }); }
                if (url.includes('/getFile')) return Response.json({ ok: true, result: { file_path: 'documents/m.bin' } });
                return new Response(sealed);
            };
        }

        const visit = async () => {
            const { onRequest } = await import('../functions/s/[id].js');
            return onRequest({ request: new Request(`https://x.test/s/${manifestId}?meta=1`), env, params: { id: manifestId } });
        };

        it('hammering one expired link cleans up once per hour, not on every request', async function () {
            const cache = new Map();
            global.caches = { default: { match: async req => cache.get(req.url), put: async (req, res) => { cache.set(req.url, res); } } };
            await expiredLink(64);
            assert.strictEqual((await visit()).status, 410);
            const afterFirst = deleted.length;
            assert.ok(afterFirst > 0 && afterFirst <= 40, `one slice of at most 40, got ${afterFirst}`);
            for (let i = 0; i < 20; i++) assert.strictEqual((await visit()).status, 410);
            assert.strictEqual(deleted.length, afterFirst, 'no further Telegram calls within the hour');
        });

        it('without an edge cache it still bounds the work per request', async function () {
            await expiredLink(64);
            assert.strictEqual((await visit()).status, 410);
            assert.ok(deleted.length > 0 && deleted.length <= 5, `deleted ${deleted.length}`);
        });

        it('a different slice is cleaned in a later hour, so big files are covered over time', async function () {
            const cache = new Map();
            global.caches = { default: { match: async req => cache.get(req.url), put: async (req, res) => { cache.set(req.url, res); } } };
            await expiredLink(64);
            const realNow = Date.now;
            try {
                await visit();
                const first = deleted.slice();
                cache.clear();
                Date.now = () => realNow() + 3600 * 1000;
                await visit();
                const second = deleted.slice(first.length);
                assert.ok(second.length > 0);
                assert.ok(second.every(id => !first.includes(id)), 'the next hour deletes the other slice');
            } finally {
                Date.now = realNow;
            }
        });
    });

    describe('join page', function () {
        const id = 'J'.repeat(30);
        const partId = 'K'.repeat(30);

        async function openJoin(manifest) {
            const created = [];
            const dom = new JSDOM(read('join.html'), {
                url: `https://x.test/join/${id}.json`,
                runScripts: 'dangerously',
                pretendToBeVisual: true,
                beforeParse(win) {
                    win.URL.createObjectURL = blob => { created.push(blob); return 'blob:1'; };
                    win.URL.revokeObjectURL = () => {};
                    win.fetch = async u => String(u).includes(`${id}.json`)
                        ? new Response(JSON.stringify(manifest))
                        : new Response('abc');
                },
            });
            await new Promise(r => setTimeout(r, 150));
            return dom.window;
        }

        it('never puts shell metacharacters from a hostile file name into the copyable commands', async function () {
            const win = await openJoin({
                v: 1, name: '$(touch /tmp/pwn) `id`; rm -rf ~ & "x" -rf', size: 3,
                parts: [{ src: `/file/${partId}.part1`, size: 3 }, { src: `/file/${partId}.part2`, size: 3 }],
            });
            const commands = Array.from(win.document.querySelectorAll('.cmd code')).map(c => c.textContent);
            assert.strictEqual(commands.length, 2, 'both commands are still offered');
            for (const command of commands) {
                assert.ok(!/[$`;&|<>\\!]/.test(command.replace(/ [>+] | > /g, ' ').replace(/^copy \/b /, '')) || /^copy \/b /.test(command),
                    `unsafe characters in: ${command}`);
            }
            assert.match(commands[0], /^cat ("[A-Za-z0-9._-]+" )+> "[A-Za-z0-9._-]+"$/);
            assert.ok(!commands[0].includes('$(') && !commands[0].includes('`'));
            win.close();
        });

        it('does not start an option-like file name with a dash', async function () {
            const win = await openJoin({
                v: 1, name: '-rf', size: 3, parts: [{ src: `/file/${partId}.part1`, size: 3 }],
            });
            const cat = Array.from(win.document.querySelectorAll('.cmd code')).map(c => c.textContent)[0];
            assert.ok(!/"-/.test(cat), cat);
            win.close();
        });

        it('rejects part paths that are not exactly /file/<id>.<ext>', async function () {
            for (const src of ['/file/..', '/file/../x', '/file/a.b', '//evil.test/x', 'https://evil.test/x']) {
                const win = await openJoin({ v: 1, name: 'x', size: 3, parts: [{ src, size: 3 }] });
                assert.match(win.document.getElementById('status').textContent, /not a valid multi-part file/, src);
                win.close();
            }
        });
    });
});

describe('page headers', function () {
    const read = f => require('fs').readFileSync(require('path').join(__dirname, '..', f), 'utf8');

    it('dynamically served pages cannot be framed and carry nosniff', async function () {
        const { servePage } = await import('../functions/_lib/serve.js');
        const res = await servePage({ ASSETS: { fetch: async () => new Response('<html></html>') } }, new Request('https://x.test/s/abc'), 'unlock');
        assert.strictEqual(res.headers.get('X-Frame-Options'), 'DENY');
        assert.strictEqual(res.headers.get('X-Content-Type-Options'), 'nosniff');
        assert.match(res.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
    });

    it('static pages get the same set from /_headers', function () {
        const headers = read('_headers');
        assert.match(headers, /^\/\*/m);
        assert.match(headers, /X-Frame-Options: DENY/);
        assert.match(headers, /frame-ancestors 'none'/);
    });

    it('the lazily loaded zip library is pinned with SRI', function () {
        const html = read('index.html');
        assert.match(html, /jszip\.min\.js'/);
        assert.match(html, /s\.integrity = 'sha512-/);
        assert.match(html, /s\.crossOrigin = 'anonymous'/);
    });
});

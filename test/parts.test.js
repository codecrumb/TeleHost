const assert = require('assert');

describe('big files as parts (/finalize and multi-part /s/)', function () {
    const env = { TG_Bot_Token: 'SECRET:TOKEN', TG_Chat_ID: '-100' };
    const realFetch = global.fetch;
    const manifestId = 'M'.repeat(30);
    const partId = n => `P${n}`.padEnd(30, 'x');
    let store;     // file_id -> bytes (string)
    let sendCount; // sendDocument calls
    let deleted;
    let nextMsg;

    beforeEach(function () {
        store = {};
        sendCount = 0;
        deleted = [];
        nextMsg = 100;
        global.fetch = async (url, init = {}) => {
            url = String(url);
            if (url.includes('/getFile')) {
                const id = new URL(url).searchParams.get('file_id');
                return store[id] === undefined ? Response.json({ ok: false }, { status: 400 })
                    : Response.json({ ok: true, result: { file_path: `f/${id}` } });
            }
            if (url.includes('/file/bot')) return new Response(store[url.split('/f/')[1]] ?? 'missing');
            if (url.includes('/deleteMessage')) { deleted.push(JSON.parse(init.body).message_id); return Response.json({ ok: true }); }
            sendCount++;
            const doc = init.body.get('document');
            const message_id = nextMsg++;
            if (doc.name === 'link.json') {
                store[manifestId] = await doc.text();
                return Response.json({ ok: true, result: { message_id, document: { file_id: manifestId } } });
            }
            const id = partId(sendCount);
            store[id] = await doc.text();
            return Response.json({ ok: true, result: { message_id, document: { file_id: id } } });
        };
    });
    afterEach(function () { global.fetch = realFetch; });

    async function uploadPart(text, extraEnv = {}, headers = {}) {
        const { onRequestPost } = await import('../functions/upload.js');
        const body = new FormData();
        body.append('file', new File([text], 'big.bin.part1', { type: 'application/octet-stream' }));
        body.append('part', '1');
        const res = await onRequestPost({ request: new Request('https://x.test/upload', { method: 'POST', body, headers }), env: { ...env, ...extraEnv } });
        return { res, item: (await res.json())[0] };
    }

    async function finalize(payload, extraEnv = {}, headers = {}) {
        const { onRequestPost } = await import('../functions/finalize.js');
        const request = new Request('https://x.test/finalize', { method: 'POST', body: JSON.stringify(payload), headers });
        const res = await onRequestPost({ request, env: { ...env, ...extraEnv } });
        return { res, data: await res.json() };
    }

    async function threeParts() {
        const receipts = [];
        for (const text of ['AAAA', 'BBBB', 'CC']) receipts.push((await uploadPart(text)).item.receipt);
        return receipts;
    }

    it('signs a receipt for every uploaded part', async function () {
        const { item } = await uploadPart('AAAA');
        const { verifyReceipt } = await import('../functions/_lib/manifest.js');
        assert.ok(await verifyReceipt(env, item.receipt));
        assert.ok(!(await verifyReceipt(env, { ...item.receipt, msgId: item.receipt.msgId + 1 })));
    });

    it('turns verified parts into one signed manifest with expiry and encryption info', async function () {
        const receipts = await threeParts();
        const sendsBefore = sendCount;
        const { res, data } = await finalize({
            receipts, name: 'big.bin', type: 'application/zip', size: 10, expiresIn: 3600,
            enc: { salt: 'AAAAAAAAAAAAAAAAAAAAAA', ivp: 'BBBBBBBBBBB', iter: 600000 },
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(data[0].src, `/s/${manifestId}`);
        assert.strictEqual(sendCount, sendsBefore + 1, 'one manifest document');
        const manifest = JSON.parse(store[manifestId]);
        assert.deepStrictEqual(manifest.parts.map(p => p.fileId), receipts.map(r => r.fileId));
        assert.strictEqual(manifest.enc.ivp, 'BBBBBBBBBBB');
        assert.ok(manifest.exp > Date.now());
        const { verifyManifest } = await import('../functions/_lib/manifest.js');
        assert.ok(await verifyManifest(env, manifest));
    });

    it('rejects forged, duplicated, oversized or option-less requests without touching Telegram', async function () {
        const receipts = await threeParts();
        const before = sendCount;
        const bad = [
            { receipts: [{ ...receipts[0], msgId: 1 }], expiresIn: 3600 },
            { receipts: [receipts[0], receipts[0]], expiresIn: 3600 },
            { receipts: [], expiresIn: 3600 },
            { receipts, name: 'x' },
            { receipts, expiresIn: 5 },
            { receipts, enc: { salt: 'AAAAAAAAAAAAAAAAAAAAAA', ivp: 'BBBBBBBBBBB', iter: 99999999 } },
            { receipts: Array.from({ length: 65 }, () => receipts[0]), expiresIn: 3600 },
        ];
        for (const payload of bad) {
            const { res } = await finalize(payload);
            assert.strictEqual(res.status, 400, JSON.stringify(payload).slice(0, 80));
        }
        assert.strictEqual(sendCount, before);
    });

    it('requires upload credentials when Basic auth is configured', async function () {
        const receipts = await threeParts();
        const { res } = await finalize({ receipts, expiresIn: 3600 }, { UPLOAD_BASIC_USER: 'u', UPLOAD_BASIC_PASS: 'p' });
        assert.strictEqual(res.status, 401);
    });

    async function visit(query = '') {
        const { onRequest } = await import('../functions/s/[id].js');
        const env2 = { ...env, ASSETS: { fetch: async () => new Response('<html>unlock</html>') } };
        return onRequest({ request: new Request(`https://x.test/s/${manifestId}${query}`), env: env2, params: { id: manifestId } });
    }

    async function publish(extra = {}) {
        const receipts = await threeParts();
        await finalize({ receipts, name: 'big.bin', type: 'application/zip', size: 10, expiresIn: 3600, ...extra });
        return receipts;
    }

    it('serves meta without file ids, each part on request, and the unlock page otherwise', async function () {
        const receipts = await publish();
        const meta = await (await visit('?meta=1')).json();
        assert.deepStrictEqual(meta.parts, [4, 4, 2]);
        assert.strictEqual(meta.name, 'big.bin');
        const raw = JSON.stringify(meta);
        for (const r of receipts) assert.ok(!raw.includes(r.fileId) && !raw.includes('msgId'));

        const part = await visit('?part=1');
        assert.strictEqual(part.headers.get('Content-Type'), 'application/octet-stream');
        assert.strictEqual(await part.text(), 'BBBB');
        assert.strictEqual((await visit('?part=3')).status, 404);
        assert.strictEqual((await visit('?part=abc')).status, 404);
        assert.strictEqual((await visit('?part=-1')).status, 404);

        assert.match(await (await visit()).text(), /unlock/);
    });

    it('returns 410 after expiry and deletes every part message', async function () {
        const receipts = await publish();
        const manifest = JSON.parse(store[manifestId]);
        manifest.exp = Date.now() - 1;
        const { signManifest } = await import('../functions/_lib/manifest.js');
        store[manifestId] = JSON.stringify(await signManifest(env, { ...manifest, sig: undefined }));
        assert.strictEqual((await visit('?meta=1')).status, 410);
        assert.deepStrictEqual(deleted.sort(), receipts.map(r => r.msgId).sort());
        assert.strictEqual((await visit('?part=0')).status, 410);
    });

    it('rejects a multi-part manifest with an edited part list', async function () {
        await publish();
        const manifest = JSON.parse(store[manifestId]);
        manifest.parts[0].fileId = partId(99);
        store[manifestId] = JSON.stringify(manifest);
        assert.strictEqual((await visit('?meta=1')).status, 404);
    });
});

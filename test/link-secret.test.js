const assert = require('assert');

describe('LINK_SECRET', function () {
    const SECRET = 'a'.repeat(31) + 'b';
    const realFetch = global.fetch;
    afterEach(function () { global.fetch = realFetch; });

    const lib = () => import('../functions/_lib/manifest.js');
    const manifest = { v: 1, fileId: 'F'.repeat(30), msgId: 7, exp: Date.now() + 1000 };

    it('is the key when set: links survive rotating the bot token, not changing the secret', async function () {
        const { sealManifest, openManifest } = await lib();
        const sealed = await sealManifest({ TG_Bot_Token: 'OLD:TOKEN', LINK_SECRET: SECRET }, manifest);
        assert.deepStrictEqual(await openManifest({ TG_Bot_Token: 'NEW:TOKEN', LINK_SECRET: SECRET }, sealed), manifest);
        assert.strictEqual(await openManifest({ TG_Bot_Token: 'OLD:TOKEN', LINK_SECRET: 'c'.repeat(32) }, sealed), null);
    });

    it('falls back to the bot token when unset, and the two modes do not open each other', async function () {
        const { sealManifest, openManifest } = await lib();
        const viaToken = await sealManifest({ TG_Bot_Token: 'SOME:TOKEN' }, manifest);
        assert.deepStrictEqual(await openManifest({ TG_Bot_Token: 'SOME:TOKEN' }, viaToken), manifest);
        assert.strictEqual(await openManifest({ TG_Bot_Token: 'SOME:TOKEN', LINK_SECRET: SECRET }, viaToken), null);
    });

    it('refuses a blank or short secret instead of using it', async function () {
        const { sealManifest, openManifest, signReceipt, ConfigError } = await lib();
        for (const LINK_SECRET of ['', 'short', 'x'.repeat(31)]) {
            const env = { TG_Bot_Token: 'T:T', LINK_SECRET };
            await assert.rejects(() => sealManifest(env, manifest), ConfigError);
            await assert.rejects(() => openManifest(env, new Uint8Array(40)), ConfigError);
            await assert.rejects(() => signReceipt(env, { fileId: 'x', msgId: 1, size: 1 }), ConfigError);
        }
    });

    it('signs receipts with its own key, independent of the bot token', async function () {
        const { signReceipt, verifyReceipt } = await lib();
        const part = { fileId: 'P'.repeat(30), msgId: 9, size: 5 };
        const receipt = await signReceipt({ TG_Bot_Token: 'OLD:TOKEN', LINK_SECRET: SECRET }, part);
        assert.ok(await verifyReceipt({ TG_Bot_Token: 'NEW:TOKEN', LINK_SECRET: SECRET }, receipt));
        assert.ok(!(await verifyReceipt({ TG_Bot_Token: 'OLD:TOKEN', LINK_SECRET: 'c'.repeat(32) }, receipt)));
        assert.ok(!(await verifyReceipt({ TG_Bot_Token: 'OLD:TOKEN' }, receipt)));
    });

    it('keeps the manifest key and the receipt key apart', async function () {
        // The same secret feeds both, but through different HKDF labels: a sealed
        // manifest's bytes can never verify as a receipt signature or vice versa.
        const { sealManifest, signReceipt, verifyReceipt } = await lib();
        const env = { TG_Bot_Token: 'T:T', LINK_SECRET: SECRET };
        const receipt = await signReceipt(env, { fileId: 'P'.repeat(30), msgId: 1, size: 1 });
        const sealed = await sealManifest(env, { fileId: receipt.fileId, msgId: 1, size: 1 });
        const forged = { ...receipt, sig: Buffer.from(sealed.slice(0, 32)).toString('base64url') };
        assert.ok(!(await verifyReceipt(env, forged)));
    });

    it('a misconfigured secret gives a clear 500 on /s and on uploads that need it, not a silent "not found"', async function () {
        const env = { TG_Bot_Token: 'T:T', TG_Chat_ID: '-1', LINK_SECRET: 'short' };
        global.fetch = async url => String(url).includes('/getFile')
            ? Response.json({ ok: true, result: { file_path: 'documents/m.bin' } })
            : new Response(new Uint8Array(64));
        const { onRequest } = await import('../functions/s/[id].js');
        const id = 'M'.repeat(30);
        const res = await onRequest({ request: new Request(`https://x.test/s/${id}`), env, params: { id } });
        assert.strictEqual(res.status, 500);
        assert.match(await res.text(), /LINK_SECRET must be at least 32 characters/);

        const { onRequestPost } = await import('../functions/finalize.js');
        const receipts = [{ fileId: 'P'.repeat(30), msgId: 1, size: 1, sig: 'x' }];
        const fin = await onRequestPost({ request: new Request('https://x.test/finalize', { method: 'POST', body: JSON.stringify({ receipts, expiresIn: 3600 }) }), env });
        assert.strictEqual(fin.status, 500);
        assert.match((await fin.json()).error, /LINK_SECRET/);
    });
});

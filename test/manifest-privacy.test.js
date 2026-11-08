const assert = require('assert');

// A link holder knows the manifest's id (it is in the /s/ link) and /file/<id>
// serves any document in the channel. The manifest must reveal nothing useful.
describe('manifests do not leak what they protect', function () {
    const env = { TG_Bot_Token: 'SECRET:TOKEN', TG_Chat_ID: '-100' };
    const manifestId = 'M'.repeat(30);
    const realFetch = global.fetch;
    let store, nextId;

    beforeEach(function () {
        store = {};
        nextId = 0;
        global.fetch = async (url, init = {}) => {
            url = String(url);
            if (url.includes('/getFile')) {
                const id = new URL(url).searchParams.get('file_id');
                return store[id] ? Response.json({ ok: true, result: { file_path: `documents/${id}.json` } }) : Response.json({ ok: false }, { status: 400 });
            }
            if (url.includes('/file/bot')) return new Response(store[url.split('documents/')[1].replace('.json', '')]);
            const doc = init.body.get('document');
            const isManifest = ['link.json', 'link.bin'].includes(doc.name);
            const id = isManifest ? manifestId : `F${++nextId}`.padEnd(30, 'x');
            store[id] = new Uint8Array(await doc.arrayBuffer());
            return Response.json({ ok: true, result: { message_id: 500 + nextId, document: { file_id: id } } });
        };
    });
    afterEach(function () { global.fetch = realFetch; });

    async function uploadExpiring() {
        const { onRequestPost } = await import('../functions/upload.js');
        const body = new FormData();
        body.append('file', new File(['secret contents'], 'secret.txt', { type: 'text/plain' }));
        body.append('expiresIn', '3600');
        const res = await onRequestPost({ request: new Request('https://x.test/upload', { method: 'POST', body }), env });
        return (await res.json())[0];
    }

    it('serving the manifest document through /file reveals neither file ids nor message ids', async function () {
        await uploadExpiring();
        const realFileId = Object.keys(store).find(id => id.startsWith('F'));

        const { onRequest } = await import('../functions/file/[id].js');
        for (const ext of ['json', 'bin']) {
            const id = `${manifestId}.${ext}`;
            const res = await onRequest({ request: new Request(`https://x.test/file/${id}`), env, params: { id } });
            const leaked = Buffer.from(await res.arrayBuffer()).toString('latin1');
            assert.ok(!leaked.includes(realFileId), 'the real file id must not be readable');
            assert.ok(!leaked.includes('fileId') && !leaked.includes('msgId') && !leaked.includes('secret.txt'));
        }
    });
});

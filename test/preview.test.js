const assert = require('assert');

describe('video link previews', function () {
    const env = { TG_Bot_Token: 'SECRET:TOKEN', TG_Chat_ID: '-100' };
    const videoId = 'V'.repeat(30);
    const thumbId = 'T'.repeat(30);
    const manifestId = 'M'.repeat(30);
    const realFetch = global.fetch;
    let sent;
    let manifestBody;

    beforeEach(function () {
        sent = [];
        global.fetch = async (url, init = {}) => {
            url = String(url);
            if (url.includes('/getFile')) {
                const id = new URL(url).searchParams.get('file_id');
                return Response.json({ ok: true, result: { file_path: id === manifestId ? 'm.json' : 'videos/v.mp4' } });
            }
            if (url.includes('/file/bot')) {
                return new Response(url.endsWith('m.json') ? manifestBody : 'video-bytes', { headers: { 'Content-Type': 'application/octet-stream' } });
            }
            sent.push({ kind: url.split('/').pop(), body: init.body });
            const doc = init.body.get('document');
            if (doc && doc.name === 'link.json') {
                manifestBody = await doc.text();
                return Response.json({ ok: true, result: { message_id: 6, document: { file_id: manifestId } } });
            }
            return Response.json({ ok: true, result: { message_id: 5, video: { file_id: videoId, thumbnail: { file_id: thumbId } } } });
        };
    });
    afterEach(function () { global.fetch = realFetch; });

    async function upload(extra = {}) {
        const { onRequestPost } = await import('../functions/upload.js');
        const body = new FormData();
        body.append('file', new File(['v'], 'clip.mp4', { type: 'video/mp4' }));
        for (const [k, v] of Object.entries(extra)) body.append(k, v);
        const res = await onRequestPost({ request: new Request('https://x.test/upload', { method: 'POST', body }), env });
        return (await res.json())[0];
    }

    async function file(id, ua) {
        const { onRequest } = await import('../functions/file/[id].js');
        return onRequest({
            request: new Request(`https://x.test/file/${id}`, { headers: ua ? { 'User-Agent': ua } : {} }),
            env, params: { id },
        });
    }

    it('puts the thumbnail id in the video URL and forwards a valid custom thumbnail', async function () {
        const item = await upload({ thumbnail: new File(['jpg'], 'thumb.jpg', { type: 'image/jpeg' }) });
        assert.strictEqual(item.src, `/file/${videoId}~${thumbId}.mp4`);
        assert.strictEqual(sent[0].kind, 'sendVideo');
        assert.strictEqual(sent[0].body.get('supports_streaming'), 'true');
        assert.ok(sent[0].body.get('thumbnail'));
    });

    it('ignores oversized or non-JPEG thumbnails', async function () {
        await upload({ thumbnail: new File(['png'], 'thumb.png', { type: 'image/png' }) });
        assert.strictEqual(sent[0].body.get('thumbnail'), null);
    });

    it('gives link-preview bots Open Graph tags, everyone else the video', async function () {
        const id = `${videoId}~${thumbId}.mp4`;
        const bot = await file(id, 'WhatsApp/2.23.20.0 A');
        assert.match(bot.headers.get('Content-Type'), /text\/html/);
        const html = await bot.text();
        assert.ok(html.includes(`content="https://x.test/file/${thumbId}.jpg"`));
        assert.ok(html.includes(`property="og:video" content="https://x.test/file/${videoId}.mp4"`));

        const human = await file(id, 'Mozilla/5.0 Chrome');
        assert.strictEqual(human.headers.get('Content-Type'), 'video/mp4');
        assert.strictEqual(await human.text(), 'video-bytes');

        // The og:video URL has no thumbnail part, so a bot fetching it gets bytes.
        const botVideo = await file(`${videoId}.mp4`, 'WhatsApp/2.23');
        assert.strictEqual(botVideo.headers.get('Content-Type'), 'video/mp4');
    });

    it('does the same for expiring links, pointing og:video at ?raw=1', async function () {
        const item = await upload({ expiresIn: '3600' });
        assert.strictEqual(item.src, `/s/${manifestId}.mp4`);
        const { onRequest } = await import('../functions/s/[id].js');
        const get = (q, ua) => onRequest({
            request: new Request(`https://x.test/s/${manifestId}.mp4${q}`, { headers: { 'User-Agent': ua } }),
            env, params: { id: `${manifestId}.mp4` },
        });
        const html = await (await get('', 'facebookexternalhit/1.1')).text();
        assert.ok(html.includes(`content="https://x.test/file/${thumbId}.jpg"`));
        assert.ok(html.includes(`https://x.test/s/${manifestId}?raw=1`));
        const raw = await get('?raw=1', 'facebookexternalhit/1.1');
        assert.strictEqual(await raw.text(), 'video-bytes');
    });

    it('keeps the thumbnail out of encrypted uploads', async function () {
        const item = await upload({ encSalt: 'AAAAAAAAAAAAAAAA', encIv: 'BBBBBBBBBBBB', encIter: '600000' });
        assert.strictEqual(item.src, `/s/${manifestId}`);
        assert.strictEqual(JSON.parse(manifestBody).thumb, undefined);
    });
});

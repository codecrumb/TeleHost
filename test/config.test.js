const assert = require('assert');

describe('/config', function () {
    const call = async env => (await import('../functions/config.js')).onRequestGet({ env });

    it('says whether HTML rendering is on, and nothing else', async function () {
        const on = await call({ ALLOW_HTML_RENDER: 'true', TG_Bot_Token: 'SECRET:TOKEN', TG_Chat_ID: '-100', LINK_SECRET: 'x'.repeat(40), UPLOAD_BASIC_PASS: 'hunter2' });
        const body = await on.json();
        assert.deepStrictEqual(body, { htmlRender: true });
        assert.deepStrictEqual(await (await call({})).json(), { htmlRender: false });
        assert.deepStrictEqual(await (await call({ ALLOW_HTML_RENDER: 'false' })).json(), { htmlRender: false });
    });

    it('never echoes any environment value', async function () {
        const text = await (await call({ ALLOW_HTML_RENDER: 'true', TG_Bot_Token: 'SECRET:TOKEN', LINK_SECRET: 'x'.repeat(40), ALLOWED_UPLOAD_ORIGINS: 'private.example' })).text();
        for (const secret of ['SECRET:TOKEN', 'xxxxxxxx', 'private.example']) assert.ok(!text.includes(secret), secret);
    });

    it('is JSON, briefly cacheable, with nosniff', async function () {
        const res = await call({});
        assert.match(res.headers.get('Content-Type'), /application\/json/);
        assert.match(res.headers.get('Cache-Control'), /max-age=60/);
        assert.strictEqual(res.headers.get('X-Content-Type-Options'), 'nosniff');
    });
});

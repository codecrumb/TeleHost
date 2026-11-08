const assert = require('assert');
const fs = require('fs');
const path = require('path');

describe('resumable chunked uploads', function () {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const start = html.indexOf('const RESUME_PREFIX');
    const end = html.indexOf('// Password-protected uploads are encrypted here');
    const source = html.slice(start, end);

    const CHUNK = 10;
    let store, sent, failOn;

    function build() {
        const localStorage = {
            getItem: k => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); },
            removeItem: k => { delete store[k]; },
        };
        const postWithRetry = async file => {
            if (failOn === file.name) throw new Error('network down');
            sent.push(file.name);
            return { src: `/file/${'X'.repeat(20)}${sent.length}.bin` };
        };
        const factory = new Function('localStorage', 'File', 'CHUNK_SIZE', 'setJob', 'postWithRetry',
            `${source}; return { uploadChunked, loadResume };`);
        return factory(localStorage, File, CHUNK, () => {}, postWithRetry);
    }

    const makeFile = () => {
        const f = new File(['a'.repeat(35)], 'big.bin', { type: 'application/octet-stream', lastModified: 1700000000000 });
        return f; // 35 bytes -> 4 parts of 10,10,10,5
    };

    beforeEach(function () { store = {}; sent = []; failOn = null; });

    it('re-sends only the missing parts after a failure', async function () {
        const page = build();
        failOn = 'big.bin.part3';
        await assert.rejects(() => page.uploadChunked({ file: makeFile(), cancelled: false }), /network down/);
        assert.deepStrictEqual(sent, ['big.bin.part1', 'big.bin.part2']);

        failOn = null;
        const link = await page.uploadChunked({ file: makeFile(), cancelled: false });
        assert.deepStrictEqual(sent.slice(2), ['big.bin.part3', 'big.bin.part4', 'big.bin.manifest.json']);
        assert.match(link, /^\/join\//);
        assert.deepStrictEqual(Object.keys(store), [], 'resume state is cleared on success');
    });

    it('starts over when the file differs', async function () {
        const page = build();
        failOn = 'big.bin.part3';
        await assert.rejects(() => page.uploadChunked({ file: makeFile(), cancelled: false }));
        failOn = null;
        sent = [];
        const other = new File(['b'.repeat(35)], 'big.bin', { lastModified: 1700000000001 });
        await page.uploadChunked({ file: other, cancelled: false });
        assert.strictEqual(sent[0], 'big.bin.part1');
    });

    it('ignores tampered, mis-sized or expired saved state', function () {
        const page = build();
        const file = makeFile();
        const key = Object.keys(store)[0] || `th_resume:big.bin:35:1700000000000:${CHUNK}`;
        const check = saved => { store[key] = JSON.stringify(saved); return page.loadResume(key, 4, 35); };
        assert.deepStrictEqual(check({ ts: Date.now(), parts: [{ src: 'https://evil.test/x', size: 10 }] }), []);
        assert.deepStrictEqual(check({ ts: Date.now(), parts: [{ src: '/file/AAAA', size: 9 }] }), []);
        assert.deepStrictEqual(check({ ts: Date.now() - 8 * 24 * 3600 * 1000, parts: [{ src: '/file/AAAA', size: 10 }] }), []);
        assert.strictEqual(check({ ts: Date.now(), parts: [{ src: '/file/AAAA', size: 10 }] }).length, 1);
        assert.ok(file);
    });
});

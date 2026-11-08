import { authenticateUpload } from './_lib/auth.js';
import { verifyReceipt } from './_lib/manifest.js';
import { checkEncryption, checkExpiry, cleanMeta } from './_lib/options.js';
import { RateLimitedError, createManifestLink } from './_lib/send.js';
import { isValidFileId } from './_lib/telegram.js';

const MAX_PARTS = 64; // a 1 GB file is 54 parts of 19 MiB
const MAX_BODY_BYTES = 64 * 1024;

class BadRequest extends Error {}

const json = (body, status, headers = {}) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
});

// POST /finalize: the browser has uploaded a big file as parts (each answered with
// a signed receipt) and now asks for one /s/ link over them, with an optional expiry
// and password parameters. Only parts the server itself stored are accepted.
export async function onRequestPost({ request, env }) {
    try {
        const authResponse = authenticateUpload(request, env);
        if (authResponse) return authResponse;
        if (!env.TG_Bot_Token || !env.TG_Chat_ID) throw new Error('Server is missing TG_Bot_Token or TG_Chat_ID');

        const raw = await request.text();
        if (raw.length > MAX_BODY_BYTES) throw new BadRequest('Request too large');
        let body;
        try {
            body = JSON.parse(raw);
        } catch {
            throw new BadRequest('Invalid JSON');
        }

        const receipts = body && body.receipts;
        if (!Array.isArray(receipts) || receipts.length < 1 || receipts.length > MAX_PARTS) {
            throw new BadRequest('Invalid part list');
        }
        const seen = new Set();
        for (const receipt of receipts) {
            if (!isValidFileId(receipt && receipt.fileId) || seen.has(receipt.fileId) || !(await verifyReceipt(env, receipt))) {
                throw new BadRequest('Invalid part receipt');
            }
            seen.add(receipt.fileId);
        }

        let expiresIn, enc;
        try {
            expiresIn = checkExpiry(body.expiresIn);
            enc = body.enc ? checkEncryption(body.enc, 'parts') : null;
        } catch (error) {
            throw new BadRequest(error.message);
        }
        if (!expiresIn && !enc) throw new BadRequest('Nothing to finalize: set an expiry or a password');

        const manifest = {
            v: 1,
            parts: receipts.map(({ fileId, msgId, size }) => ({ fileId, msgId, size })),
            ...cleanMeta(body),
            ...(expiresIn ? { exp: Date.now() + expiresIn * 1000 } : {}),
            ...(enc ? { enc } : {}),
        };
        const manifestId = await createManifestLink(env, manifest);
        return json([{ src: `/s/${manifestId}`, expires: manifest.exp }], 200);
    } catch (error) {
        if (error instanceof RateLimitedError) {
            return json(
                { error: 'Telegram is rate limiting uploads; retrying shortly.', retryAfter: error.retryAfter },
                429,
                { 'Retry-After': String(error.retryAfter) }
            );
        }
        if (error instanceof BadRequest) return json({ error: error.message }, 400);
        console.error('Finalize error:', error);
        return json({ error: error.message }, 500);
    }
}

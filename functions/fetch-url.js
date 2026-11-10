import { authenticateUpload } from './_lib/auth.js';
import { linkSecret } from './_lib/manifest.js';
import { checkExpiry, safeExtension } from './_lib/options.js';
import { checkUploadOrigin, preflight, refusal, withCors } from './_lib/origin.js';
import { RateLimitedError, createManifestLink, failure, getFileId, sendToTelegram, uploaderCaption } from './_lib/send.js';

// "Paste a link": Telegram itself downloads the URL (its limit is about 20 MB),
// so the file never passes through this worker. Same gates as /upload.
// Password files are not offered here: the browser has to encrypt those itself.
export async function onRequestPost(context) {
    const gate = checkUploadOrigin(context.request, context.env);
    if (!gate.ok) return refusal();
    return withCors(await handleFetch(context), gate.origin);
}

export function onRequestOptions({ request, env }) {
    return preflight(request, env);
}

const json = (body, status = 200, extra = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...extra } });

const EXTENSION_BY_MIME = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
    'audio/mpeg': 'mp3', 'application/pdf': 'pdf',
};

// Only plain http(s) links, no embedded credentials; Telegram does the fetching.
export function checkFetchUrl(value) {
    if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid link');
    let url;
    try { url = new URL(value.trim()); } catch (_) { throw new Error('Invalid link'); }
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
        throw new Error('Invalid link');
    }
    return url.href;
}

async function handleFetch({ request, env }) {
    try {
        const authResponse = authenticateUpload(request, env);
        if (authResponse) return authResponse;

        if (!env.TG_Bot_Token || !env.TG_Chat_ID) {
            throw new Error('Server is missing TG_Bot_Token or TG_Chat_ID');
        }

        const body = await request.json().catch(() => null);
        if (!body || typeof body !== 'object') return json({ error: 'Invalid request' }, 400);

        let link, expiresIn;
        try {
            link = checkFetchUrl(body.url);
            expiresIn = checkExpiry(body.expiresIn);
        } catch (error) {
            return json({ error: error.message }, 400);
        }
        // Fail before anything reaches Telegram, not after an orphan upload.
        if (expiresIn) linkSecret(env);

        const form = new FormData();
        form.append('chat_id', env.TG_Chat_ID);
        form.append('document', link);
        const caption = uploaderCaption(request, env);
        if (caption) form.append('caption', caption);

        const result = await sendToTelegram(form, 'sendDocument', env);
        if (!result.success) throw failure(result, 'Telegram could not fetch that link');

        const fileId = getFileId(result.data);
        if (!fileId) throw new Error('Failed to get file ID');

        // Telegram may turn a video or audio link into a video/audio message instead of a document.
        const doc = result.data.result.document || result.data.result.video || result.data.result.audio || {};
        const fileName = String(doc.file_name || new URL(link).pathname.split('/').pop() || 'file').slice(0, 255);
        const extension = safeExtension(fileName, EXTENSION_BY_MIME[doc.mime_type] || 'bin');

        if (expiresIn) {
            const manifest = {
                v: 1,
                fileId,
                msgId: result.data.result.message_id,
                name: fileName,
                type: doc.mime_type || '',
                size: doc.file_size || 0,
                exp: Date.now() + expiresIn * 1000,
            };
            const manifestId = await createManifestLink(env, manifest);
            return json([{ src: `/s/${manifestId}.${extension}`, expires: manifest.exp }]);
        }

        return json([{ src: `/file/${fileId}.${extension}` }]);
    } catch (error) {
        if (error instanceof RateLimitedError) {
            return json(
                { error: 'Telegram is rate limiting uploads; retrying shortly.', retryAfter: error.retryAfter },
                429,
                { 'Retry-After': String(error.retryAfter) }
            );
        }
        console.error('Fetch-url error:', error);
        return json({ error: error.message }, 500);
    }
}

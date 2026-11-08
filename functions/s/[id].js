import { isCrawler, videoPreviewPage } from '../_lib/preview.js';
import { verifyManifest } from '../_lib/manifest.js';
import { isRefererAllowed, servePage, withFileHeaders } from '../_lib/serve.js';
import { deleteMessage, fetchTelegramFile, getFilePath, isValidFileId } from '../_lib/telegram.js';

const MAX_MANIFEST_BYTES = 8 * 1024;

const text = (body, status) => new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'Cache-Control': 'no-store' },
});

async function loadManifest(env, manifestId) {
    const path = await getFilePath(env, manifestId);
    if (!path) return null;
    const res = await fetchTelegramFile(env, path, new Request('https://manifest.invalid/'));
    if (!res.ok) return null;
    const raw = await res.text();
    if (raw.length > MAX_MANIFEST_BYTES) return null;
    try {
        const manifest = JSON.parse(raw);
        return (await verifyManifest(env, manifest)) ? manifest : null;
    } catch {
        return null;
    }
}

// /s/<manifest_id>.<ext>: serves the file a signed manifest points at, until
// the manifest's expiry. The real file id is never exposed to visitors.
export async function onRequest({ request, env, params }) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return text('Method not allowed', 405);
    }
    if (!isRefererAllowed(env, request, new URL(request.url))) {
        return text('Hotlinking is not allowed on this deployment.', 403);
    }

    const manifestId = String(params.id).split('.')[0];
    if (!isValidFileId(manifestId)) return text('Not found', 404);

    const manifest = await loadManifest(env, manifestId);
    if (!manifest || !isValidFileId(manifest.fileId)) return text('Not found', 404);

    if (typeof manifest.exp === 'number' && Date.now() >= manifest.exp) {
        if (manifest.msgId) await deleteMessage(env, manifest.msgId);
        return text('This link has expired.', 410);
    }

    // Password-protected: the browser decrypts. ?meta=1 returns what the unlock
    // page needs, ?raw=1 the ciphertext, anything else the unlock page itself.
    const query = new URL(request.url).searchParams;
    if (manifest.enc && !query.has('raw')) {
        if (!query.has('meta')) return servePage(env, request, 'unlock');
        return Response.json(
            { name: manifest.name, type: manifest.type, size: manifest.size, enc: manifest.enc },
            { headers: { 'Cache-Control': 'no-store' } }
        );
    }

    if (manifest.thumb && isValidFileId(manifest.thumb) && !manifest.enc && !query.has('raw') &&
        String(manifest.type).startsWith('video/') && isCrawler(request)) {
        const origin = new URL(request.url).origin;
        return videoPreviewPage({
            title: manifest.name || 'Shared video',
            videoUrl: `${origin}/s/${manifestId}?raw=1`,
            thumbUrl: `${origin}/file/${manifest.thumb}.jpg`,
            videoType: manifest.type,
        });
    }

    const filePath = await getFilePath(env, manifest.fileId);
    if (!filePath) return text('Not found', 404);

    const upstream = await fetchTelegramFile(env, filePath, request);
    if (!upstream.ok && upstream.status !== 206) return text('Upstream error', 502);

    // The stored bytes are ciphertext: never label them with the original type.
    const served = manifest.enc
        ? new Response(upstream.body, {
            status: upstream.status,
            headers: { 'Content-Type': 'application/octet-stream' },
        })
        : withFileHeaders(upstream, manifest.name || params.id);
    const headers = new Headers(served.headers);
    headers.set('Cache-Control', 'private, no-cache');
    headers.set('X-Robots-Tag', 'noindex');
    return new Response(served.body, { status: served.status, headers });
}

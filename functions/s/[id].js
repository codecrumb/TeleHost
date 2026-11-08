import { isCrawler, videoPreviewPage } from '../_lib/preview.js';
import { ConfigError, openManifest } from '../_lib/manifest.js';
import { busyResponse, isRefererAllowed, servePage, withFileHeaders } from '../_lib/serve.js';
import { RateLimitError, deleteMessage, fetchTelegramFile, getFilePath, isValidFileId } from '../_lib/telegram.js';

const MAX_MANIFEST_BYTES = 16 * 1024; // 64 parts of ~140 bytes plus metadata
const MAX_DELETES_PER_VISIT = 40; // each delete is a subrequest; Workers allow 50 on the free plan
const CLEANUP_INTERVAL_SECONDS = 3600;
const MAX_DELETES_WITHOUT_MEMORY = 5;
const CLEANUP_SAMPLE_RATE_WITHOUT_MEMORY = 0.2;

const text = (body, status) => new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'Cache-Control': 'no-store' },
});

async function loadManifest(env, manifestId) {
    const path = await getFilePath(env, manifestId);
    if (!path) return null;
    const res = await fetchTelegramFile(env, path, new Request('https://manifest.invalid/'));
    if (!res.ok) return null;
    // /s/<id> accepts any file id, so don't read a big unrelated file into memory.
    if (Number(res.headers.get('Content-Length')) > MAX_MANIFEST_BYTES) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    return bytes.length > MAX_MANIFEST_BYTES ? null : openManifest(env, bytes);
}

// Deleting the messages of an expired link is best effort, and must not become a
// way to burn the bot's Telegram rate limit by hammering one expired link. So: at
// most one cleanup per link per hour per Cloudflare location (remembered in the
// edge cache, no storage needed), and each cleanup deletes one slice of up to 40
// messages, a different slice each hour, so very large files are covered over
// time. Without a usable cache only a handful are deleted per visit.
async function cleanUpExpired(env, manifest, manifestId, isMultiPart) {
    const ids = [manifest.msgId, ...(isMultiPart ? manifest.parts.map(p => p && p.msgId) : [])].filter(Number.isInteger);
    if (!ids.length) return;

    let remembered = false;
    try {
        const marker = new Request(`https://cleanup.invalid/${manifestId}`);
        if (await caches.default.match(marker)) return;
        await caches.default.put(marker, new Response('1', { headers: { 'Cache-Control': `max-age=${CLEANUP_INTERVAL_SECONDS}` } }));
        // The Cache API is a silent no-op on some domains: only trust the marker if it reads back.
        remembered = !!(await caches.default.match(marker));
    } catch {
        // no edge cache here (or it failed): fall through with the small cap
    }

    // With no memory at all, a hammered link would trigger cleanup on every request;
    // sample instead, so the average cost stays a small fraction of a call per request.
    if (!remembered && Math.random() >= CLEANUP_SAMPLE_RATE_WITHOUT_MEMORY) return;

    const limit = remembered ? MAX_DELETES_PER_VISIT : MAX_DELETES_WITHOUT_MEMORY;
    const slices = Math.ceil(ids.length / limit);
    const slice = Math.floor(Date.now() / (CLEANUP_INTERVAL_SECONDS * 1000)) % slices;
    await Promise.all(ids.slice(slice * limit, (slice + 1) * limit).map(id => deleteMessage(env, id)));
}

// /s/<manifest_id>.<ext>: serves the file a signed manifest points at, until
// the manifest's expiry. The real file id is never exposed to visitors.
export async function onRequest(context) {
    try {
        return await serve(context);
    } catch (error) {
        if (error instanceof RateLimitError) return busyResponse(error.retryAfter);
        if (error instanceof ConfigError) return text(error.message, 500);
        throw error;
    }
}

async function serve({ request, env, params }) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return text('Method not allowed', 405);
    }
    if (!isRefererAllowed(env, request, new URL(request.url))) {
        return text('Hotlinking is not allowed on this deployment.', 403);
    }

    const manifestId = String(params.id).split('.')[0];
    if (!isValidFileId(manifestId)) return text('Not found', 404);

    const manifest = await loadManifest(env, manifestId);
    const isMultiPart = !!manifest && Array.isArray(manifest.parts);
    if (!manifest || (!isMultiPart && !isValidFileId(manifest.fileId))) return text('Not found', 404);
    const query = new URL(request.url).searchParams;

    if (typeof manifest.exp === 'number' && Date.now() >= manifest.exp) {
        await cleanUpExpired(env, manifest, manifestId, isMultiPart);
        return text('This link has expired.', 410);
    }

    // A big file stored as parts: the unlock page downloads them one by one
    // (?part=N), so a request never needs more than a few subrequests.
    if (isMultiPart) {
        if (!manifest.parts.length || !manifest.parts.every(p => p && isValidFileId(p.fileId))) {
            return text('Not found', 404);
        }
        if (query.has('meta')) {
            return Response.json(
                { name: manifest.name, type: manifest.type, size: manifest.size, enc: manifest.enc || null, parts: manifest.parts.map(p => p.size) },
                { headers: { 'Cache-Control': 'no-store' } }
            );
        }
        if (!query.has('part')) return servePage(env, request, 'unlock');

        const index = /^\d{1,3}$/.test(query.get('part')) ? Number(query.get('part')) : -1;
        const part = manifest.parts[index];
        if (!part) return text('Not found', 404);
        const partPath = await getFilePath(env, part.fileId);
        if (!partPath) return text('Not found', 404);
        const upstreamPart = await fetchTelegramFile(env, partPath, request);
        if (upstreamPart.status === 429) return busyResponse(upstreamPart.headers.get('Retry-After'));
        if (!upstreamPart.ok && upstreamPart.status !== 206) return text('Upstream error', 502);
        return new Response(upstreamPart.body, {
            status: upstreamPart.status,
            headers: {
                'Content-Type': 'application/octet-stream',
                'X-Content-Type-Options': 'nosniff',
                'Cache-Control': 'private, no-cache',
            },
        });
    }

    // Password-protected: the browser decrypts. ?meta=1 returns what the unlock
    // page needs, ?raw=1 the ciphertext, anything else the unlock page itself.
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
    if (upstream.status === 429) return busyResponse(upstream.headers.get('Retry-After'));
    if (!upstream.ok && upstream.status !== 206) return text('Upstream error', 502);

    // The stored bytes are ciphertext: never label them with the original type.
    const served = manifest.enc
        ? new Response(upstream.body, {
            status: upstream.status,
            headers: { 'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' },
        })
        : withFileHeaders(upstream, manifest.name || params.id);
    const headers = new Headers(served.headers);
    headers.set('Cache-Control', 'private, no-cache');
    headers.set('X-Robots-Tag', 'noindex');
    return new Response(served.body, { status: served.status, headers });
}

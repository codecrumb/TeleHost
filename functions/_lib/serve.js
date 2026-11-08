// ALLOWED_REFERERS is a comma-separated hostname allowlist ("example.com,*.example.org").
// Empty referers (direct visits, curl, native apps) always pass, as does the
// deployment's own origin; the feature is off when the var is unset.
export function isRefererAllowed(env, request, url) {
    const allowlist = String(env.ALLOWED_REFERERS || '')
        .split(',')
        .map(entry => entry.trim().toLowerCase())
        .filter(Boolean);
    if (allowlist.length === 0) return true;

    const referer = request.headers.get('Referer');
    if (!referer) return true;

    let host;
    try {
        host = new URL(referer).hostname.toLowerCase();
    } catch {
        return false;
    }
    if (host === url.hostname.toLowerCase()) return true;

    return allowlist.some(pattern => {
        if (pattern.startsWith('*.')) {
            const base = pattern.slice(2);
            return host === base || host.endsWith('.' + base);
        }
        return host === pattern;
    });
}

// svg is deliberately absent: serving user uploads as image/svg+xml would
// allow stored XSS on the deployment's own origin.
export const CONTENT_TYPES_BY_EXTENSION = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', avif: 'image/avif', apng: 'image/apng', bmp: 'image/bmp',
    ico: 'image/x-icon',
    mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', oga: 'audio/ogg',
    wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac',
    pdf: 'application/pdf',
};

// Only these are ever rendered inline. Everything else is a download, so an
// uploaded .html or .svg can never run script on this origin, whatever
// Content-Type Telegram guessed for it.
const SAFE_INLINE = /^(image\/(png|jpeg|gif|webp|avif|apng|bmp|x-icon|vnd\.microsoft\.icon)|video\/|audio\/|application\/pdf)/;

export function withFileHeaders(response, filename) {
    const upstreamType = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    const extension = String(filename).split('.').pop().toLowerCase();
    // Telegram often answers application/octet-stream, which breaks previews:
    // fall back to our own extension map (which only holds safe types).
    const type = SAFE_INLINE.test(upstreamType) ? upstreamType : (CONTENT_TYPES_BY_EXTENSION[extension] || null);
    const safeName = String(filename).replace(/["\\\r\n]/g, '_');

    const headers = new Headers(response.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    if (type) {
        headers.set('Content-Type', type);
        headers.set('Content-Disposition', `inline; filename="${safeName}"`);
        // Chrome refuses to show PDFs under a sandbox policy; everything else is fine.
        if (type !== 'application/pdf') headers.set('Content-Security-Policy', 'sandbox');
    } else {
        headers.set('Content-Type', 'application/octet-stream');
        headers.set('Content-Disposition', `attachment; filename="${safeName}"`);
    }
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

// Serves a static page (e.g. "join" -> join.html) under a dynamic route.
// Pages serves join.html at the clean URL /join and redirects /join.html there.
export async function servePage(env, request, name) {
    let page = await env.ASSETS.fetch(new URL('/' + name, request.url));
    if (page.status >= 300 && page.status < 400 && page.headers.get('Location')) {
        page = await env.ASSETS.fetch(new URL(page.headers.get('Location'), request.url));
    }
    return new Response(page.body, {
        status: page.status,
        headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-cache' },
    });
}

export function busyResponse(retryAfter) {
    const seconds = Number(retryAfter) > 0 ? Math.ceil(Number(retryAfter)) : 5;
    return new Response('Telegram is busy, retry shortly.', {
        status: 429,
        headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'Retry-After': String(seconds), 'Cache-Control': 'no-store' },
    });
}

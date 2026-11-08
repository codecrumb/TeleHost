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
const CONTENT_TYPES_BY_EXTENSION = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', avif: 'image/avif', apng: 'image/apng', bmp: 'image/bmp',
    ico: 'image/x-icon',
    mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', oga: 'audio/ogg',
    wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac',
    pdf: 'application/pdf',
};

// Telegram often serves files as application/octet-stream, which breaks
// previews. Derive the type from the extension and serve previewable types inline.
export function withFileHeaders(response, filename) {
    const upstreamType = response.headers.get('Content-Type') || '';
    const usable = upstreamType !== '' && !upstreamType.startsWith('application/octet-stream');
    const extension = String(filename).split('.').pop().toLowerCase();
    const correctedType = usable ? null : (CONTENT_TYPES_BY_EXTENSION[extension] || null);
    const effectiveType = correctedType || upstreamType;
    const inline = /^(image|video|audio)\//.test(effectiveType)
        || effectiveType.startsWith('application/pdf');

    if (!correctedType && !inline) return response;

    const headers = new Headers(response.headers);
    if (correctedType) headers.set('Content-Type', correctedType);
    if (inline) {
        headers.set('Content-Disposition', `inline; filename="${String(filename).replace(/["\\\r\n]/g, '_')}"`);
    }
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

// Which web pages may upload to this deployment.
//
// Uploads come from three kinds of client:
//   * this site's own page (same origin),
//   * programs that are not web pages (curl, ShareX, phone apps): these send no
//     browser headers at all, and are always welcome,
//   * a web page on ANOTHER site, running in a visitor's browser: only if that site
//     is listed in ALLOWED_UPLOAD_ORIGINS (hostnames, e.g. "example.com,*.example.org";
//     https on the default port only, apart from localhost for development).
//     The old ALLOWED_REFERERS variable is deliberately NOT read: it was a list of
//     sites for a different purpose and must never silently become upload rights.
//     Everything else is refused, so
//     a stranger's page cannot use the people visiting it to upload to you, or ride
//     on their cached Basic-auth credentials.
//
// Listed sites also get CORS headers, so their page can read the returned link
// (a cross-site POST is otherwise "send-only": the browser hides the response).
// Embedding and link clicks are deliberately not restricted anywhere.

function allowlist(env) {
    return String(env.ALLOWED_UPLOAD_ORIGINS ?? '')
        .split(',')
        .map(entry => entry.trim().toLowerCase())
        .filter(Boolean);
}

function hostListed(env, host) {
    return allowlist(env).some(pattern => {
        if (pattern.startsWith('*.')) {
            const base = pattern.slice(2);
            return host === base || host.endsWith('.' + base);
        }
        return host === pattern;
    });
}

// -> { ok: true, origin: null }   same origin, or not a web page at all
//    { ok: true, origin: '<o>' }  an allowed other site: add CORS headers for it
//    { ok: false }                refuse
export function checkUploadOrigin(request, env) {
    const own = new URL(request.url).origin;
    const origin = request.headers.get('Origin');
    const site = request.headers.get('Sec-Fetch-Site');

    if (!origin) {
        // No Origin: a program, or a same-origin GET-style request. A browser that
        // says it is cross-site without an Origin is not one we trust.
        return site && site !== 'same-origin' && site !== 'none' ? { ok: false } : { ok: true, origin: null };
    }
    if (origin === own) return { ok: true, origin: null };

    let parsed;
    try {
        parsed = new URL(origin); // "null" (sandboxed pages) and junk throw
    } catch {
        return { ok: false };
    }
    const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    // Another port of a listed host is another application, so only the default
    // port counts (any port for localhost, which is for development).
    const trustedAddress = (parsed.protocol === 'https:' && parsed.port === '') || local;
    if (parsed.origin === origin && trustedAddress && hostListed(env, parsed.hostname.toLowerCase())) {
        return { ok: true, origin };
    }
    return { ok: false };
}

const cors = origin => ({
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true', // so a listed site can reach an upload-password-protected deployment
    'Vary': 'Origin',
});

export function withCors(response, origin) {
    if (!origin) return response;
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(cors(origin))) headers.set(name, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function refusal() {
    return new Response(JSON.stringify({ error: 'Uploads from this site are not allowed.' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
}

// Answers the browser's preflight for a listed site (e.g. before the JSON POST to /finalize).
export function preflight(request, env) {
    const gate = checkUploadOrigin(request, env);
    if (!gate.ok) return refusal();
    if (!gate.origin) return new Response(null, { status: 204 });
    return new Response(null, {
        status: 204,
        headers: {
            ...cors(gate.origin),
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Max-Age': '86400',
        },
    });
}

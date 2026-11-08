import { busyResponse, servePage } from '../_lib/serve.js';
import { ConfigError, verifyRenderLink } from '../_lib/manifest.js';
import { htmlRenderEnabled } from '../_lib/options.js';
import { RateLimitError, fetchTelegramFile, getFilePath, isValidFileId } from '../_lib/telegram.js';

const text = (body, status, headers = {}) => new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'Cache-Control': 'no-store', ...headers },
});

// An uploaded page runs in a sandbox with no origin of its own (CSP "sandbox"
// without allow-same-origin): it cannot read this site's localStorage or cookies,
// and a request it makes to this site is cross-origin, which the upload CSRF
// check refuses. It may still run scripts and show forms, as a web page would.
const SANDBOX = "sandbox allow-scripts allow-forms allow-modals allow-popups; frame-ancestors 'none'";

// The notice must not be skippable by sharing the second URL, so the raw page is
// only served when the request comes from one of our own pages (the notice).
function cameFromOurPage(request, url) {
    const site = request.headers.get('Sec-Fetch-Site');
    if (site) return site === 'same-origin';
    try {
        return new URL(request.headers.get('Referer')).origin === url.origin; // browsers without Fetch Metadata
    } catch {
        return false;
    }
}

export async function onRequest(context) {
    try {
        return await serve(context);
    } catch (error) {
        if (error instanceof RateLimitError) return busyResponse(error.retryAfter);
        if (error instanceof ConfigError) return text(error.message, 500);
        throw error;
    }
}

// /v/<file_id>~<tag>.html         -> the "External Content Notice" page
// /v/<file_id>~<tag>.html?open=1  -> the uploaded page itself, sandboxed
// The tag is issued by /upload only for files whose uploader asked for this.
async function serve({ request, env, params }) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return text('Method not allowed', 405, { Allow: 'GET, HEAD' });
    // Off unless the operator turns it on: serving other people's pages is their call.
    if (!htmlRenderEnabled(env)) return text('Not found', 404);

    const url = new URL(request.url);

    const filename = String(params.id);
    const [fileId, tag] = filename.split('.')[0].split('~');
    const extension = filename.split('.').pop().toLowerCase();
    if (!isValidFileId(fileId) || !['html', 'htm'].includes(extension) || !(await verifyRenderLink(env, fileId, tag))) {
        return text('Not found', 404);
    }

    if (!url.searchParams.has('open')) return servePage(env, request, 'view');
    if (!cameFromOurPage(request, url)) return Response.redirect(url.origin + url.pathname, 303);

    const filePath = await getFilePath(env, fileId);
    if (!filePath) return text('Not found', 404);
    const upstream = await fetchTelegramFile(env, filePath, request);
    if (upstream.status === 429) return busyResponse(upstream.headers.get('Retry-After'));
    if (!upstream.ok && upstream.status !== 206) return text('Upstream error', 502);

    return new Response(upstream.body, {
        status: upstream.status,
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': SANDBOX,
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
            'X-Robots-Tag': 'noindex',
            'Cache-Control': 'private, no-cache',
        },
    });
}

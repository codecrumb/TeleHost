// /join/<manifestId> serves the static join page. The page reads the manifest
// id from the path, so the link survives URL shorteners that strip query strings.
export async function onRequest({ request, env }) {
    // Pages serves join.html at the clean URL /join (and redirects /join.html there).
    let page = await env.ASSETS.fetch(new URL('/join', request.url));
    if (page.status >= 300 && page.status < 400 && page.headers.get('Location')) {
        page = await env.ASSETS.fetch(new URL(page.headers.get('Location'), request.url));
    }
    return new Response(page.body, {
        status: page.status,
        headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-cache' },
    });
}

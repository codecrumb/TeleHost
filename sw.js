// Minimal service worker whose only job is the Android share target: the share
// sheet POSTs the chosen files to /share-target, which cannot be handled by the
// page itself. The worker parks the files in a temporary cache and redirects to
// the upload page, which picks them up (after asking) and uploads them as usual.
// Everything else passes straight through: nothing else is cached, so pages can
// never be served stale.

const CACHE = 'th-shared';
const MAX_FILES = 50;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    if (event.request.method === 'POST' && url.origin === self.location.origin && url.pathname === '/share-target') {
        event.respondWith(receiveShare(event.request));
    }
});

async function receiveShare(request) {
    const back = query => Response.redirect(new URL('/?shared=' + query, self.location.origin).href, 303);
    try {
        const form = await request.formData();
        const files = form.getAll('files').filter(file => typeof file !== 'string').slice(0, MAX_FILES);
        const cache = await caches.open(CACHE);
        for (const key of await cache.keys()) await cache.delete(key); // never mix with an earlier share
        let stored = 0;
        for (const file of files) {
            await cache.put(
                new Request(self.location.origin + '/shared/' + stored),
                new Response(file, {
                    headers: {
                        'Content-Type': file.type || 'application/octet-stream',
                        'X-File-Name': encodeURIComponent(file.name || 'shared-file'),
                    },
                })
            );
            stored++;
        }
        return back(stored ? String(stored) : 'error');
    } catch {
        return back('error');
    }
}

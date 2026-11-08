// POST /share-target is normally answered by the service worker (sw.js). It only
// reaches the server if the worker is not active yet, for example the very first
// share right after installing the app: send the user back with an explanation
// instead of an error page.
export function onRequest({ request }) {
    return Response.redirect(new URL('/?shared=unavailable', request.url).href, 303);
}

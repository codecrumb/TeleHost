import { htmlRenderEnabled } from './_lib/options.js';

// What the upload page needs to know about this deployment so it can hide options
// that would do nothing. Only yes/no feature flags, never a value from the
// environment; whether HTML rendering is on is also discoverable by just trying it.
export function onRequestGet({ env }) {
    return Response.json(
        { htmlRender: htmlRenderEnabled(env) },
        { headers: { 'Cache-Control': 'public, max-age=60', 'X-Content-Type-Options': 'nosniff' } }
    );
}

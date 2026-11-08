import { servePage } from '../_lib/serve.js';

// /join/<manifestId> serves the static join page. The page reads the manifest
// id from the path, so the link survives URL shorteners that strip query strings.
export function onRequest({ request, env }) {
    return servePage(env, request, 'join');
}

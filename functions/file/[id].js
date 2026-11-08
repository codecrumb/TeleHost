import { isRefererAllowed, withFileHeaders } from '../_lib/serve.js';
import { fetchTelegramFile, getFilePath, isValidFileId } from '../_lib/telegram.js';

export async function onRequest({ request, env, params }) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }

    const url = new URL(request.url);

    // Anti-hotlinking: reject disallowed referers before spending upstream bandwidth
    if (!isRefererAllowed(env, request, url)) {
        return new Response('Hotlinking is not allowed on this deployment.', {
            status: 403,
            headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        });
    }

    // /file/<file_id>.<ext>
    const filename = String(params.id);
    const fileId = filename.split('.')[0];
    if (!isValidFileId(fileId)) {
        return new Response('Not found', { status: 404 });
    }

    const filePath = await getFilePath(env, fileId);
    if (!filePath) {
        return new Response('Not found', { status: 404 });
    }

    const response = await fetchTelegramFile(env, filePath, request);
    if (!response.ok && response.status !== 206) {
        return new Response('Upstream error', { status: response.status === 404 ? 404 : 502 });
    }
    return withFileHeaders(response, filename);
}

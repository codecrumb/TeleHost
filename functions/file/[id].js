import { isCrawler, videoPreviewPage } from '../_lib/preview.js';
import { CONTENT_TYPES_BY_EXTENSION, busyResponse, hotlinkResponse, isRefererAllowed, withFileHeaders } from '../_lib/serve.js';
import { RateLimitError, fetchTelegramFile, getFilePath, isValidFileId } from '../_lib/telegram.js';

export async function onRequest(context) {
    try {
        return await serve(context);
    } catch (error) {
        if (error instanceof RateLimitError) return busyResponse(error.retryAfter);
        throw error;
    }
}

async function serve({ request, env, params }) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }

    const url = new URL(request.url);

    // Anti-hotlinking: reject disallowed referers before spending upstream bandwidth
    if (!isRefererAllowed(env, request, url)) return hotlinkResponse(request);

    // /file/<file_id>.<ext>, or /file/<video_id>~<thumbnail_id>.<ext> for videos
    const filename = String(params.id);
    const [fileId, thumbId] = filename.split('.')[0].split('~');
    const extension = filename.split('.').pop().toLowerCase();
    if (!isValidFileId(fileId) || (thumbId !== undefined && !isValidFileId(thumbId))) {
        return new Response('Not found', { status: 404 });
    }

    // Link-preview bots get the thumbnail through Open Graph tags; the plain
    // /file/<video_id>.<ext> URL below is what they (and players) fetch as video.
    const videoType = CONTENT_TYPES_BY_EXTENSION[extension];
    if (thumbId && videoType && videoType.startsWith('video/') && isCrawler(request)) {
        return videoPreviewPage({
            title: 'Shared video',
            videoUrl: `${url.origin}/file/${fileId}.${extension}`,
            thumbUrl: `${url.origin}/file/${thumbId}.jpg`,
            videoType,
        });
    }

    const filePath = await getFilePath(env, fileId);
    if (!filePath) {
        return new Response('Not found', { status: 404 });
    }

    const response = await fetchTelegramFile(env, filePath, request);
    if (response.status === 429) return busyResponse(response.headers.get('Retry-After'));
    if (!response.ok && response.status !== 206) {
        return new Response('Upstream error', { status: response.status === 404 ? 404 : 502 });
    }
    return withFileHeaders(response, filename);
}

// Sending to Telegram, shared by /upload and /finalize.

import { sealManifest } from './manifest.js';

// Thrown when Telegram rate limits an upload; becomes a 429 the browser retries.
export class RateLimitedError extends Error {
    constructor(retryAfter) {
        super('Telegram is rate limiting uploads');
        this.retryAfter = retryAfter;
    }
}

export function failure(result, fallbackMessage) {
    return result.retryAfter ? new RateLimitedError(result.retryAfter) : new Error(result.error || fallbackMessage);
}

export function getFileId(response) {
    if (!response.ok || !response.result) return null;

    const result = response.result;
    if (result.photo) {
        return result.photo.reduce((prev, current) =>
            (prev.file_size > current.file_size) ? prev : current
        ).file_id;
    }
    if (result.document) return result.document.file_id;
    if (result.video) return result.video.file_id;
    if (result.audio) return result.audio.file_id;

    return null;
}

export async function sendToTelegram(formData, apiEndpoint, env, retryCount = 0) {
    const MAX_RETRIES = 2;
    const apiUrl = `https://api.telegram.org/bot${env.TG_Bot_Token}/${apiEndpoint}`;

    try {
        const response = await fetch(apiUrl, { method: "POST", body: formData });
        const responseData = await response.json();

        if (response.ok) {
            return { success: true, data: responseData };
        }

        // 图片上传失败时转为文档方式重试
        const rateLimited = responseData.error_code === 429;
        if (!rateLimited && retryCount < MAX_RETRIES && apiEndpoint === 'sendPhoto') {
            console.log('Retrying image as document...');
            const newFormData = new FormData();
            newFormData.append('chat_id', formData.get('chat_id'));
            if (formData.get('caption')) newFormData.append('caption', formData.get('caption'));
            newFormData.append('document', formData.get('photo'));
            const fallbackResult = await sendToTelegram(newFormData, 'sendDocument', env, retryCount + 1);
            if (fallbackResult.success) fallbackResult.usedFallback = true;
            return fallbackResult;
        }

        return {
            success: false,
            error: responseData.description || 'Upload to Telegram failed',
            retryAfter: rateLimited ? Math.ceil((responseData.parameters && responseData.parameters.retry_after) || 5) : null,
        };
    } catch (error) {
        console.error('Network error:', error);
        if (retryCount < MAX_RETRIES) {
            await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
            return await sendToTelegram(formData, apiEndpoint, env, retryCount + 1);
        }
        return { success: false, error: 'Network error occurred' };
    }
}

// Seals a manifest (see manifest.js), stores it as a document in the channel and returns its file id,
// which is what /s/<id> links carry.
export async function createManifestLink(env, manifest) {
    const form = new FormData();
    form.append('chat_id', env.TG_Chat_ID);
    form.append('document', new Blob([await sealManifest(env, manifest)], { type: 'application/octet-stream' }), 'link.bin');
    const result = await sendToTelegram(form, 'sendDocument', env);
    if (!result.success) throw failure(result, 'Failed to create link');
    const manifestId = getFileId(result.data);
    if (!manifestId) throw new Error('Failed to create link');
    return manifestId;
}

// Off unless LOG_UPLOADER_IP=true. The IP comes from Cloudflare's own header,
// never from client-controlled ones like X-Forwarded-For.
export function uploaderCaption(request, env) {
    if (String(env.LOG_UPLOADER_IP).toLowerCase() !== 'true') return null;
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip) return null;
    const country = request.cf && request.cf.country;
    return country ? `Uploader: ${ip} (${country})` : `Uploader: ${ip}`;
}

import { authenticateUpload } from './_lib/auth.js';
import { signManifest, signReceipt } from './_lib/manifest.js';
import { checkEncryption, checkExpiry, cleanMeta } from './_lib/options.js';
import { RateLimitedError, createManifestLink, failure, getFileId, sendToTelegram } from './_lib/send.js';

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        const authResponse = authenticateUpload(request, env);
        if (authResponse) {
            return authResponse;
        }

        if (!env.TG_Bot_Token || !env.TG_Chat_ID) {
            throw new Error('Server is missing TG_Bot_Token or TG_Chat_ID');
        }

        const clonedRequest = request.clone();
        const formData = await clonedRequest.formData();

        const uploadFile = formData.get('file');
        if (!uploadFile) {
            throw new Error('No file uploaded');
        }
        // Telegram bots can upload at most 50 MB; fail with a clear message.
        if (uploadFile.size > 50 * 1024 * 1024) {
            throw new Error('File exceeds the 50 MB Telegram upload limit');
        }

        const expiresIn = checkExpiry(formData.get('expiresIn'));
        const enc = parseEncryption(formData);

        const fileName = uploadFile.name;
        const fileExtension = fileName.split('.').pop().toLowerCase();

        const telegramFormData = new FormData();
        telegramFormData.append("chat_id", env.TG_Chat_ID);

        const caption = uploaderCaption(request, env);
        if (caption) telegramFormData.append("caption", caption);

        const compressionMode = formData.get('compressionMode') || 'compressed';

        let apiEndpoint;
        if (uploadFile.type.startsWith('image/')) {
            if (compressionMode === 'original') {
                telegramFormData.append("document", uploadFile);
                apiEndpoint = 'sendDocument';
            } else {
                telegramFormData.append("photo", uploadFile);
                apiEndpoint = 'sendPhoto';
            }
        } else if (uploadFile.type.startsWith('audio/')) {
            telegramFormData.append("audio", uploadFile);
            apiEndpoint = 'sendAudio';
        } else if (uploadFile.type.startsWith('video/')) {
            telegramFormData.append("video", uploadFile);
            telegramFormData.append("supports_streaming", "true");
            const thumbnail = formData.get('thumbnail');
            // Bot API: JPEG, at most 200 kB. Telegram falls back to its own thumbnail.
            if (thumbnail && typeof thumbnail !== 'string' && thumbnail.type === 'image/jpeg' && thumbnail.size <= 200 * 1024) {
                telegramFormData.append("thumbnail", thumbnail, 'thumb.jpg');
            }
            apiEndpoint = 'sendVideo';
        } else {
            telegramFormData.append("document", uploadFile);
            apiEndpoint = 'sendDocument';
        }

        const result = await sendToTelegram(telegramFormData, apiEndpoint, env);

        if (!result.success) {
            throw failure(result, 'Upload to Telegram failed');
        }

        const fileId = getFileId(result.data);

        if (!fileId) {
            throw new Error('Failed to get file ID');
        }

        // A chunk of a bigger file: hand back a signed receipt, which /finalize needs.
        if (formData.get('part')) {
            const receipt = await signReceipt(env, { fileId, msgId: result.data.result.message_id, size: uploadFile.size });
            return new Response(
                JSON.stringify([{ 'src': `/file/${fileId}.${fileExtension}`, 'receipt': receipt }]),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // Videos carry their thumbnail's file id so link previews can show it.
        // Never for encrypted uploads, whose content must stay opaque.
        const thumbId = enc ? null : getThumbId(result.data);

        if (expiresIn || enc) {
            // For encrypted uploads the file is ciphertext; the manifest keeps the
            // original name/type/size so the unlock page can restore them.
            const manifest = await signManifest(env, {
                v: 1,
                fileId,
                msgId: result.data.result.message_id,
                name: enc ? enc.name : fileName,
                type: enc ? enc.type : (uploadFile.type || ''),
                size: enc ? enc.size : uploadFile.size,
                ...(expiresIn ? { exp: Date.now() + expiresIn * 1000 } : {}),
                ...(enc ? { enc: enc.params } : {}),
                ...(thumbId ? { thumb: thumbId } : {}),
            });
            const manifestId = await createManifestLink(env, manifest);
            return new Response(
                JSON.stringify([{ 'src': enc ? `/s/${manifestId}` : `/s/${manifestId}.${fileExtension}`, 'fallback': result.usedFallback || false, 'expires': manifest.exp }]),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        }

        return new Response(
            JSON.stringify([{ 'src': `/file/${fileId}${thumbId ? '~' + thumbId : ''}.${fileExtension}`, 'fallback': result.usedFallback || false }]),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    } catch (error) {
        if (error instanceof RateLimitedError) {
            return new Response(
                JSON.stringify({ error: 'Telegram is rate limiting uploads; retrying shortly.', retryAfter: error.retryAfter }),
                { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(error.retryAfter) } }
            );
        }
        console.error('Upload error:', error);
        return new Response(
            JSON.stringify({ error: error.message }),
            {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    }
}

// Off unless LOG_UPLOADER_IP=true. The IP comes from Cloudflare's own header,
// never from client-controlled ones like X-Forwarded-For.
function uploaderCaption(request, env) {
    if (String(env.LOG_UPLOADER_IP).toLowerCase() !== 'true') return null;
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip) return null;
    const country = request.cf && request.cf.country;
    return country ? `Uploader: ${ip} (${country})` : `Uploader: ${ip}`;
}

// Form fields -> validated encryption info, or null for a normal upload.
function parseEncryption(formData) {
    if (!formData.get('encSalt')) return null;
    return {
        params: checkEncryption({
            salt: formData.get('encSalt'),
            iv: formData.get('encIv'),
            iter: formData.get('encIter'),
        }, 'single'),
        ...cleanMeta({ name: formData.get('encName'), type: formData.get('encType'), size: formData.get('encSize') }),
    };
}

function getThumbId(response) {
    const video = response.ok && response.result && response.result.video;
    const thumb = video && (video.thumbnail || video.thumb);
    return thumb && thumb.file_id ? thumb.file_id : null;
}

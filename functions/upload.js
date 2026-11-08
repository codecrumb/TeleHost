import { signManifest } from './_lib/manifest.js';

const MAX_EXPIRY_SECONDS = 30 * 24 * 60 * 60;

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

        const expiresIn = parseExpiry(formData.get('expiresIn'));

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
            apiEndpoint = 'sendVideo';
        } else {
            telegramFormData.append("document", uploadFile);
            apiEndpoint = 'sendDocument';
        }

        const result = await sendToTelegram(telegramFormData, apiEndpoint, env);

        if (!result.success) {
            throw new Error(result.error);
        }

        const fileId = getFileId(result.data);

        if (!fileId) {
            throw new Error('Failed to get file ID');
        }

        if (expiresIn) {
            const manifest = await signManifest(env, {
                v: 1,
                fileId,
                msgId: result.data.result.message_id,
                name: fileName,
                type: uploadFile.type || '',
                size: uploadFile.size,
                exp: Date.now() + expiresIn * 1000,
            });
            const manifestForm = new FormData();
            manifestForm.append('chat_id', env.TG_Chat_ID);
            manifestForm.append('document', new Blob([JSON.stringify(manifest)], { type: 'application/json' }), 'link.json');
            const manifestResult = await sendToTelegram(manifestForm, 'sendDocument', env);
            const manifestId = manifestResult.success && getFileId(manifestResult.data);
            if (!manifestId) throw new Error('Failed to create expiring link');
            return new Response(
                JSON.stringify([{ 'src': `/s/${manifestId}.${fileExtension}`, 'fallback': result.usedFallback || false, 'expires': manifest.exp }]),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        }

        return new Response(
            JSON.stringify([{ 'src': `/file/${fileId}.${fileExtension}`, 'fallback': result.usedFallback || false }]),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    } catch (error) {
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

// Seconds until the link expires; null when the upload has no expiry.
function parseExpiry(value) {
    if (value === null || value === undefined || value === '') return null;
    const seconds = Number(value);
    if (!Number.isInteger(seconds) || seconds < 60 || seconds > MAX_EXPIRY_SECONDS) {
        throw new Error('Invalid expiry');
    }
    return seconds;
}

function getFileId(response) {
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

async function sendToTelegram(formData, apiEndpoint, env, retryCount = 0) {
    const MAX_RETRIES = 2;
    const apiUrl = `https://api.telegram.org/bot${env.TG_Bot_Token}/${apiEndpoint}`;

    try {
        const response = await fetch(apiUrl, { method: "POST", body: formData });
        const responseData = await response.json();

        if (response.ok) {
            return { success: true, data: responseData };
        }

        // 图片上传失败时转为文档方式重试
        if (retryCount < MAX_RETRIES && apiEndpoint === 'sendPhoto') {
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
            error: responseData.description || 'Upload to Telegram failed'
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
// Optional Basic Auth for uploads. Uploads stay public unless both
// UPLOAD_BASIC_USER and UPLOAD_BASIC_PASS are set.
function authenticateUpload(request, env) {
    const hasUser = !!env.UPLOAD_BASIC_USER;
    const hasPass = !!env.UPLOAD_BASIC_PASS;
    if (!hasUser && !hasPass) return null;

    const json = (body, status, extra = {}) => new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
    });

    if (!hasUser || !hasPass) {
        return json({ error: 'UPLOAD_BASIC_USER and UPLOAD_BASIC_PASS must both be set' }, 500);
    }

    const challenge = { 'WWW-Authenticate': 'Basic realm="upload", charset="UTF-8"' };
    const [scheme, encoded] = (request.headers.get('Authorization') || '').split(' ');
    if (!encoded || scheme !== 'Basic') {
        return json({ error: 'You need to login.' }, 401, challenge);
    }

    let decoded;
    try {
        decoded = new TextDecoder().decode(Uint8Array.from(atob(encoded), c => c.charCodeAt(0))).normalize();
    } catch (e) {
        return json({ error: 'Malformed authorization header.' }, 400);
    }
    const index = decoded.indexOf(':');
    if (index === -1 || /[\0-\x1F\x7F]/.test(decoded)) {
        return json({ error: 'Malformed authorization header.' }, 400);
    }

    const userOk = timingSafeEqual(env.UPLOAD_BASIC_USER, decoded.substring(0, index));
    const passOk = timingSafeEqual(env.UPLOAD_BASIC_PASS, decoded.substring(index + 1));
    if (!userOk || !passOk) {
        return json({ error: 'Invalid upload credentials.' }, 401, challenge);
    }
    return null;
}

// Constant-time string comparison to mitigate timing attacks.
function timingSafeEqual(a, b) {
    const aStr = String(a);
    const bStr = String(b);
    if (aStr.length !== bStr.length) return false;
    let result = 0;
    for (let i = 0; i < aStr.length; i++) {
        result |= aStr.charCodeAt(i) ^ bStr.charCodeAt(i);
    }
    return result === 0;
}

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

        const fileName = uploadFile.name;
        const fileExtension = fileName.split('.').pop().toLowerCase();

        const telegramFormData = new FormData();
        telegramFormData.append("chat_id", env.TG_Chat_ID);

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

        // 将文件信息保存到 KV 存储
        if (env.img_url) {
            await env.img_url.put(`${fileId}.${fileExtension}`, "", {
                metadata: {
                    TimeStamp: Date.now(),
                    ListType: "None",
                    Label: "None",
                    liked: false,
                    fileName: fileName,
                    fileSize: uploadFile.size,
                }
            });
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

// Telegram Bot API helpers shared by the Pages Functions.

// Bot file IDs are URL-safe base64; anything else never reaches the API.
export function isValidFileId(fileId) {
    return typeof fileId === 'string' && /^[A-Za-z0-9_-]{20,}$/.test(fileId);
}

// Resolves a bot file_id to the path used by api.telegram.org/file/.
// Never log the URLs built here: they contain the bot token.
export async function getFilePath(env, fileId) {
    try {
        const res = await fetch(
            `https://api.telegram.org/bot${env.TG_Bot_Token}/getFile?file_id=${encodeURIComponent(fileId)}`
        );
        if (!res.ok) {
            console.error(`getFile failed with HTTP ${res.status}`);
            return null;
        }
        const { ok, result } = await res.json();
        return ok && result && result.file_path ? result.file_path : null;
    } catch (error) {
        console.error('getFile error:', error.message);
        return null;
    }
}

// Streams a file from Telegram. Only Range is forwarded from the client
// request, so no client headers or body ever reach Telegram.
export function fetchTelegramFile(env, filePath, request) {
    const headers = new Headers();
    const range = request.headers.get('Range');
    if (range) headers.set('Range', range);
    return fetch(`https://api.telegram.org/file/bot${env.TG_Bot_Token}/${filePath}`, {
        method: request.method === 'HEAD' ? 'HEAD' : 'GET',
        headers,
    });
}

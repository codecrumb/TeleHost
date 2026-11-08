// Optional Basic Auth for uploads. Uploads stay public unless both
// UPLOAD_BASIC_USER and UPLOAD_BASIC_PASS are set.
export function authenticateUpload(request, env) {
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

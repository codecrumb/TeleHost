// Optional Basic Auth for uploads. Uploads stay public unless both
// UPLOAD_BASIC_USER and UPLOAD_BASIC_PASS are set.
export function authenticateUpload(request, env) {
    // Setting either variable (even to an empty string) means auth is intended,
    // so a half-finished or blank configuration fails closed instead of going public.
    if (env.UPLOAD_BASIC_USER === undefined && env.UPLOAD_BASIC_PASS === undefined) return null;
    const hasUser = !!env.UPLOAD_BASIC_USER;
    const hasPass = !!env.UPLOAD_BASIC_PASS;

    const json = (body, status, extra = {}) => new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
    });

    if (!hasUser || !hasPass) {
        return json({ error: 'UPLOAD_BASIC_USER and UPLOAD_BASIC_PASS must both be set' }, 500);
    }

    // Browsers resend cached Basic credentials on cross-site requests, so a page on
    // another origin could otherwise push files as the logged-in operator. Scripts
    // and curl send neither header and are unaffected.
    const site = request.headers.get('Sec-Fetch-Site');
    const origin = request.headers.get('Origin');
    if ((site && site !== 'same-origin' && site !== 'none') ||
        (origin && origin !== new URL(request.url).origin)) {
        return json({ error: 'Cross-site requests are not allowed.' }, 403);
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
// Runs over the longer string, so the time does not reveal the password length.
function timingSafeEqual(a, b) {
    const aStr = String(a);
    const bStr = String(b);
    let result = aStr.length ^ bStr.length;
    for (let i = 0; i < Math.max(aStr.length, bStr.length); i++) {
        result |= (aStr.charCodeAt(i) || 0) ^ (bStr.charCodeAt(i) || 0);
    }
    return result === 0;
}

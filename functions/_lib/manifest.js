// /s/<id> links point at a small JSON "manifest" stored as a document in the
// Telegram channel. Anyone can upload documents through the public /upload
// endpoint, so manifests are HMAC-signed with a key derived from the bot token;
// an unsigned or edited manifest is never trusted (it could otherwise name an
// arbitrary message for the server to delete).

const encoder = new TextEncoder();

// Sign over every field except `sig`, in a fixed order, so new fields are
// covered automatically.
function canonical(manifest) {
    return JSON.stringify(
        Object.keys(manifest).filter(k => k !== 'sig').sort().map(k => [k, manifest[k]])
    );
}

async function hmac(env, payload) {
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode('telehost-manifest:' + env.TG_Bot_Token),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
    let binary = '';
    for (const byte of sig) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function signManifest(env, manifest) {
    return { ...manifest, sig: await hmac(env, canonical(manifest)) };
}

export async function verifyManifest(env, manifest) {
    if (!manifest || typeof manifest !== 'object' || typeof manifest.sig !== 'string') return false;
    const expected = await hmac(env, canonical(manifest));
    if (expected.length !== manifest.sig.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
        diff |= expected.charCodeAt(i) ^ manifest.sig.charCodeAt(i);
    }
    return diff === 0;
}

// /s/<id> links point at a small manifest stored as a document in the Telegram
// channel. Two threats shape how it is stored:
//   * Anyone can upload documents through the public /upload endpoint, so a
//     manifest must be unforgeable (it could otherwise name an arbitrary file to
//     serve or message to delete).
//   * /file/<id> serves any document in the channel, and a link holder knows the
//     manifest's id, so a readable manifest would hand over the real file ids and
//     bypass expiry and passwords-by-obscurity.
// Both are solved by sealing it: AES-GCM with a key derived from the bot token.
// What lands in the channel is unreadable, and any edit fails authentication.

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MANIFEST_AAD = encoder.encode('telehost-manifest-v1');

async function manifestKey(env) {
    const material = await crypto.subtle.digest('SHA-256', encoder.encode('telehost-manifest-key:' + env.TG_Bot_Token));
    return crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// manifest object -> bytes (12-byte IV followed by the ciphertext)
export async function sealManifest(env, manifest) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = new Uint8Array(await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: MANIFEST_AAD },
        await manifestKey(env),
        encoder.encode(JSON.stringify(manifest))
    ));
    const sealed = new Uint8Array(iv.length + cipher.length);
    sealed.set(iv);
    sealed.set(cipher, iv.length);
    return sealed;
}

// bytes -> manifest object, or null if the bytes are not a manifest we sealed
export async function openManifest(env, bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 12 + 16) return null;
    try {
        const plain = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: MANIFEST_AAD },
            await manifestKey(env),
            bytes.slice(12)
        );
        const manifest = JSON.parse(decoder.decode(plain));
        return manifest && typeof manifest === 'object' ? manifest : null;
    } catch {
        return null;
    }
}

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

// A receipt proves the server itself stored a part: /upload signs {fileId, msgId,
// size} for each chunk, and /finalize only accepts parts it can verify. That keeps
// clients from naming arbitrary messages for the server to delete on expiry.
// The prefix keeps receipt signatures distinct from manifest signatures.
const RECEIPT_FIELDS = ({ fileId, msgId, size }) => ({ fileId, msgId, size });

export async function signReceipt(env, part) {
    const fields = RECEIPT_FIELDS(part);
    return { ...fields, sig: await hmac(env, 'receipt:' + canonical(fields)) };
}

export async function verifyReceipt(env, receipt) {
    if (!receipt || typeof receipt !== 'object' || typeof receipt.sig !== 'string' ||
        typeof receipt.fileId !== 'string' || !Number.isInteger(receipt.msgId) || !Number.isInteger(receipt.size)) {
        return false;
    }
    const expected = await hmac(env, 'receipt:' + canonical(RECEIPT_FIELDS(receipt)));
    if (expected.length !== receipt.sig.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
        diff |= expected.charCodeAt(i) ^ receipt.sig.charCodeAt(i);
    }
    return diff === 0;
}

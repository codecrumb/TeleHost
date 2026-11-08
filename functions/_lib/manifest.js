// /s/<id> links point at a small manifest stored as a document in the Telegram
// channel. Two threats shape how it is stored:
//   * Anyone can upload documents through the public /upload endpoint, so a
//     manifest must be unforgeable (it could otherwise name an arbitrary file to
//     serve or message to delete).
//   * /file/<id> serves any document in the channel, and a link holder knows the
//     manifest's id, so a readable manifest would hand over the real file ids and
//     bypass expiry and passwords-by-obscurity.
// Both are solved by sealing it: AES-GCM under a key only the server can derive.
// What lands in the channel is unreadable, and any edit fails authentication.
//
// Keys. One master secret, then a separate key per purpose via HKDF, so a key made
// for one job can never be mistaken for another:
//   * LINK_SECRET, when set (recommended: `openssl rand -hex 32`), so the links do
//     not depend on the bot token and survive rotating it;
//   * otherwise the bot token, so a deployment still works with just the two
//     required variables.

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MANIFEST_AAD = encoder.encode('telehost-manifest-v1');
const HKDF_SALT = encoder.encode('telehost-v1');

export class ConfigError extends Error {}

export const MIN_LINK_SECRET_LENGTH = 32;

export function linkSecret(env) {
    if (env.LINK_SECRET !== undefined) {
        const secret = String(env.LINK_SECRET);
        // A blank or short value is a mistake, not "no secret": refuse instead of
        // quietly protecting links with something guessable.
        if (secret.length < MIN_LINK_SECRET_LENGTH) {
            throw new ConfigError(`LINK_SECRET must be at least ${MIN_LINK_SECRET_LENGTH} characters (try: openssl rand -hex 32)`);
        }
        return secret;
    }
    if (!env.TG_Bot_Token) throw new ConfigError('Server is missing TG_Bot_Token');
    return env.TG_Bot_Token;
}

async function deriveKey(env, label, algorithm, usages) {
    const master = await crypto.subtle.importKey('raw', encoder.encode(linkSecret(env)), 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: encoder.encode(label) },
        master,
        algorithm,
        false,
        usages
    );
}

const manifestKey = env => deriveKey(env, 'manifest-seal', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']);
const receiptKey = env => deriveKey(env, 'receipt-sign', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign']);

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

// bytes -> manifest object, or null if the bytes are not a manifest we sealed.
// A misconfigured secret throws (ConfigError) instead of looking like "not found".
export async function openManifest(env, bytes) {
    const key = await manifestKey(env);
    if (!(bytes instanceof Uint8Array) || bytes.length < 12 + 16) return null;
    try {
        const plain = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: MANIFEST_AAD },
            key,
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
function canonical(fields) {
    return JSON.stringify(
        Object.keys(fields).filter(k => k !== 'sig').sort().map(k => [k, fields[k]])
    );
}

async function hmac(env, payload) {
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await receiptKey(env), encoder.encode(payload)));
    let binary = '';
    for (const byte of sig) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// A receipt proves the server itself stored a part: /upload signs {fileId, msgId,
// size} for each chunk, and /finalize only accepts parts it can verify. That keeps
// clients from naming arbitrary messages for the server to delete on expiry.
const RECEIPT_FIELDS = ({ fileId, msgId, size }) => ({ fileId, msgId, size });

export async function signReceipt(env, part) {
    const fields = RECEIPT_FIELDS(part);
    return { ...fields, sig: await hmac(env, canonical(fields)) };
}

export async function verifyReceipt(env, receipt) {
    if (!receipt || typeof receipt !== 'object' || typeof receipt.sig !== 'string' ||
        typeof receipt.fileId !== 'string' || !Number.isInteger(receipt.msgId) || !Number.isInteger(receipt.size)) {
        return false;
    }
    const expected = await hmac(env, canonical(RECEIPT_FIELDS(receipt)));
    if (expected.length !== receipt.sig.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
        diff |= expected.charCodeAt(i) ^ receipt.sig.charCodeAt(i);
    }
    return diff === 0;
}

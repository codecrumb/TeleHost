// Validation for the options a client may attach to an upload. The server never
// trusts these beyond bounds: they only shape the signed manifest it writes.

export const MAX_EXPIRY_SECONDS = 30 * 24 * 60 * 60;

// Seconds until the link expires; null when the upload has no expiry.
export function checkExpiry(value) {
    if (value === null || value === undefined || value === '') return null;
    const seconds = Number(value);
    if (!Number.isInteger(seconds) || seconds < 60 || seconds > MAX_EXPIRY_SECONDS) {
        throw new Error('Invalid expiry');
    }
    return seconds;
}

const B64URL = /^[A-Za-z0-9_-]{8,64}$/;

// The browser encrypts password-protected files (AES-GCM, PBKDF2 key) before
// upload; the server only records the public parameters needed to decrypt.
// kind 'single': one IV for the whole file. kind 'parts': an 8-byte IV prefix,
// combined with the part number for each chunk.
export function checkEncryption({ salt, iv, ivp, iter }, kind) {
    iter = Number(iter);
    const ivField = kind === 'parts' ? ivp : iv;
    if (!B64URL.test(String(salt || '')) || !B64URL.test(String(ivField || '')) ||
        !Number.isInteger(iter) || iter < 100000 || iter > 1000000) {
        throw new Error('Invalid encryption parameters');
    }
    return kind === 'parts'
        ? { alg: 'AES-GCM', kdf: 'PBKDF2-SHA256', salt, ivp, iter }
        : { alg: 'AES-GCM', kdf: 'PBKDF2-SHA256', salt, iv, iter };
}

// Original name/type/size of an encrypted file, kept in the manifest so the
// unlock page can restore them.
export function cleanMeta({ name, type, size }) {
    return {
        name: String(name || 'download').slice(0, 255),
        type: String(type || '').slice(0, 100),
        size: Math.max(0, Number(size) || 0),
    };
}

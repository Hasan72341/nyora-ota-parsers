// Minimal shim: maps node:crypto usage in fmreader to Web Crypto API (available in WKWebView).
// Only the subset actually called by fmreader.js is needed.

export const randomBytes = (n) => {
    const arr = new Uint8Array(n);
    (globalThis.crypto || self.crypto).getRandomValues(arr);
    return arr;
};

export const createDecipheriv = (algorithm, key, iv) => {
    // Stubbed — AES chapter-protection decryption not yet wired to Web Crypto.
    // Parsers that hit this path will throw, which surfaces as a load error for that chapter.
    throw new Error('node:crypto createDecipheriv not supported in WKWebView shim');
};

export default { randomBytes, createDecipheriv };

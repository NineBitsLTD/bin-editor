/**
 * @returns {string} a random value for the `nonce` of the scripts of a webview page
 */
export function createNonce() {
    return globalThis.crypto.randomUUID().replace(/-/g, '');
}

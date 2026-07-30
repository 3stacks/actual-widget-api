// @actual-app/api expects a browser-style `navigator` global.
//
// Node 21 added a built-in `navigator`, defined as a getter. So a plain assignment to
// globalThis.navigator silently does nothing on Node 21 and later, which made the previous
// one-line version of this file a no-op. Node 22 supplies both `platform` and `userAgent`,
// so there is nothing to do there. Only fill the gap when it is real, and use
// defineProperty so it works against the getter if it ever is.
if (typeof globalThis.navigator === 'undefined'
    || typeof globalThis.navigator.platform !== 'string') {
    Object.defineProperty(globalThis, 'navigator', {
        value: { platform: 'linux', userAgent: 'node' },
        configurable: true,
        writable: true,
    });
}

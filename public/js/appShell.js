// The Android app (android/, docs/ANDROID.md) shows this site in a full-screen WebView whose user agent ends in
// `StrongholdApp/<version>` — plus ` bundled` when the game's resources (/assets, /fonts: the resource manifest's files)
// are inside the APK and the app answers those requests itself. Feature-detected nowhere else: a WebView looks like
// Chrome on Android, so only the app's own mark tells.

const UA = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';

/** Running inside the Android app (already full screen, already installed). */
export const inApp = (ua = UA) => /\bStrongholdApp\/\S+/.test(ua);

/** The app carries the game's resources: no resource download, no service-worker cache of them. */
export const appBundled = (ua = UA) => /\bStrongholdApp\/\S+ bundled\b/.test(ua);

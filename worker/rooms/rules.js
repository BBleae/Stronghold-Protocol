// The rules a battle runs on, for the browser that simulates it (public/js/battle/runner.js): a b.start names the rules
// version of its match, so a match the room Worker restored from an older deployment is simulated with that version's
// engine instead of the page's own.

/** A match message for a browser: a b.start names the rules version of its match. */
export const withRules = (msg, match) => (msg?.t === 'b.start' && match?.recording ? { ...msg, rulesVersion: match.recording.rulesVersion } : msg);

/* global __SP_RULES_VERSION__ -- defined by the Worker build (tools/build-worker.mjs) */
export const RULES_VERSION = typeof __SP_RULES_VERSION__ === 'string' ? __SP_RULES_VERSION__ : 'development-v1';

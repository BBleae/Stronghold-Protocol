// Structured logs for Workers Logs: one object per line, `event` names what happened and the other fields give its
// context (room code, match id, rules version, …). Workers Logs indexes the fields of a logged object.
// Never log secrets: no session tokens, cookies, tickets or request headers.

export function logInfo(event, fields = {}) {
  console.log({ event, ...fields });
}

export function logWarn(event, fields = {}) {
  console.warn({ event, ...fields });
}

export function logError(event, fields = {}) {
  console.error({ event, ...fields });
}

/** The loggable part of an error. */
export function errorFields(error) {
  return { name: error?.name, message: String(error?.message ?? error), code: error?.code, stack: error?.stack };
}

export const ACCOUNT_LIMITS = Object.freeze({
  sessionMs: 30 * 86400000, oauthMs: 600000, applicationMs: 120000,
  // How long an approval holds the applicant's seat: long enough to switch apps on a phone and back.
  approvalMs: 120000, leaseMs: 60000, heartbeatMs: 20000, pageSize: 50,
});
export class AccountError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
export function requireId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) throw new AccountError('INVALID_ID');
  return value;
}
export function pageLimit(value = 20) {
  if (!Number.isSafeInteger(value) || value < 1 || value > ACCOUNT_LIMITS.pageSize) throw new AccountError('INVALID_PAGE');
  return value;
}

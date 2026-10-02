import { DurableObject } from 'cloudflare:workers';
import { requireId, AccountError } from '../../shared/account-protocol.js';
export class AccountDurableObject extends DurableObject {
  async setProfile(profile) { await this.ctx.storage.put('profile', profile); }
  async getProfile() { return (await this.ctx.storage.get('profile')) || null; }
  async getActiveSeat() { return (await this.ctx.storage.get('activeSeat')) || null; }
  async claimSeat({claimId, seat, expiresAt}) {
    requireId(claimId); requireId(seat.roomId); requireId(seat.roomGeneration);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw new AccountError('INVALID_EXPIRY');
    return this.ctx.storage.transaction(async tx => {
      const active = await tx.get('activeSeat');
      if (active && active.claimId !== claimId) return {ok: false, error: 'ALREADY_SEATED'};
      if (active) return {ok: true, seat: active};
      const value = {...seat, claimId, expiresAt};
      await tx.put('activeSeat', value);
      return {ok: true, seat: value};
    });
  }
  async releaseSeat({claimId}) {
    return this.ctx.storage.transaction(async tx => {
      const active = await tx.get('activeSeat');
      if (!active || active.claimId !== claimId) return {ok: false};
      await tx.delete('activeSeat'); return {ok: true};
    });
  }
}

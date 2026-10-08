// public/js/screens/game/early.js — which events are replayed when a field is entered late.

import { fxForm } from '../../../../shared/protocol.js';
import { isLastingFxEvent } from '../../render/fxsustain.js';

export const STATE_EV = new Set(['spawn', 'die', 'deploy', 'status', 'skill', 'leak']);

/** Event tuples replayed when a field is entered late: the state-bearing kinds, the fx that change an enemy's model
 *  form (shared/protocol.js fxForm — the field meta's UnitInfo `form` predates them) and the lasting fx (render/fxsustain.js
 *  isLastingFxEvent: a wall, a link, drones, 影哨 … that began in that span). */
export const keepEarly = (e) => Array.isArray(e) && (STATE_EV.has(e[0]) || fxForm(e) !== undefined || isLastingFxEvent(e));

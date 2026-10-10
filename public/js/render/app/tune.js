// public/js/render/app/tune.js — camera, drag and highlight tunables of the field view.

const CAMERA_MS = 750;

/** Longest the view's startup waits for its optional parts (fonts, board art, the 3D board) — see createFieldView. */
const STARTUP_WAIT_MS = 4000;

/** Touch pinch on the field (see the pointer handlers): the deepest zoom, the pan's reach past the framing, a tap's slop. */
const USER_ZOOM_MAX = 3;
const USER_PAN_SLACK = 0.3;
const TAP_SLOP_PX = 12;

/**
 * Game seconds the battle is drawn behind the simulation (render/interp.js lookAhead): enough for the whole wind-up of
 * 99% of the attack clips and for Texas' Attack_Start + strike (0.97 s). In GAME time so it holds at every battle /
 * replay speed; at the live 2× it is 0.5 s real (renderLag()).
 */
export const LOOK_AHEAD = 1.0;

/** Camera pan to / from the enemy preview pen (configBlackBoard move_time 0.25). */
export const PEN_CAMERA_MS = 250;

/** Recovery of a lost 3D board context: delays of the rebuild attempts (ms) and how soon a new loss counts as failure. */
const BOARD3D_RETRY_MS = [1200, 4000, 12000];

const BOARD3D_STABLE_MS = 10000;

/** Highlight groups that show a unit's range: never drawn on bench / temp pads (they are not part of any battle). */
const RANGE_GROUPS = new Set(['facing', 'range', 'rangeStand', 'select', 'sel', 'selRange']);

/**
 * The round leader's hit tiles, lit beside an operator's range preview in the Final Assault / Hidden Core prep (see the
 * header; community report #12 "boss受击范围可以像官方原版那样用红色"). [ASSUMED] the red and its strength: the players' request,
 * no source shows the official colour; the range preview stays orange.
 */
export const LEADER_HIT_STYLE = Object.freeze({ group: 'leaderHit', color: 0xff3b30, fill: 0.3, line: 0.95 });

/** atk projectile kinds whose first id is the previous bounce target (sim ai.js), not the attacker. */
const CHAIN_KINDS = new Set(['chain', 'chainHeal']);

const DROP_PENDING_MS = 1300;

/**
 * A dragged unit over no legal target is held with its drawn feet this many tiles below the pointer — the pointer on its
 * body, the model under the finger / mouse (user playtest #4 item 1: as in v2.1; mouse and touch alike); over a legal
 * target it stands on that tile (render/drag.js dragStandTile). An item plate is centred on the pointer.
 */
export const DRAG_HOLD_TILES = 0.45;

export { CAMERA_MS, BOARD3D_RETRY_MS, BOARD3D_STABLE_MS, RANGE_GROUPS, CHAIN_KINDS, DROP_PENDING_MS, STARTUP_WAIT_MS, USER_ZOOM_MAX, USER_PAN_SLACK, TAP_SLOP_PX };

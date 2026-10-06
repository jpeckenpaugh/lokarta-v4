/**
 * Lokarta: Come Into The Light - Active-member / ally tile swap
 *
 * Board T2 round 2 item 3 (LIV-8 rejection 5319a0a7): "The primary player
 * character should not be blocked ... If the primary player tries to 'walk
 * over' the same tile that another party member is already standing on, they
 * will simply swap positions/places to prevent blocking situations."
 *
 * Pure, browser-free position mutation on the shared party member objects so
 * the loop/render layer only has to animate the result. Allocates nothing on
 * the per-tick movement path and owns no DOM/worker/timer behavior.
 */

import { PartyAI } from './party-ai.js';

/**
 * Swaps the active member with a living party member standing on (x, y): the
 * ally takes the active member's previous tile and the active member advances
 * onto (x, y).
 *
 * Returns the relocated ally so the caller can face/animate it, or null when
 * the target tile is not held by a living non-active member (empty tile, a
 * monster, or a downed member). A null return leaves both actors untouched, so
 * the caller can fall through to monster targeting / a normal step.
 *
 * @param {object} player Active-authoritative player object.
 * @param {number} x
 * @param {number} y
 * @returns {object|null}
 */
export function swapWithPartyMemberAt(player, x, y) {
  if (!player) return null;
  const ally = PartyAI.partyMemberAt(player, x, y);
  if (!ally) return null;
  const previousX = player.x;
  const previousY = player.y;
  ally.x = previousX;
  ally.y = previousY;
  player.x = x;
  player.y = y;
  return ally;
}

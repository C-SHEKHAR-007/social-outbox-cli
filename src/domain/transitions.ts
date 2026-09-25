import { SUBMITTED_STATES, type Action, type VideoState } from './states.js';

export function isSubmitted(state: VideoState): boolean {
  return SUBMITTED_STATES.includes(state);
}

/**
 * State after the user changes `action` (via CSV import). Submitted rows never change here;
 * FAILED rows only leave FAILED via SKIP or the `retry` command.
 */
export function stateAfterActionChange(state: VideoState, action: Action | null): VideoState {
  if (isSubmitted(state)) return state;
  if (action === 'SKIP') return 'SKIPPED';
  if (state === 'FAILED') return 'FAILED';
  return action === null ? 'NEW' : 'READY';
}

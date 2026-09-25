import type { MediaInfo, SpecIssue } from '../domain/media.js';
import type { PublishTarget } from '../domain/states.js';
import { checkPageVideoSpec } from './page-video-spec.js';
import { checkReelSpec, REEL_SPEC } from './reel-spec.js';

export interface TargetRules {
  reelMaxDurationS: number;
}

/** Short videos go to the Reels API; anything longer becomes a regular Page video. */
export function chooseTarget(durationS: number | null, rules: TargetRules): PublishTarget {
  return durationS !== null && durationS > rules.reelMaxDurationS + REEL_SPEC.durationToleranceS ? 'VIDEO' : 'REEL';
}

export function checkSpecFor(
  target: PublishTarget,
  info: MediaInfo,
  fileSize: number,
  rules: TargetRules,
): SpecIssue[] {
  return target === 'REEL' ? checkReelSpec(info, rules.reelMaxDurationS) : checkPageVideoSpec(info, fileSize);
}

export const TARGET_LABEL: Record<PublishTarget, string> = { REEL: 'Reel', VIDEO: 'Page video' };

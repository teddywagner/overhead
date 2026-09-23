/** The selection a frame is currently committed to. */
export interface CurrentSelection {
  overflight_ids: string[];
  selected_at: string;
}

export type CommitReason = 'initial' | 'changed';
export type HoldReason = 'unchanged' | 'dwell' | 'no_candidates';

export type CommitDecision =
  | { commit: true; reason: CommitReason }
  | { commit: false; reason: HoldReason; hold_until?: string };

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

/**
 * Whether a newly picked set should replace what the frame is showing.
 * Every committed change means a new render and an e-ink refresh, so a
 * change is held until the current selection has been up for the dwell
 * time. An empty pick never replaces something already on screen: a quiet
 * sky keeps the last planes instead of blanking the frame.
 */
export function decideCommit(
  current: CurrentSelection | null,
  pickedIds: string[],
  now: Date,
  minDwellMinutes: number,
): CommitDecision {
  if (pickedIds.length === 0) return { commit: false, reason: 'no_candidates' };
  if (!current) return { commit: true, reason: 'initial' };
  if (sameSet(current.overflight_ids, pickedIds)) return { commit: false, reason: 'unchanged' };
  const holdUntil = Date.parse(current.selected_at) + minDwellMinutes * 60_000;
  if (now.getTime() < holdUntil) {
    return { commit: false, reason: 'dwell', hold_until: new Date(holdUntil).toISOString() };
  }
  return { commit: true, reason: 'changed' };
}

/**
 * The page's one committee: a 3-of-5 sharing whose epoch history feeds the
 * circle exhibit (which appends epochs) and the break-it grid (which reads
 * every epoch ever produced). Key material is per-session, in memory only.
 */
import { initialDeal, randomSecret } from '../reshare/reshare';
import type { EpochState } from '../reshare/types';

export interface Session {
  secret: bigint;
  epochs: EpochState[];
  onChange: Set<() => void>;
}

export const N = 5;
export const T = 3;

export async function createSession(): Promise<Session> {
  const secret = await randomSecret();
  const first = await initialDeal(secret, T, N);
  return { secret, epochs: [first], onChange: new Set() };
}

export function latest(s: Session): EpochState {
  return s.epochs[s.epochs.length - 1];
}

export function pushEpoch(s: Session, e: EpochState): void {
  s.epochs.push(e);
  for (const fn of s.onChange) fn();
}

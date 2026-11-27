import type { Targets } from './types';

export function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/** Targets are always valid for the simulator, even mid-typing in the inputs. */
export function ensureTargets(raw: { rto: number; rpo: number }): Targets {
  return { rto: clamp(raw.rto, 5, 180), rpo: clamp(raw.rpo, 1, 120) };
}

export const adaptTargets = ensureTargets;

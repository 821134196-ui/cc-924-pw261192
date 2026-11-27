import type { LaneId, PlannedStep, RunResult } from '../domain/types';

/** Pack intervals into rows so overlapping blocks in one lane never collide. */
export function packLane(steps: PlannedStep[], gapMin = 0.5): PlannedStep[][] {
  const rows: PlannedStep[][] = [];
  for (const step of [...steps].sort((a, b) => a.start - b.start || a.end - b.end)) {
    let placed = false;
    for (const row of rows) {
      const last = row[row.length - 1];
      if (step.start >= last.end + gapMin) {
        row.push(step);
        placed = true;
        break;
      }
    }
    if (!placed) rows.push([step]);
  }
  return rows;
}

export function laneRows(steps: PlannedStep[]): Record<LaneId, PlannedStep[][]> {
  const lanes: Record<LaneId, PlannedStep[]> = {
    config: [],
    pki: [],
    scan: [],
    restore: [],
    verify: [],
  };
  for (const s of steps) {
    // Carried steps have no plot position; blocked steps never got one. Both are
    // reported elsewhere (the carried strip and the waiting-chain strip), so a
    // zero-width stub in the plot would only add noise.
    if (s.carried || s.start < 0) continue;
    lanes[s.lane].push(s);
  }
  return {
    config: packLane(lanes.config),
    pki: packLane(lanes.pki),
    scan: packLane(lanes.scan),
    restore: packLane(lanes.restore),
    verify: packLane(lanes.verify),
  };
}

export function niceMax(minutes: number): number {
  if (minutes <= 0) return 60;
  return Math.ceil((minutes + 5) / 10) * 10;
}

/** Core-service availability over the run, as step points. */
export function availabilitySeries(
  run: RunResult,
  maxMinute: number,
): { minute: number; count: number }[] {
  const core = run.outcomes.filter((o) => o.tier === 1);
  const points: { minute: number; count: number }[] = [{ minute: 0, count: 0 }];
  let last = 0;
  for (let m = 1; m <= maxMinute; m++) {
    const count = core.filter((o) => o.restoredAtMin !== null && o.restoredAtMin <= m).length;
    if (count !== last) {
      points.push({ minute: m, count });
      last = count;
    }
  }
  if (points[points.length - 1].minute !== maxMinute) {
    points.push({ minute: maxMinute, count: last });
  }
  return points;
}

export function tickValues(max: number, count = 5): number[] {
  const step = max / count;
  return Array.from({ length: count + 1 }, (_, i) => Math.round(i * step));
}

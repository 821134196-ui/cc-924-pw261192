import { describe, expect, it } from 'vitest';
import { pathA, pathB, scenario, serviceById } from './scenario';
import { certMinutesLeft, dataLossMin, simulate } from './simulate';
import { assessPath, buildTradeoff } from './tradeoff';
import { acceptDecision, emptyWorkspace, executeRun } from './execution';
import { breachList } from './tradeoff';
import type { EffectEntry, RunResult } from './types';

const noEffects: Record<string, EffectEntry> = {};

function run(
  plan = pathA,
  timeouts: Record<string, number> = {},
  targets = { rto: 35, rpo: 6 },
  appliedEffects: Record<string, EffectEntry> = noEffects,
) {
  return simulate({ plan, targets, timeouts, appliedEffects });
}

describe('scenario sanity', () => {
  it('has a certificate crossing the drill clock', () => {
    expect(certMinutesLeft('risk')).toBeLessThan(0);
    expect(certMinutesLeft('auth')).toBeGreaterThan(0);
    expect(certMinutesLeft('auth')).toBeLessThan(180);
  });

  it('depends on a DAG that is acyclic', () => {
    const seen = new Set<string>();
    const visiting = new Set<string>();
    const visit = (id: string) => {
      expect(visiting.has(id)).toBe(false);
      if (seen.has(id)) return;
      visiting.add(id);
      for (const d of serviceById[id].deps) visit(d);
      visiting.delete(id);
      seen.add(id);
    };
    for (const s of scenario.services) visit(s.id);
    expect(seen.size).toBe(scenario.services.length);
  });
});

describe('scheduling', () => {
  it('start runs do not overlap on a capacity-1 lane', () => {
    const r = run(pathA);
    const pki = r.steps.filter((s) => s.lane === 'pki' && s.status !== 'done' || s.lane === 'pki');
    const intervals = pki
      .filter((s) => s.start >= 0)
      .map((s) => [s.start, s.end] as const)
      .sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < intervals.length; i++) {
      expect(intervals[i][0]).toBeGreaterThanOrEqual(intervals[i - 1][1]);
    }
  });

  it('respects dependency ordering', () => {
    const r = run(pathA);
    const byId = Object.fromEntries(r.steps.map((s) => [s.id, s]));
    for (const s of r.steps) {
      for (const d of s.deps) {
        if (byId[d].status === 'done' && s.start >= 0) {
          expect(s.start).toBeGreaterThanOrEqual(byId[d].end);
        }
      }
    }
  });

  it('cert urgency puts an expired cert near the front of the PKI lane', () => {
    const r = run(pathB);
    const certs = r.steps.filter((s) => s.kind === 'cert').sort((a, b) => a.start - b.start);
    expect(certs[0].serviceId).toBe('risk');
  });

  it('renews compulsory certs even when the plan window is wide or narrow', () => {
    const a = run(pathA);
    const b = run(pathB);
    for (const r of [a, b]) {
      const cert = r.steps.find((s) => s.id === 'risk:cert');
      expect(cert).toBeDefined();
      expect(cert!.status).toBe('done');
    }
  });

  it('does not renew certificates outside both windows', () => {
    const r = run(pathA);
    expect(r.steps.find((s) => s.id === 'pay-db:cert')).toBeUndefined();
  });

  it('a staged path defers non-core config', () => {
    const a = run(pathA);
    const b = run(pathB);
    expect(a.steps.find((s) => s.id === 'clearing:config')).toBeUndefined();
    expect(b.steps.find((s) => s.id === 'clearing:config')).toBeDefined();
  });
});

describe('timeouts', () => {
  it('a timed-out step blocks dependants and never reports success', () => {
    const r = run(pathA, { 'pay-db:restore': 5 });
    const db = r.steps.find((s) => s.id === 'pay-db:restore')!;
    expect(db.status).toBe('timed-out');
    const pay = r.steps.find((s) => s.id === 'pay:restore')!;
    expect(pay.status).toBe('blocked');
    const outcome = r.outcomes.find((o) => o.id === 'pay')!;
    expect(outcome.state).toBe('waiting');
    expect(outcome.blockedBy).toContain('pay-db');
    const report = r.outcomes.find((o) => o.id === 'report')!;
    expect(report.state).toBe('waiting');
    expect(report.restoredAtMin).toBeNull();
  });

  it('services outside the failed subtree still recover', () => {
    const r = run(pathA, { 'pay-db:restore': 5 });
    for (const id of ['edge', 'auth', 'msg', 'risk', 'session', 'ops']) {
      expect(r.outcomes.find((o) => o.id === id)!.state).not.toBe('failed');
    }
  });

  it('a verify timeout marks the service failed without poisoning siblings', () => {
    const r = run(pathA, { 'session:verify': 1 });
    expect(r.outcomes.find((o) => o.id === 'session')!.state).toBe('failed');
    expect(r.outcomes.find((o) => o.id === 'msg')!.state).toBe('restored');
  });

  it('RTO is null when a core service never becomes available', () => {
    const r = run(pathA, { 'pay:restore': 3 });
    expect(r.rtoMin).toBeNull();
    expect(breachList(r).length).toBeGreaterThan(0);
  });

  it('a timeout on a carried step has no effect', () => {
    const first = run(pathA);
    const ws = executeRun({
      workspace: emptyWorkspace(scenario.version),
      run: first,
      scenario,
      pathName: '先接管',
      breaches: [],
    }).workspace;
    const second = simulate({
      plan: pathA,
      targets: { rto: 35, rpo: 6 },
      timeouts: { 'pay-db:config': 1 },
      appliedEffects: ws.ledger.effects,
    });
    const config = second.steps.find((s) => s.id === 'pay-db:config');
    if (config) {
      expect(config.carried).toBe(true);
      expect(config.status).toBe('done');
    }
  });
});

describe('side-effect ledger', () => {
  it('repeated identical requests replay instead of re-applying', () => {
    const first = run(pathA);
    const one = executeRun({
      workspace: emptyWorkspace(scenario.version),
      run: first,
      scenario,
      pathName: '先接管',
      breaches: [],
    });
    expect(one.replayed).toBe(false);
    const applied = Object.keys(one.workspace.ledger.effects).length;
    expect(applied).toBeGreaterThan(0);

    const again = run(pathA);
    const two = executeRun({
      workspace: one.workspace,
      run: again,
      scenario,
      pathName: '先接管',
      breaches: [],
    });
    expect(two.replayed).toBe(true);
    expect(Object.keys(two.workspace.ledger.effects).length).toBe(applied);
    expect(two.executed.requestId).toBe(one.executed.requestId);
    expect(two.workspace.requests[0].replays).toBe(1);
  });

  it('a different signature carries executed effects instead of re-applying', () => {
    const first = run(pathA);
    const one = executeRun({
      workspace: emptyWorkspace(scenario.version),
      run: first,
      scenario,
      pathName: '先接管',
      breaches: [],
    });
    const changed = run(pathA, { 'risk:restore': 2 }, { rto: 35, rpo: 6 }, one.workspace.ledger.effects);
    expect(changed.signature).not.toBe(first.signature);
    const two = executeRun({
      workspace: one.workspace,
      run: changed,
      scenario,
      pathName: '先接管',
      breaches: [],
    });
    expect(two.replayed).toBe(false);
    const before = new Set(Object.keys(one.workspace.ledger.effects));
    for (const key of before) {
      expect(two.workspace.ledger.effects[key].requestId).toBe(
        one.workspace.ledger.effects[key].requestId,
      );
    }
    expect(Object.keys(two.workspace.ledger.effects).length).toBeGreaterThanOrEqual(before.size);
    expect(two.executed.carriedStepCount).toBeGreaterThan(0);
  });

  it('switching path reuses prep done for the other path', () => {
    const a = run(pathA);
    const ws = executeRun({
      workspace: emptyWorkspace(scenario.version),
      run: a,
      scenario,
      pathName: '先接管',
      breaches: [],
    }).workspace;
    const b = run(pathB, {}, { rto: 35, rpo: 6 }, ws.ledger.effects);
    const second = executeRun({
      workspace: ws,
      run: b,
      scenario,
      pathName: '先对齐',
      breaches: [],
    });
    expect(second.executed.reusedEffectCount).toBeGreaterThan(0);
    const authCert = second.workspace.ledger.effects['cert:auth:' + serviceById.auth.cert.notAfter];
    expect(authCert.requestId).toBe('B-001-R001');
  });

  it('records an operator override with explicit breaches', () => {
    const r = run(pathA);
    const breaches = breachList(r);
    const ws = executeRun({
      workspace: emptyWorkspace(scenario.version),
      run: r,
      scenario,
      pathName: '先接管',
      breaches,
    });
    const decided = acceptDecision(ws.workspace, ws.executed, breaches, scenario);
    expect(decided.decisions.length).toBe(1);
    expect(decided.decisions[0].breaches).toEqual(breaches);
  });
});

describe('tradeoff', () => {
  it('both paths expose costs when targets cannot both be met', () => {
    const tradeoff = buildTradeoff({ rto: 30, rpo: 3 }, {}, noEffects);
    for (const p of tradeoff.paths) {
      expect(p.costs.length).toBeGreaterThan(0);
    }
    if (!tradeoff.allCompliant) {
      expect(tradeoff.needsDecision).toBe(true);
      expect(tradeoff.headline.length).toBeGreaterThan(0);
    }
  });

  it('reports which path wins on which dimension under a tight target', () => {
    const t = buildTradeoff({ rto: 40, rpo: 4 }, {}, noEffects);
    const latency = t.paths.find((p) => p.plan.id === 'latency')!;
    const data = t.paths.find((p) => p.plan.id === 'data')!;
    expect(latency.rtoMin!).toBeLessThan(data.rtoMin ?? Infinity);
    expect(data.rpoMin!).toBeLessThan(latency.rpoMin ?? Infinity);
  });

  it('flags the RPO-breach services on the latency path', () => {
    const a = assessPath(pathA, { rto: 35, rpo: 6 }, {}, noEffects);
    expect(a.rpoBreachServices.map((s) => s.id)).toContain('pay-db');
    expect(a.rpoBreachServices.every((s) => s.loss > 6)).toBe(true);
  });
});

describe('outcome classification', () => {
  it('classifies every service exactly once', () => {
    const r = run(pathA);
    const states = r.outcomes.map((o) => o.state);
    expect(states.length).toBe(scenario.services.length);
    expect(r.restoredCount + r.degradedCount + r.waitingCount + r.failedCount).toBe(
      scenario.services.length,
    );
  });

  it('degraded services still count as available', () => {
    const r = run(pathA);
    const degraded = r.outcomes.filter((o) => o.state === 'degraded');
    for (const d of degraded) {
      expect(d.risks.length).toBeGreaterThan(0);
      expect(d.restoredAtMin).not.toBeNull();
    }
  });
});

function assertType(_x: RunResult) {}
void assertType;
void dataLossMin;
void pathB;

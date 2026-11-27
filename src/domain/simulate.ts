import {
  DRILL_EPOCH,
  MANDATORY_CERT_MIN,
  LANE_CAPACITY,
  downstreamCount,
  scenario,
  serviceById,
} from './scenario';
import type {
  EffectIntent,
  LaneId,
  PlanParams,
  PlannedStep,
  RunInput,
  RunResult,
  Scenario,
  ServiceOutcome,
  Step,
  Targets,
  UrgencyParts,
} from './types';

const LANE_ORDER: Record<LaneId, number> = {
  config: 0,
  pki: 0,
  scan: 1,
  restore: 2,
  verify: 3,
};

/** Minutes until the drill clock, negative when already expired. */
export function certMinutesLeft(serviceId: string): number {
  const c = serviceById[serviceId].cert;
  return (Date.parse(c.notAfter) - DRILL_EPOCH) / 60_000;
}

export function certNeedsRenewal(serviceId: string, plan: PlanParams): boolean {
  const left = certMinutesLeft(serviceId);
  return left < MANDATORY_CERT_MIN || left < plan.certWindowMin;
}

export function configApplies(serviceId: string, plan: PlanParams): boolean {
  const svc = serviceById[serviceId];
  if (!svc.config) return false;
  return plan.configScope === 'all' || svc.tier === 1;
}

export function dataLossMin(serviceId: string, plan: PlanParams): number {
  const svc = serviceById[serviceId];
  return plan.snapshotPolicy === 'vault' ? svc.vaultLagMin : svc.localLagMin;
}

function urgencyOf(
  serviceId: string,
  kind: Step['kind'],
  plan: PlanParams,
): { total: number; parts: UrgencyParts } {
  const svc = serviceById[serviceId];
  const left = certMinutesLeft(serviceId);
  const parts: UrgencyParts = {
    tier: svc.tier === 1 ? 120 : svc.tier === 2 ? 40 : 0,
    downstream: downstreamCount[serviceId] * 16,
    config: kind === 'config' ? 24 + (plan.configLanes === 1 ? 6 : 0) : 0,
    cert: 0,
    recoveryPoint: 0,
  };
  if (kind === 'cert') {
    parts.cert = left <= 0 ? 150 : left < 180 ? 110 : left < 24 * 60 ? 60 : 20;
  }
  if (kind === 'restore' || kind === 'scan') {
    parts.recoveryPoint = Math.min(30, Math.round(dataLossMin(serviceId, plan) * 1.5));
  }
  return {
    total: parts.tier + parts.downstream + parts.config + parts.cert + parts.recoveryPoint,
    parts,
  };
}

/**
 * Build the execution DAG for a plan. Config/cert/scan prepare a service; restore
 * waits for every upstream service to *verify*, so a failure propagates.
 */
export function buildSteps(plan: PlanParams, src: Scenario = scenario): Step[] {
  const steps: Step[] = [];
  for (const svc of src.services) {
    const id = svc.id;
    const depsForRestore: string[] = svc.deps.map((d) => `${d}:verify`);

    if (configApplies(id, plan)) {
      const { total, parts } = urgencyOf(id, 'config', plan);
      steps.push({
        id: `${id}:config`,
        serviceId: id,
        kind: 'config',
        lane: 'config',
        durationMin: svc.config!.applyMin,
        deps: [],
        urgency: total,
        urgencyParts: parts,
        effectKey: `config:${id}:${svc.config!.from}->${svc.config!.to}`,
        effectLabel: `配置 ${svc.config!.from} → ${svc.config!.to}`,
      });
      depsForRestore.push(`${id}:config`);
    }

    if (certNeedsRenewal(id, plan)) {
      const { total, parts } = urgencyOf(id, 'cert', plan);
      steps.push({
        id: `${id}:cert`,
        serviceId: id,
        kind: 'cert',
        lane: 'pki',
        durationMin: svc.cert.renewMin,
        deps: [],
        urgency: total,
        urgencyParts: parts,
        effectKey: `cert:${id}:${svc.cert.notAfter}`,
        effectLabel: `证书续期（原到期 ${svc.cert.notAfter.slice(0, 16).replace('T', ' ')}）`,
      });
      depsForRestore.push(`${id}:cert`);
    }

    if (plan.integrityScan) {
      const { total, parts } = urgencyOf(id, 'scan', plan);
      steps.push({
        id: `${id}:scan`,
        serviceId: id,
        kind: 'scan',
        lane: 'scan',
        durationMin: svc.scanMin,
        deps: [],
        urgency: total,
        urgencyParts: parts,
      });
      depsForRestore.push(`${id}:scan`);
    }

    const restoreUrgency = urgencyOf(id, 'restore', plan);
    steps.push({
      id: `${id}:restore`,
      serviceId: id,
      kind: 'restore',
      lane: 'restore',
      durationMin: svc.restoreMin + (plan.snapshotPolicy === 'vault' ? 2 : 0),
      deps: depsForRestore,
      urgency: restoreUrgency.total,
      urgencyParts: restoreUrgency.parts,
    });

    steps.push({
      id: `${id}:verify`,
      serviceId: id,
      kind: 'verify',
      lane: 'verify',
      durationMin: svc.verifyMin,
      deps: [`${id}:restore`],
      urgency: restoreUrgency.total,
      urgencyParts: restoreUrgency.parts,
    });
  }
  return steps;
}

export function laneCapacity(plan: PlanParams, lane: LaneId): number {
  if (lane === 'config') return plan.configLanes;
  if (lane === 'restore') return plan.restoreLanes;
  return LANE_CAPACITY[lane];
}

export function compareSteps(a: Step, b: Step): number {
  if (a.urgency !== b.urgency) return b.urgency - a.urgency;
  if (LANE_ORDER[a.lane] !== LANE_ORDER[b.lane]) {
    return LANE_ORDER[a.lane] - LANE_ORDER[b.lane];
  }
  return a.id.localeCompare(b.id);
}

/**
 * Deterministic list scheduler. Time advances in whole minutes; at each minute we
 * free finished steps, block anything downstream of a failure, then start the
 * highest-urgency ready steps that fit free lanes. A timeout cuts a step short and
 * is NOT a clean finish: dependants are blocked, never satisfied.
 */
export function simulate(input: RunInput, src: Scenario = scenario): RunResult {
  const { plan, timeouts, appliedEffects, targets } = input;
  const steps = buildSteps(plan, src);
  const byId: Record<string, PlannedStep> = {};
  const timeoutMap = new Map<string, number>();
  for (const [k, v] of Object.entries(timeouts)) {
    if (!Number.isFinite(v)) continue;
    timeoutMap.set(k, Math.max(1, Math.floor(v)));
  }

  for (const s of steps) {
    const carried = Boolean(s.effectKey && appliedEffects[s.effectKey!]);
    byId[s.id] = {
      ...s,
      start: carried ? -1 : -1,
      end: carried ? 0 : -1,
      plannedEnd: 0,
      status: carried ? 'done' : 'pending',
      timedOut: false,
      carried,
    };
  }

  const laneBusy: Record<LaneId, number> = {
    config: 0,
    pki: 0,
    scan: 0,
    restore: 0,
    verify: 0,
  };
  const horizon = 600;

  for (let t = 0; t <= horizon; t++) {
    for (const st of Object.values(byId)) {
      if (st.status === 'running' && st.end === t) {
        st.status = st.timedOut ? 'timed-out' : 'done';
        laneBusy[st.lane] -= 1;
      }
    }

    if (
      Object.values(byId).every((s) => s.status !== 'pending' && s.status !== 'running')
    ) {
      break;
    }

    // Failure closure: a timed-out or blocked step poisons everything downstream.
    let changed = true;
    while (changed) {
      changed = false;
      for (const st of Object.values(byId)) {
        if (st.status !== 'pending') continue;
        const bad = st.deps.some((d) => {
          const dep = byId[d];
          return dep.status === 'timed-out' || dep.status === 'blocked';
        });
        if (bad) {
          st.status = 'blocked';
          changed = true;
        }
      }
    }

    const ready = Object.values(byId)
      .filter(
        (s) =>
          s.status === 'pending' &&
          laneBusy[s.lane] < laneCapacity(plan, s.lane) &&
          s.deps.every((d) => byId[d].status === 'done'),
      )
      .sort(compareSteps);

    for (const st of ready) {
      if (laneBusy[st.lane] >= laneCapacity(plan, st.lane)) continue;
      const limit = timeoutMap.get(st.id);
      const timedOut = limit != null && limit < st.durationMin;
      st.start = t;
      st.timedOut = timedOut;
      st.plannedEnd = t + st.durationMin;
      st.end = t + (timedOut ? limit : st.durationMin);
      st.status = 'running';
      laneBusy[st.lane] += 1;
    }
  }

  for (const st of Object.values(byId)) {
    if (st.status === 'pending' || st.status === 'running') st.status = 'blocked';
  }

  const planned = Object.values(byId);
  const effectiveTimeouts: Record<string, number> = {};
  for (const [k, v] of timeoutMap) {
    if (byId[k]) effectiveTimeouts[k] = v;
  }
  const effectIntents: EffectIntent[] = planned
    .filter((s) => s.effectKey)
    .map((s) => {
      const applied = appliedEffects[s.effectKey!];
      const ran = s.status === 'done' && !s.carried;
      const state = applied
        ? 'reused'
        : ran
          ? 'applied'
          : s.status === 'timed-out'
            ? 'missed'
            : 'blocked';
      return {
        key: s.effectKey!,
        kind: s.kind === 'cert' ? 'cert' : 'config',
        serviceId: s.serviceId,
        label: s.effectLabel ?? '',
        stepId: s.id,
        reused: Boolean(applied),
        applied: !applied && ran,
        state,
        carried: s.carried,
      };
    });

  const outcomes = deriveOutcomes(planned, plan);
  const criticalOutcomes = outcomes.filter((o) => o.tier === 1);
  const criticalAvailable = criticalOutcomes.filter(
    (o) => o.state === 'restored' || o.state === 'degraded',
  ).length;

  // RTO is only reportable when every core service is available; otherwise the
  // honest answer is "not met" (null), never a partial max.
  const rtoMin = criticalOutcomes.every((o) => o.restoredAtMin !== null)
    ? Math.max(...criticalOutcomes.map((o) => o.restoredAtMin!))
    : null;

  const rpoMin =
    criticalOutcomes.length > 0
      ? Math.max(...criticalOutcomes.map((o) => o.dataLossMin))
      : null;

  const makespanMin = planned.reduce((m, s) => Math.max(m, s.end), 0);

  return {
    planId: plan.id,
    planName: plan.name,
    targets,
    timeouts: effectiveTimeouts,
    steps: planned.sort((a, b) => a.start - b.start || compareSteps(a, b)),
    outcomes,
    rtoMin,
    rpoMin,
    criticalTotal: criticalOutcomes.length,
    criticalAvailable,
    restoredCount: outcomes.filter((o) => o.state === 'restored').length,
    degradedCount: outcomes.filter((o) => o.state === 'degraded').length,
    waitingCount: outcomes.filter((o) => o.state === 'waiting').length,
    failedCount: outcomes.filter((o) => o.state === 'failed').length,
    makespanMin,
    effectIntents,
    newEffectCount: effectIntents.filter((e) => e.applied).length,
    reusedEffectCount: effectIntents.filter((e) => e.reused).length,
    carriedStepCount: planned.filter((s) => s.carried).length,
    signature: requestSignature(plan, targets, effectiveTimeouts),
    timedOutSteps: planned.filter((s) => s.timedOut).length,
    configScopeLabel: plan.configScope === 'all' ? '全量服务' : '仅核心服务',
  };
}

/**
 * Per-service outcome, resolved in dependency order.
 *
 * restored  – own chain finished and every upstream service is usable.
 * degraded  – same, but the service carries an accepted risk (lapsed certificate,
 *             stale recovery point, skipped non-core config).
 * failed    – this service's own chain was cut (restore/verify timed out, or one of
 *             its own prep steps was missed).
 * waiting   – the service itself is fine, but an upstream service is not, so it
 *             must wait. This is the "必须等待" bucket.
 */
function deriveOutcomes(steps: PlannedStep[], plan: PlanParams): ServiceOutcome[] {
  const byId = Object.fromEntries(steps.map((s) => [s.id, s]));
  const stateOf: Record<string, ServiceOutcome['state']> = {};
  const failedOwn: Record<string, string | null> = {};
  const pending = new Set(scenario.services.map((s) => s.id));

  const failedDepOf = (step: PlannedStep): string | null => {
    const dep = step.deps.find((d) => {
      const s = byId[d];
      return !s || s.status === 'blocked' || s.status === 'timed-out';
    });
    return dep ?? null;
  };

  for (let guard = 0; pending.size && guard < 40; guard++) {
    let progressed = false;
    for (const id of [...pending]) {
      const svc = serviceById[id];
      if (!svc.deps.every((d) => stateOf[d] !== undefined)) continue;
      const verify = byId[`${id}:verify`];
      const restore = byId[`${id}:restore`];
      const upstreamBad = svc.deps.some(
        (d) => stateOf[d] === 'failed' || stateOf[d] === 'waiting',
      );

      if (verify?.status === 'done') {
        stateOf[id] = hasRisk(id, steps, plan) ? 'degraded' : 'restored';
        failedOwn[id] = null;
        pending.delete(id);
        progressed = true;
        continue;
      }

      if (upstreamBad) {
        stateOf[id] = 'waiting';
        failedOwn[id] = null;
        pending.delete(id);
        progressed = true;
        continue;
      }

      // Upstream is fine, so this service's own chain is what failed.
      const ownFailure =
        restore?.status === 'timed-out'
          ? restore.id
          : (() => {
              const dep = restore ? failedDepOf(restore) : null;
              return dep && dep.startsWith(`${id}:`) ? dep : null;
            })() ??
          (verify?.status === 'timed-out'
            ? verify.id
            : restore?.status === 'blocked'
              ? restore.id
              : verify?.status === 'blocked'
                ? verify.id
                : null);

      if (ownFailure || (restore && restore.status !== 'pending')) {
        stateOf[id] = 'failed';
        failedOwn[id] = ownFailure;
        pending.delete(id);
        progressed = true;
      }
    }
    if (!progressed) break;
  }

  return scenario.services.map((svc) => {
    const restore = byId[`${svc.id}:restore`];
    const verify = byId[`${svc.id}:verify`];
    const state = stateOf[svc.id] ?? 'waiting';
    const reasons: string[] = [];
    const risks: string[] = [];
    const carriedPrep: string[] = [];
    const blockedBy = svc.deps.filter(
      (d) => stateOf[d] === 'failed' || stateOf[d] === 'waiting',
    );

    for (const prep of steps.filter(
      (s) => s.serviceId === svc.id && (s.kind === 'config' || s.kind === 'cert'),
    )) {
      if (prep.carried) carriedPrep.push(`${prep.effectLabel}（沿用已执行记录）`);
      else if (prep.status === 'done') carriedPrep.push(prep.effectLabel ?? prep.kind);
      else if (prep.status === 'timed-out')
        reasons.push(`${prep.kind === 'cert' ? '证书续期' : '配置下发'}超时未完成`);
    }

    if (restore?.status === 'done') reasons.push(`数据恢复完成 T+${restore.end}′`);
    else if (restore?.status === 'timed-out')
      reasons.push(`数据恢复在 T+${restore.end}′ 被超时中止`);
    else if (restore?.status === 'blocked') reasons.push('前置步骤未通过，恢复未启动');

    if (verify?.status === 'done') reasons.push(`业务验证通过 T+${verify.end}′`);
    else if (verify?.status === 'timed-out') reasons.push('业务验证超时，未确认可用');
    else if (verify?.status === 'blocked') {
      reasons.push(blockedBy.length ? '上游未就绪，业务验证未执行' : '业务验证被前置失败阻塞');
    }

    const certLeft = certMinutesLeft(svc.id);
    const certStep = byId[`${svc.id}:cert`];
    if (certLeft < MANDATORY_CERT_MIN) {
      if (!certStep) risks.push(`证书 ${Math.max(0, Math.round(certLeft))} 分钟后到期`);
      else if (certStep.status !== 'done') risks.push('证书到期前未完成续期');
    }
    if (svc.config && plan.configScope === 'tier1' && svc.tier > 1) {
      risks.push('非核心服务配置漂移未对齐');
    }
    if (plan.snapshotPolicy === 'local' && svc.localLagMin > 5) {
      risks.push(`本地快照恢复点较旧，丢失约 ${svc.localLagMin} 分钟数据`);
    }

    return {
      id: svc.id,
      name: svc.name,
      shortName: svc.shortName,
      tier: svc.tier,
      state,
      restoredAtMin: verify?.status === 'done' ? verify.end : null,
      dataLossMin: dataLossMin(svc.id, plan),
      reasons,
      risks,
      carriedPrep,
      upstream: svc.deps,
      failedStep: failedOwn[svc.id] ?? null,
      blockedBy,
    };
  });
}

function hasRisk(serviceId: string, steps: PlannedStep[], plan: PlanParams): boolean {
  const svc = serviceById[serviceId];
  const byId = Object.fromEntries(steps.map((s) => [s.id, s]));
  const certStep = byId[`${serviceId}:cert`];
  if (certMinutesLeft(serviceId) < MANDATORY_CERT_MIN && (!certStep || certStep.status !== 'done'))
    return true;
  if (svc.config && plan.configScope === 'tier1' && svc.tier > 1) return true;
  return false;
}

/** Stable identity of a drill request: plan + targets + timeouts + scenario version. */
export function requestSignature(
  plan: PlanParams,
  targets: Targets,
  timeouts: Record<string, number>,
): string {
  const to = Object.entries(timeouts)
    .filter(([, v]) => Number.isFinite(v) && v > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${Math.floor(v)}`)
    .join(',');
  return [scenario.version, plan.id, `rto:${targets.rto}`, `rpo:${targets.rpo}`, `to:[${to}]`].join(
    '|',
  );
}

/** Breaches for a run: RTO/RPO misses that are visible, not buried in aggregates. */
export function breachesOf(run: RunResult): string[] {
  const out: string[] = [];
  if (run.rtoMin === null) {
    out.push('核心服务未全部恢复，RTO 无法达标');
  } else if (run.rtoMin > run.targets.rto) {
    out.push(`RTO ${run.rtoMin} 分钟，超出目标 ${run.rtoMin - run.targets.rto} 分钟`);
  }
  if (run.rpoMin !== null && run.rpoMin > run.targets.rpo) {
    out.push(`RPO ${run.rpoMin} 分钟，超出目标 ${run.rpoMin - run.targets.rpo} 分钟`);
  }
  return out;
}

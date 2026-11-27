import type {
  EffectEntry,
  EffectIntent,
  ExecutedRun,
  Ledger,
  RequestRecord,
  RunResult,
  Scenario,
  Workspace,
} from './types';

export interface ExecuteContext {
  workspace: Workspace;
  run: RunResult;
  scenario: Scenario;
  pathName: string;
  breaches: string[];
}

export function emptyWorkspace(scenarioVersion: string): Workspace {
  const ledger: Ledger = { effects: {}, batchSeq: 0, requestSeq: 0 };
  return {
    schema: 1,
    scenarioVersion,
    ledger,
    requests: [],
    archive: {},
    decisions: [],
  };
}

export function normalizeWorkspace(raw: unknown, scenarioVersion: string): Workspace {
  const base = emptyWorkspace(scenarioVersion);
  if (!raw || typeof raw !== 'object') return base;
  const w = raw as Partial<Workspace>;
  if (w.schema !== 1) return base;
  if (w.scenarioVersion !== scenarioVersion) return base;
  return {
    schema: 1,
    scenarioVersion,
    ledger: {
      effects: w.ledger?.effects ?? {},
      batchSeq: Number.isFinite(w.ledger?.batchSeq) ? w.ledger!.batchSeq : 0,
      requestSeq: Number.isFinite(w.ledger?.requestSeq) ? w.ledger!.requestSeq : 0,
    },
    requests: Array.isArray(w.requests) ? w.requests : [],
    archive: w.archive && typeof w.archive === 'object' ? w.archive : {},
    decisions: Array.isArray(w.decisions) ? w.decisions : [],
  };
}

/** Simulated wall-clock: drill start + minutes elapsed. */
function drillIso(scenario: Scenario, minute: number): string {
  const t = Date.parse(scenario.drillAt) + Math.max(0, minute) * 60_000;
  return new Date(t).toISOString();
}

/**
 * Record a drill request at most once per signature.
 *
 * Idempotency contract
 *  - The signature is plan + targets + timeouts + scenario version.
 *  - A repeat with the same signature returns the archived result and only bumps
 *    the `replays` counter: no new batch, no new ledger write, no re-applied effect.
 *  - A *different* signature still reuses the ledger: every effect already recorded
 *    is carried, so prep steps never run twice across plans either.
 */
export function executeRun(ctx: ExecuteContext): {
  workspace: Workspace;
  executed: ExecutedRun;
  replayed: boolean;
} {
  const { workspace, run, scenario } = ctx;

  const prior = workspace.archive[run.signature];
  if (prior) {
    const requests = workspace.requests.map((r) =>
      r.requestId === prior.requestId ? { ...r, replays: r.replays + 1 } : r,
    );
    return {
      workspace: { ...workspace, requests },
      executed: prior,
      replayed: true,
    };
  }

  const batchSeq = workspace.ledger.batchSeq + 1;
  const requestSeq = workspace.ledger.requestSeq + 1;
  const batchId = `B-${String(batchSeq).padStart(3, '0')}`;
  const requestId = `${batchId}-R${String(requestSeq).padStart(3, '0')}`;
  const at = drillIso(scenario, run.makespanMin);

  // The ledger — not the in-memory run — is authoritative. Even if a caller hands
  // us a run simulated against a stale ledger, an effect already recorded must
  // never be applied a second time.
  const effects: Record<string, EffectEntry> = { ...workspace.ledger.effects };
  const written: string[] = [];
  const intents: EffectIntent[] = run.effectIntents.map((intent) => {
    if (effects[intent.key]) {
      return { ...intent, reused: true, applied: false, state: 'reused' as const };
    }
    if (!intent.applied) return intent;
    effects[intent.key] = {
      key: intent.key,
      kind: intent.kind,
      serviceId: intent.serviceId,
      label: intent.label,
      batchId,
      requestId,
      at,
    };
    // Count what this batch actually wrote. Leave the intent as 'applied': this
    // view reports how this run landed, while the ledger is what later runs read.
    written.push(intent.key);
    return intent;
  });

  const carriedSteps = run.steps.filter((s) => s.carried).length;
  const executed: ExecutedRun = {
    ...run,
    effectIntents: intents,
    newEffectCount: written.length,
    reusedEffectCount: intents.filter((i) => i.reused && written.indexOf(i.key) < 0).length,
    batchId,
    requestId,
    batchReused: false,
    executedAt: at,
    decision: null,
    breaches: ctx.breaches,
  };

  const record: RequestRecord = {
    requestId,
    batchId,
    signature: run.signature,
    pathId: run.planId,
    pathName: ctx.pathName,
    createdAt: at,
    sequence: requestSeq,
    replays: 0,
    rtoMin: run.rtoMin,
    rpoMin: run.rpoMin,
    makespanMin: run.makespanMin,
    newEffects: written.length,
    reusedEffects: intents.filter((i) => i.reused).length,
    carriedSteps,
    timedOutSteps: run.timedOutSteps,
    breached: ctx.breaches.length > 0,
    breaches: ctx.breaches,
  };

  return {
    workspace: {
      ...workspace,
      ledger: { effects, batchSeq, requestSeq },
      requests: [record, ...workspace.requests],
      archive: { ...workspace.archive, [run.signature]: executed },
    },
    executed,
    replayed: false,
  };
}

export function acceptDecision(
  workspace: Workspace,
  executed: ExecutedRun,
  breaches: string[],
  scenario: Scenario,
): Workspace {
  const decision = {
    requestId: executed.requestId,
    pathId: executed.planId,
    acceptedAt: drillIso(scenario, executed.makespanMin),
    rtoTarget: executed.targets.rto,
    rpoTarget: executed.targets.rpo,
    rtoActual: executed.rtoMin,
    rpoActual: executed.rpoMin,
    breaches,
  };
  return {
    ...workspace,
    decisions: [decision, ...workspace.decisions],
    archive: {
      ...workspace.archive,
      [executed.signature]: { ...executed, decision },
    },
  };
}

export function effectSummary(workspace: Workspace): {
  total: number;
  config: number;
  cert: number;
  batches: number;
} {
  const values = Object.values(workspace.ledger.effects);
  return {
    total: values.length,
    config: values.filter((e) => e.kind === 'config').length,
    cert: values.filter((e) => e.kind === 'cert').length,
    batches: new Set(values.map((e) => e.batchId)).size,
  };
}

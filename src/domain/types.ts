export type Tier = 1 | 2 | 3;

export type StepKind = 'config' | 'cert' | 'scan' | 'restore' | 'verify';

export type LaneId = 'config' | 'pki' | 'scan' | 'restore' | 'verify';

export type StepStatus = 'pending' | 'running' | 'done' | 'timed-out' | 'blocked';

/** restored = usable and verified; degraded = usable with an accepted risk. */
export type ServiceState = 'restored' | 'degraded' | 'waiting' | 'failed';

export type EffectState = 'reused' | 'applied' | 'missed' | 'blocked';

export type EffectKind = 'config' | 'cert';

export interface ConfigDrift {
  from: string;
  to: string;
  applyMin: number;
}

export interface Certificate {
  notAfter: string;
  renewMin: number;
}

export interface Service {
  id: string;
  name: string;
  shortName: string;
  tier: Tier;
  deps: string[];
  restoreMin: number;
  verifyMin: number;
  scanMin: number;
  config?: ConfigDrift;
  cert: Certificate;
  /** Age of the newest local block snapshot, in minutes before the drill clock. */
  localLagMin: number;
  /** Age to which the vault copy can be rolled forward with archived logs. */
  vaultLagMin: number;
}

export interface Scenario {
  id: string;
  version: string;
  name: string;
  site: string;
  event: string;
  drillAt: string;
  recoveryWindowMin: number;
  services: Service[];
}

export type PathId = 'latency' | 'data';

export interface PlanParams {
  id: PathId;
  name: string;
  tagline: string;
  snapshotPolicy: 'local' | 'vault';
  configScope: 'tier1' | 'all';
  configLanes: number;
  certWindowMin: number;
  restoreLanes: number;
  integrityScan: boolean;
}

export interface Targets {
  rto: number;
  rpo: number;
}

export interface UrgencyParts {
  tier: number;
  downstream: number;
  config: number;
  cert: number;
  recoveryPoint: number;
}

export interface Step {
  id: string;
  serviceId: string;
  kind: StepKind;
  lane: LaneId;
  durationMin: number;
  deps: string[];
  urgency: number;
  urgencyParts: UrgencyParts;
  effectKey?: string;
  effectLabel?: string;
}

export interface EffectIntent {
  key: string;
  kind: EffectKind;
  serviceId: string;
  label: string;
  stepId: string;
  /** Already in the ledger before this run. */
  reused: boolean;
  /** Applied by this run (i.e. a new side effect). */
  applied: boolean;
  state: EffectState;
}

export interface PlannedStep extends Step {
  start: number;
  end: number;
  plannedEnd: number;
  status: StepStatus;
  timedOut: boolean;
  /** Carried from the ledger: the effect exists, so the step never runs again. */
  carried: boolean;
}

export interface ServiceOutcome {
  id: string;
  name: string;
  shortName: string;
  tier: Tier;
  state: ServiceState;
  /** Verify finish minute when the service is available; null otherwise. */
  restoredAtMin: number | null;
  dataLossMin: number;
  reasons: string[];
  risks: string[];
  carriedPrep: string[];
  upstream: string[];
  /** First failing step in this service's own chain, if any. */
  failedStep: string | null;
  blockedBy: string[];
}

export interface EffectEntry {
  key: string;
  kind: EffectKind;
  serviceId: string;
  label: string;
  batchId: string;
  requestId: string;
  /** Simulated drill time, ISO 8601. */
  at: string;
}

export interface Ledger {
  effects: Record<string, EffectEntry>;
  batchSeq: number;
  requestSeq: number;
}

export interface DecisionRecord {
  requestId: string;
  pathId: PathId;
  acceptedAt: string;
  rtoTarget: number;
  rpoTarget: number;
  rtoActual: number | null;
  rpoActual: number | null;
  breaches: string[];
}

export interface RequestRecord {
  requestId: string;
  batchId: string;
  signature: string;
  pathId: PathId;
  pathName: string;
  createdAt: string;
  sequence: number;
  replays: number;
  rtoMin: number | null;
  rpoMin: number | null;
  makespanMin: number;
  newEffects: number;
  reusedEffects: number;
  carriedSteps: number;
  timedOutSteps: number;
  breached: boolean;
  breaches: string[];
}

export interface RunInput {
  plan: PlanParams;
  targets: Targets;
  timeouts: Record<string, number>;
  appliedEffects: Record<string, EffectEntry>;
}

export interface RunResult {
  planId: PathId;
  planName: string;
  targets: Targets;
  timeouts: Record<string, number>;
  steps: PlannedStep[];
  outcomes: ServiceOutcome[];
  rtoMin: number | null;
  rpoMin: number | null;
  criticalTotal: number;
  criticalAvailable: number;
  restoredCount: number;
  degradedCount: number;
  waitingCount: number;
  failedCount: number;
  makespanMin: number;
  effectIntents: EffectIntent[];
  newEffectCount: number;
  reusedEffectCount: number;
  carriedStepCount: number;
  signature: string;
  timedOutSteps: number;
  configScopeLabel: string;
}

export interface ExecutedRun extends RunResult {
  batchId: string;
  requestId: string;
  batchReused: boolean;
  executedAt: string;
  decision: DecisionRecord | null;
  breaches: string[];
}

export interface PathAssessment {
  plan: PlanParams;
  run: RunResult;
  rtoMin: number | null;
  rpoMin: number | null;
  rtoOk: boolean;
  rpoOk: boolean;
  bothOk: boolean;
  rtoOverMin: number;
  rpoOverMin: number;
  rtoMarginMin: number;
  rpoMarginMin: number;
  configServices: string[];
  certServices: string[];
  deferredConfigServices: string[];
  deferredCertServices: string[];
  scanServiceCount: number;
  reuseCount: number;
  rpoBreachServices: { id: string; name: string; loss: number }[];
  costs: string[];
  gains: string[];
}

export interface Tradeoff {
  targets: Targets;
  paths: PathAssessment[];
  anyCompliant: boolean;
  allCompliant: boolean;
  needsDecision: boolean;
  headline: string;
  recommendation: string;
}

export interface Workspace {
  schema: 1;
  scenarioVersion: string;
  ledger: Ledger;
  requests: RequestRecord[];
  archive: Record<string, ExecutedRun>;
  decisions: DecisionRecord[];
}

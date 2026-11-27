import type {
  Certificate,
  ConfigDrift,
  LaneId,
  PlanParams,
  Scenario,
  Service,
  StepKind,
  Targets,
  Tier,
} from './types';

/**
 * Drill clock. Everything in the scenario is expressed relative to this instant so
 * the exercise is deterministic (no "today" drift between runs).
 */
export const DRILL_AT = '2026-11-27T11:40:00+08:00';
export const SCENARIO_VERSION = '2026.11.27-a';

const cert = (notAfter: string, renewMin: number): Certificate => ({
  notAfter,
  renewMin,
});

const drift = (from: string, to: string, applyMin: number): ConfigDrift => ({
  from,
  to,
  applyMin,
});

const services: Service[] = [
  {
    id: 'edge',
    name: '接入网关',
    shortName: '接入',
    tier: 1,
    deps: [],
    restoreMin: 4,
    verifyMin: 3,
    scanMin: 3,
    cert: cert('2026-12-09T09:00:00+08:00', 6),
    localLagMin: 2,
    vaultLagMin: 1,
  },
  {
    id: 'auth',
    name: '统一认证',
    shortName: '认证',
    tier: 1,
    deps: ['edge'],
    restoreMin: 6,
    verifyMin: 4,
    scanMin: 4,
    config: drift('v14', 'v15', 4),
    cert: cert('2026-11-27T12:55:00+08:00', 6),
    localLagMin: 3,
    vaultLagMin: 1,
  },
  {
    id: 'pay-db',
    name: '支付账务库',
    shortName: '账务库',
    tier: 1,
    deps: [],
    restoreMin: 13,
    verifyMin: 5,
    scanMin: 8,
    cert: cert('2027-02-20T09:00:00+08:00', 8),
    localLagMin: 9,
    vaultLagMin: 2,
  },
  {
    id: 'msg',
    name: '消息总线',
    shortName: '消息',
    tier: 1,
    deps: [],
    restoreMin: 7,
    verifyMin: 4,
    scanMin: 5,
    config: drift('v41', 'v42', 5),
    cert: cert('2026-11-27T19:40:00+08:00', 6),
    localLagMin: 5,
    vaultLagMin: 2,
  },
  {
    id: 'risk',
    name: '风控引擎',
    shortName: '风控',
    tier: 1,
    deps: ['auth', 'msg'],
    restoreMin: 6,
    verifyMin: 4,
    scanMin: 5,
    config: drift('v8', 'v9', 4),
    cert: cert('2026-11-27T10:25:00+08:00', 8),
    localLagMin: 4,
    vaultLagMin: 1,
  },
  {
    id: 'pay',
    name: '支付核心',
    shortName: '支付',
    tier: 1,
    deps: ['auth', 'pay-db'],
    restoreMin: 8,
    verifyMin: 4,
    scanMin: 7,
    config: drift('v18', 'v19', 7),
    cert: cert('2027-03-02T09:00:00+08:00', 6),
    localLagMin: 6,
    vaultLagMin: 2,
  },
  {
    id: 'clearing',
    name: '清结算',
    shortName: '清结算',
    tier: 2,
    deps: ['pay'],
    restoreMin: 6,
    verifyMin: 3,
    scanMin: 4,
    config: drift('v9', 'v10', 5),
    cert: cert('2026-11-30T09:00:00+08:00', 5),
    localLagMin: 12,
    vaultLagMin: 4,
  },
  {
    id: 'session',
    name: '会话缓存',
    shortName: '会话',
    tier: 2,
    deps: [],
    restoreMin: 3,
    verifyMin: 2,
    scanMin: 2,
    cert: cert('2027-01-08T09:00:00+08:00', 4),
    localLagMin: 1,
    vaultLagMin: 1,
  },
  {
    id: 'report',
    name: '对账报表',
    shortName: '报表',
    tier: 3,
    deps: ['pay-db'],
    restoreMin: 5,
    verifyMin: 3,
    scanMin: 3,
    config: drift('v6', 'v7', 4),
    cert: cert('2027-04-01T09:00:00+08:00', 5),
    localLagMin: 30,
    vaultLagMin: 7,
  },
  {
    id: 'ops',
    name: '运维控制台',
    shortName: '控制台',
    tier: 2,
    deps: ['auth'],
    restoreMin: 4,
    verifyMin: 3,
    scanMin: 3,
    config: drift('v22', 'v23', 5),
    cert: cert('2026-12-17T09:00:00+08:00', 7),
    localLagMin: 2,
    vaultLagMin: 1,
  },
];

export const scenario: Scenario = {
  id: 'cn-east-pay',
  version: SCENARIO_VERSION,
  name: '支付链路 · 同城灾备切换',
  site: '上海 · 可用区 B 演练沙箱',
  event: '可用区 A 存储阵列失联，触发整链路切换演练',
  drillAt: DRILL_AT,
  recoveryWindowMin: 90,
  services,
};

export const defaultTargets: Targets = { rto: 40, rpo: 6 };

export const pathA: PlanParams = {
  id: 'latency',
  name: '先接管',
  tagline: '本地热备直接拉起，只处理核心服务的配置与证书缺口',
  snapshotPolicy: 'local',
  configScope: 'tier1',
  configLanes: 2,
  certWindowMin: 150,
  restoreLanes: 4,
  integrityScan: false,
};

export const pathB: PlanParams = {
  id: 'data',
  name: '先对齐',
  tagline: '恢复点完整性校验后拉起，配置与证书全量对齐',
  snapshotPolicy: 'vault',
  configScope: 'all',
  configLanes: 2,
  certWindowMin: 60 * 24 * 30,
  restoreLanes: 2,
  integrityScan: true,
};

export const plans: PlanParams[] = [pathA, pathB];
export const planById: Record<string, PlanParams> = { latency: pathA, data: pathB };

/** Renewal is forced regardless of the plan window when expiry is this close. */
export const MANDATORY_CERT_MIN = 180;

export const LANE_LABEL: Record<LaneId, string> = {
  config: '配置下发',
  pki: '证书续期',
  scan: '校验通道',
  restore: '恢复通道',
  verify: '业务验证',
};

export const LANE_CAPACITY: Record<Exclude<LaneId, 'config' | 'restore'>, number> = {
  pki: 1,
  scan: 2,
  verify: 2,
};

export const KIND_LABEL: Record<StepKind, string> = {
  config: '配置下发',
  cert: '证书续期',
  scan: '完整性校验',
  restore: '数据恢复',
  verify: '业务验证',
};

export const TIER_LABEL: Record<Tier, string> = {
  1: '核心',
  2: '重要',
  3: '一般',
};

export const serviceById: Record<string, Service> = Object.fromEntries(
  services.map((s) => [s.id, s]),
);

/** Number of services that transitively depend on each service. */
export const downstreamCount: Record<string, number> = (() => {
  const out: Record<string, number> = {};
  for (const s of services) {
    const seen = new Set<string>();
    const stack = [...s.deps];
    while (stack.length) {
      const d = stack.pop()!;
      if (seen.has(d)) continue;
      seen.add(d);
      stack.push(...(serviceById[d]?.deps ?? []));
    }
    out[s.id] = seen.size;
  }
  return out;
})();

export const criticalServices = services.filter((s) => s.tier === 1);

export const DRILL_EPOCH = Date.parse(DRILL_AT);

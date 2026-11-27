import type {
  EffectEntry,
  LaneId,
  PathId,
  ServiceState,
  StepKind,
  StepStatus,
  Tier,
} from '../domain/types';

export const fmtMin = (n: number | null): string =>
  n === null ? '未达标' : `${Math.round(n)}′`;

export const fmtMinLong = (n: number | null): string =>
  n === null ? '演练窗口内未完成' : `${Math.round(n)} 分钟`;

export const fmtInt = (n: number): string => new Intl.NumberFormat('zh-CN').format(n);

export const fmtClock = (iso: string): string => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export const fmtDateTime = (iso: string): string => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')} ${fmtClock(iso)}`;
};

export const shortSig = (sig: string): string => {
  let h = 2166136261;
  for (let i = 0; i < sig.length; i++) {
    h ^= sig.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `SIG-${(h >>> 0).toString(16).toUpperCase().padStart(8, '0').slice(0, 6)}`;
};

export const TIER_TEXT: Record<Tier, string> = { 1: '核心', 2: '重要', 3: '一般' };

export const LANE_TEXT: Record<LaneId, string> = {
  config: '配置下发',
  pki: '证书续期',
  scan: '完整性校验',
  restore: '数据恢复',
  verify: '业务验证',
};

export const KIND_TEXT: Record<StepKind, string> = {
  config: '配置',
  cert: '证书',
  scan: '校验',
  restore: '恢复',
  verify: '验证',
};

export const STATUS_TEXT: Record<StepStatus, string> = {
  pending: '待执行',
  running: '执行中',
  done: '完成',
  'timed-out': '超时中止',
  blocked: '被阻塞',
};

export const STATE_TEXT: Record<ServiceState, string> = {
  restored: '可恢复',
  degraded: '降级可用',
  waiting: '必须等待',
  failed: '不可用',
};

export const PATH_TEXT: Record<PathId, string> = {
  latency: '先接管',
  data: '先对齐',
};

export const effectKeyShort = (key: string): string => {
  if (key.startsWith('config:')) return `配置 · ${key.split(':')[1]}`;
  if (key.startsWith('cert:')) return `证书 · ${key.split(':')[1]}`;
  return key;
};

export function landedEffects(effects: Record<string, EffectEntry>): EffectEntry[] {
  return Object.values(effects).sort((a, b) => a.key.localeCompare(b.key));
}

export function relativeDay(iso: string): string {
  const days = Math.round(
    (Date.parse(iso) - Date.parse('2026-11-27T11:40:00+08:00')) / 86_400_000,
  );
  if (days === 0) return '演练当天';
  if (days > 0) return `+${days} 天`;
  return `${days} 天`;
}

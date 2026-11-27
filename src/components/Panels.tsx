import { CircleAlert, CircleCheck, CircleDashed, Clock, KeyRound, FileSliders } from 'lucide-react';
import type {
  EffectIntent,
  PathAssessment,
  PlannedStep,
  ServiceOutcome,
} from '../domain/types';
import { serviceById, scenario } from '../domain/scenario';
import {
  KIND_TEXT,
  LANE_TEXT,
  STATE_TEXT,
  TIER_TEXT,
  fmtMin,
} from '../lib/format';

export function Badge({
  tone,
  children,
  icon,
}: {
  tone?: 'good' | 'warn' | 'critical' | 'accent' | 'carried' | 'neutral';
  children: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <span className={`badge ${tone ?? ''}`}>
      {icon}
      {children}
    </span>
  );
}

export function PathBadges({ path: p }: { path: PathAssessment }) {
  const { run } = p;
  return (
    <>
      {p.rtoOk ? (
        <Badge tone="good" icon={<CircleCheck size={11} />}>
          RTO 达标
        </Badge>
      ) : (
        <Badge tone="critical" icon={<CircleAlert size={11} />}>
          RTO {p.rtoMin === null ? '不可用' : `超 ${Math.round(p.rtoOverMin)}′`}
        </Badge>
      )}
      {p.rpoOk ? (
        <Badge tone="good" icon={<CircleCheck size={11} />}>
          RPO 达标
        </Badge>
      ) : (
        <Badge tone="warn" icon={<CircleAlert size={11} />}>
          RPO 超 {p.rpoOverMin === Infinity ? '—' : `${Math.round(p.rpoOverMin)}′`}
        </Badge>
      )}
      {run.timedOutSteps > 0 && (
        <Badge tone="critical">{run.timedOutSteps} 步超时</Badge>
      )}
      {run.reusedEffectCount > 0 && (
        <Badge tone="carried">{run.reusedEffectCount} 项沿用</Badge>
      )}
    </>
  );
}

export function Meter({
  label,
  value,
  target,
  over,
  max,
  format,
}: {
  label: string;
  value: number | null;
  target: number;
  over: boolean;
  max: number;
  format: (n: number | null) => string;
}) {
  const pct = value === null ? 100 : Math.min(100, (value / max) * 100);
  const targetPct = Math.min(98, (target / max) * 100);
  return (
    <div className="meter-block">
      <div className="meter-top">
        <span className="meter-name">{label}</span>
        <span className="meter-value">{format(value)}</span>
        <span className="meter-target">目标 ≤ {target}′</span>
      </div>
      <div className={`meter${over ? ' over' : ''}`} aria-hidden="true">
        <div className="meter-fill" style={{ width: `${pct}%` }} />
        <div className="meter-tick" style={{ left: `${targetPct}%` }} />
      </div>
    </div>
  );
}

export function StepInspector({
  step,
  run,
  timeout,
  onTimeoutChange,
  selectedService,
  onSelectService,
  effect,
}: {
  step: PlannedStep | null;
  run: PathAssessment['run'];
  timeout: number | undefined;
  onTimeoutChange: (value: number | undefined) => void;
  selectedService: string | null;
  onSelectService: (id: string) => void;
  effect: EffectIntent | undefined;
}) {
  if (!step) {
    return (
      <div className="empty-insp">
        <div className="eyebrow" style={{ marginBottom: 8 }}>
          <Clock size={12} /> 步骤检查器
        </div>
        在左侧时间轴点选任意步骤，查看它为什么排在这个位置，并为它注入超时。
      </div>
    );
  }

  const svc = serviceById[step.serviceId];
  const downstreamServices = scenario.services.filter((s) => s.deps.includes(step.serviceId));
  const maxUrg = Math.max(
    step.urgencyParts.tier +
      step.urgencyParts.downstream +
      step.urgencyParts.config +
      step.urgencyParts.cert +
      step.urgencyParts.recoveryPoint,
    1,
  );
  const injected = timeout !== undefined && timeout < step.durationMin;
  const wouldBlock = injected
    ? downstreamCountServices(step.serviceId)
    : [];

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="insp-head">
        <div className={`verdict-icon`} style={{ width: 30, height: 30 }}>
          {step.kind === 'cert' ? (
            <KeyRound size={15} />
          ) : step.kind === 'config' ? (
            <FileSliders size={15} />
          ) : step.kind === 'scan' ? (
            <CircleDashed size={15} />
          ) : (
            <Clock size={15} />
          )}
        </div>
        <div>
          <div className="insp-title">{svc.name}</div>
          <div className="insp-sub">
            {KIND_TEXT[step.kind]} · {LANE_TEXT[step.lane]} · Tier{TEXTIER(svc.tier)}
          </div>
        </div>
        {step.timedOut && <span className="badge critical">已超时</span>}
      </div>

      <div className="meta-grid">
        <div className="kv">
          <dt>开始</dt>
          <dd className="mono">T+{step.start}′</dd>
        </div>
        <div className="kv">
          <dt>结束</dt>
          <dd className="mono">
            T+{step.end}′
            {step.timedOut && (
              <span className="muted" style={{ marginLeft: 6 }}>
                / 计划 {step.plannedEnd}′
              </span>
            )}
          </dd>
        </div>
        <div className="kv">
          <dt>计划耗时</dt>
          <dd className="mono">{step.durationMin} 分钟</dd>
        </div>
        <div className="kv">
          <dt>上游依赖</dt>
          <dd>
            {step.deps.length === 0 ? (
              <span className="muted">无</span>
            ) : (
              <span className="mono" style={{ fontSize: 11 }}>
                {step.deps.length} 项
              </span>
            )}
          </dd>
        </div>
      </div>

      {step.deps.length > 0 && (
        <div className="dep-chips">
          {step.deps.map((d) => {
            const dep = run.steps.find((s) => s.id === d);
            const depSvc = d.split(':')[0];
            return (
              <button
                key={d}
                className="dep-chip"
                onClick={() => onSelectService(depSvc)}
                title={dep ? `状态：${dep.status}` : '不在当前路径中'}
              >
                {serviceById[depSvc]?.name ?? depSvc}
                {dep && dep.status !== 'done' && (
                  <span style={{ color: 'var(--critical)' }}>·</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <div className="urgency">
        <div className="urgency-head">
          <span className="path-section-label" style={{ letterSpacing: '0.06em' }}>
            排序权重
          </span>
          <span className="urgency-total">{step.urgency}</span>
        </div>
        {(
          [
            ['层级', step.urgencyParts.tier],
            ['下游依赖', step.urgencyParts.downstream],
            ['配置缺口', step.urgencyParts.config],
            ['证书紧迫', step.urgencyParts.cert],
            ['恢复点', step.urgencyParts.recoveryPoint],
          ] as const
        ).map(([label, val]) => (
          <div className="urg-row" key={label}>
            <span>{label}</span>
            <span className="urg-bar">
              <span style={{ width: `${Math.min(100, (val / maxUrg) * 100)}%` }} />
            </span>
            <span className="urg-val">{val}</span>
          </div>
        ))}
        <p className="timeout-note" style={{ marginTop: 2 }}>
          权重由服务层级、下游依赖数、配置漂移、证书剩余有效期与恢复点新旧合成；证书已过期与恢复点过旧的步骤会被前移。
        </p>
      </div>

      <div className={`timeout-box${injected ? ' injected' : ''}`}>
        <div className="timeout-head">
          <Clock size={13} />
          注入超时
          {injected && <span className="badge critical">生效中</span>}
        </div>
        <div className="timeout-row">
          <label className="timeout-input" htmlFor={`timeout-${step.id}`}>
            <input
              id={`timeout-${step.id}`}
              type="number"
              min={1}
              max={step.durationMin - 1}
              value={timeout ?? ''}
              placeholder={String(step.durationMin)}
              onChange={(e) => {
                const v = e.target.value.trim();
                if (v === '') onTimeoutChange(undefined);
                else {
                  const n = Number(v);
                  if (Number.isFinite(n) && n > 0) onTimeoutChange(Math.floor(n));
                }
              }}
            />
            <span className="unit">分钟</span>
          </label>
          <button
            className="btn small ghost"
            onClick={() => onTimeoutChange(undefined)}
            disabled={timeout === undefined}
          >
            清除
          </button>
        </div>
        <div className="preset-row">
          {[1, 2, Math.max(1, Math.floor(step.durationMin / 2)), step.durationMin - 1]
            .filter((v, i, a) => v >= 1 && v < step.durationMin && a.indexOf(v) === i)
            .map((v) => (
              <button key={v} className="preset" onClick={() => onTimeoutChange(v)}>
                {v}′
              </button>
            ))}
        </div>
        <p className="timeout-note">
          {injected ? (
            <>
              该步骤将在 T+{step.start + timeout!}′ 被中止。
              <strong> 依赖它的下游步骤不会恢复</strong>，会被归入「必须等待」
              {wouldBlock.length > 0 && <>（影响 {wouldBlock.map((s) => s.name).join('、')}）</>}。
              其余分支不受影响。
            </>
          ) : (
            <>小于 {step.durationMin} 分钟才会生效；超时步骤视为未完成，且会阻塞所有下游。</>
          )}
        </p>
      </div>

      <div className="kv">
        <dt>副作用</dt>
        <dd style={{ fontSize: 12 }}>
          {effect ? (
            effect.reused ? (
              <span className="badge carried">已执行，本次沿用</span>
            ) : effect.state === 'applied' ? (
              <span className="badge accent">本次演练将写入台账</span>
            ) : effect.state === 'missed' ? (
              <span className="badge critical">超时未执行</span>
            ) : (
              <span className="badge neutral">被阻塞</span>
            )
          ) : (
            <span className="muted">无持久副作用（仅演练沙箱操作）</span>
          )}
        </dd>
      </div>

      {selectedService && downstreamServices.length > 0 && (
        <div className="kv">
          <dt>直接下游</dt>
          <dd style={{ fontSize: 11.5 }}>
            <div className="dep-chips">
              {downstreamServices.map((s) => (
                <button
                  key={s.id}
                  className="dep-chip"
                  onClick={() => onSelectService(s.id)}
                >
                  {s.name}
                </button>
              ))}
            </div>
          </dd>
        </div>
      )}
    </div>
  );
}

function TEXTIER(t: 1 | 2 | 3): string {
  return TIER_TEXT[t];
}

function downstreamCountServices(id: string): { id: string; name: string }[] {
  const direct = scenario.services.filter((s) => s.deps.includes(id));
  const seen = new Map<string, string>();
  const stack = [...direct];
  while (stack.length) {
    const s = stack.pop()!;
    if (seen.has(s.id)) continue;
    seen.set(s.id, s.name);
    stack.push(...scenario.services.filter((x) => x.deps.includes(s.id)));
  }
  return [...seen.entries()].map(([sid, name]) => ({ id: sid, name }));
}

export function OutcomeColumn({
  tone,
  title,
  states,
  outcomes,
  onSelect,
  empty,
}: {
  tone: 'ok' | 'wait' | 'bad';
  title: string;
  states: ServiceOutcome['state'][];
  outcomes: ServiceOutcome[];
  onSelect: (id: string) => void;
  empty: string;
}) {
  const items = outcomes.filter((o) => states.includes(o.state));
  return (
    <div className={`outcome-col ${tone}`}>
      <div className="outcome-col-head">
        <span className="dot" />
        {title}
        <span className="count">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <div className="outcome-empty">{empty}</div>
      ) : (
        <div className="outcome-list">
          {items.map((o) => (
            <button key={o.id} className="outcome-item" onClick={() => onSelect(o.id)}>
              <span className="oi-name">
                {o.name}
                <span className="badge neutral" style={{ height: 16, fontSize: 9.5 }}>
                  {TIER_TEXT[o.tier]}
                </span>
                {o.state === 'degraded' && <span className="badge warn">降级</span>}
              </span>
              <span className="oi-when">
                {o.restoredAtMin === null ? STATE_TEXT[o.state] : fmtMin(o.restoredAtMin)}
              </span>
              <span className="oi-why">
                {o.state === 'waiting' || o.state === 'failed'
                  ? o.reasons.slice(0, 2).join(' · ')
                  : o.risks[0] ?? o.reasons[0] ?? ''}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function CostList({ items, tone = 'plain' }: { items: string[]; tone?: 'plain' | 'gain' }) {
  return (
    <ul className={`cost-list${tone === 'gain' ? ' gain' : ''}`}>
      {items.map((c) => (
        <li key={c}>{c}</li>
      ))}
    </ul>
  );
}

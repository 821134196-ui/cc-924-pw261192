import { Fragment, useCallback, useMemo, useState } from 'react';
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Clock,
  Database,
  Gauge,
  History,
  ListTree,
  Moon,
  Play,
  RotateCcw,
  ShieldCheck,
  Sun,
  TriangleAlert,
  Undo2,
} from 'lucide-react';
import { AvailabilityChart } from './components/AvailabilityChart';
import { DecisionDialog } from './components/DecisionDialog';
import { Timeline, laneList } from './components/Timeline';
import {
  Badge,
  CostList,
  Meter,
  OutcomeColumn,
  PathBadges,
  StepInspector,
} from './components/Panels';
import { useWorkspace } from './hooks/useWorkspace';
import { useMeasure, useTheme } from './hooks/useMeasure';
import { ensureTargets } from './domain/targets';
import { scenario, plans, serviceById } from './domain/scenario';
import { simulate, certMinutesLeft } from './domain/simulate';
import { buildTradeoff, breachList } from './domain/tradeoff';
import {
  acceptDecision,
  effectSummary,
  executeRun,
} from './domain/execution';
import type {
  EffectEntry,
  ExecutedRun,
  PathAssessment,
  PathId,
  RunResult,
} from './domain/types';
import {
  KIND_TEXT,
  PATH_TEXT,
  STATE_TEXT,
  TIER_TEXT,
  fmtDateTime,
  fmtMin,
  shortSig,
} from './lib/format';

type Tab = 'services' | 'execution' | 'ledger' | 'decisions';

export default function App() {
  const { workspace, setWorkspace, reset, storageError } = useWorkspace();
  const [theme, setTheme] = useTheme();
  const [targetsRaw, setTargetsRaw] = useState({ rto: 40, rpo: 6 });
  const [preferred, setPreferred] = useState<PathId>('latency');
  const [timeouts, setTimeouts] = useState<Record<string, number>>({});
  const [selectedStep, setSelectedStep] = useState<string | null>(null);
  const [selectedService, setSelectedService] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('services');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [expandedService, setExpandedService] = useState<string | null>(null);
  const [chartRef, chartWidth] = useMeasure<HTMLDivElement>();
  const [tlRef, tlWidth] = useMeasure<HTMLDivElement>();

  const targets = ensureTargets(targetsRaw);

  const tradeoff = useMemo(
    () => buildTradeoff(targets, timeouts, workspace.ledger.effects),
    [targets, timeouts, workspace.ledger.effects],
  );

  const activeRun = useMemo(() => {
    const plan = plans.find((p) => p.id === preferred)!;
    return simulate({ plan, targets, timeouts, appliedEffects: workspace.ledger.effects });
  }, [preferred, targets, timeouts, workspace.ledger.effects]);

  const archived = workspace.archive[activeRun.signature] as ExecutedRun | undefined;
  const activeAssessment = tradeoff.paths.find((p) => p.plan.id === preferred)!;
  const activeStep =
    activeRun.steps.find((s) => s.id === selectedStep) ?? null;
  const activeEffect = activeRun.effectIntents.find((e) => e.stepId === selectedStep);
  const lanes = useMemo(() => laneList(activeRun), [activeRun]);

  const summary = effectSummary(workspace);

  const runCommit = useCallback(
    (pathId: PathId) => {
      const plan = plans.find((p) => p.id === pathId)!;
      const run = simulate({
        plan,
        targets,
        timeouts,
        appliedEffects: workspace.ledger.effects,
      });
      const breaches = breachList(run);
      const result = executeRun({
        workspace,
        run,
        scenario,
        pathName: plan.name,
        breaches,
      });
      const sessionTimeouts = Object.keys(timeouts);
      setWorkspace(result.workspace);
      setPreferred(pathId);
      if (!result.replayed && sessionTimeouts.length === 0) {
        // Keep the operator on the same view; the timeline now reflects the run.
      }
      return result.executed;
    },
    [targets, timeouts, workspace, setWorkspace],
  );

  const requestDecision = useCallback(() => {
    const preview = simulate({
      plan: plans.find((p) => p.id === preferred)!,
      targets,
      timeouts,
      appliedEffects: workspace.ledger.effects,
    });
    const breaches = breachList(preview);
    if (breaches.length === 0) {
      runCommit(preferred);
      return;
    }
    setDialogOpen(true);
  }, [preferred, targets, timeouts, workspace, runCommit]);

  const confirmFromDialog = useCallback(
    (pathId: PathId) => {
      const executed = runCommit(pathId);
      const preexisting = workspace.archive[executed.signature];
      if (!preexisting?.decision) {
        const plan = plans.find((p) => p.id === pathId)!;
        const run = simulate({
          plan,
          targets,
          timeouts,
          appliedEffects: workspace.ledger.effects,
        });
        const breaches = breachList(run);
        const current = executed;
        setWorkspace((ws) =>
          acceptDecision(
            ws,
            current,
            breaches,
            scenario,
          ),
        );
      }
      setDialogOpen(false);
      setTab('services');
    },
    [runCommit, workspace.archive, targets, timeouts, workspace, setWorkspace],
  );

  const selectedOutcome = activeRun.outcomes.find((o) => o.id === selectedService) ?? null;

  const openStep = (stepId: string, serviceId: string) => {
    setSelectedStep(stepId);
    setSelectedService(serviceId);
  };

  const openService = (id: string) => {
    setSelectedService(id);
    setSelectedStep(`${id}:verify`);
  };

  const breachState = breachList(activeRun);

  return (
    <>
      <div className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <div className="brand-mark">
              <ShieldCheck size={16} />
            </div>
            <div>
              <div className="brand-name">Drillbench</div>
              <div className="brand-sub">容灾演练台</div>
            </div>
          </div>
          <div className="top-scenario">
            <span className="scenario-name">{scenario.name}</span>
            <span className="top-divider" />
            <span>{scenario.site}</span>
            <span className="top-divider" />
            <span className="clock">
              <Clock size={11} /> 演练时钟 {scenario.drillAt.slice(11, 16)} 起
            </span>
          </div>
          <div className="top-actions">
            <span className="badge neutral mono" title="已落账副作用数 / 批次">
              {summary.total} 项 · {summary.batches} 批
            </span>
            <button
              className="btn ghost small"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label="切换明暗主题"
              title="切换主题"
            >
              {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
            </button>
            <button
              className="btn ghost small"
              onClick={() => {
                if (
                  window.confirm(
                    '清空本地演练记录？台账与已执行步骤都会丢失，再次演练会重新产生副作用。',
                  )
                ) {
                  reset();
                  setTimeouts({});
                  setSelectedStep(null);
                  setSelectedService(null);
                }
              }}
              title="清空本地台账"
            >
              <RotateCcw size={13} /> 重置
            </button>
          </div>
        </div>
      </div>

      <main className="shell">
        {storageError && (
          <div className="notice warn" style={{ marginTop: 16 }}>
            <CircleAlert size={15} className="icon" />
            <div className="notice-body">{storageError}</div>
          </div>
        )}

        <section className="board" aria-labelledby="board-title">
          <div className="board-head">
            <div>
              <div className="eyebrow">
                <span className="num">01</span> 目标与路径
              </div>
              <h1 className="section-title" id="board-title" style={{ fontSize: 18 }}>
                {scenario.event}
              </h1>
            </div>
            <div className="targets">
              <div className="target-field">
                <label htmlFor="rto-target">恢复时间目标 RTO</label>
                <div className="target-input">
                  <input
                    id="rto-target"
                    type="number"
                    min={5}
                    max={180}
                    value={targetsRaw.rto}
                    onChange={(e) =>
                      setTargetsRaw((t) => ({ ...t, rto: Number(e.target.value) }))
                    }
                  />
                  <span className="unit">分钟</span>
                </div>
              </div>
              <div className="target-field">
                <label htmlFor="rpo-target">允许数据丢失 RPO</label>
                <div className="target-input">
                  <input
                    id="rpo-target"
                    type="number"
                    min={1}
                    max={120}
                    value={targetsRaw.rpo}
                    onChange={(e) =>
                      setTargetsRaw((t) => ({ ...t, rpo: Number(e.target.value) }))
                    }
                  />
                  <span className="unit">分钟</span>
                </div>
              </div>
              <button
                className="btn"
                onClick={requestDecision}
                title="按当前选择执行演练；若目标不能同时满足会先要求确认代价"
              >
                <Play size={13} /> 执行演练
              </button>
            </div>
          </div>

          <div className={`verdict ${tradeoff.allCompliant ? 'ok' : 'tight'}`}>
            <div className="verdict-icon">
              {tradeoff.allCompliant ? <CircleCheck size={16} /> : <TriangleAlert size={16} />}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="verdict-headline">{tradeoff.headline}</div>
              <div className="verdict-sub">{tradeoff.recommendation}</div>
            </div>
            <div className="verdict-side">
              <span className="small muted">
                {tradeoff.paths.filter((p) => p.bothOk).length}/2 条路径同时达标
              </span>
              <button className="btn small" onClick={() => setDialogOpen(true)}>
                查看代价对比
              </button>
            </div>
          </div>

          <div className="paths">
            {tradeoff.paths.map((p) => (
              <PathCard
                key={p.plan.id}
                path={p}
                selected={preferred === p.plan.id}
                archived={workspace.archive[p.run.signature]}
                onSelect={() => setPreferred(p.plan.id)}
                onRun={() => {
                  setPreferred(p.plan.id);
                  const breaches = breachList(p.run);
                  if (breaches.length === 0) runCommit(p.plan.id);
                  else setDialogOpen(true);
                }}
              />
            ))}
          </div>

          <div className="panel chart-panel">
            <div className="chart-head">
              <span className="chart-title">核心服务可用数量</span>
              <span className="small muted">以演练时钟为 0，台阶处为业务验证通过</span>
              <div className="chart-legend">
                {tradeoff.paths.map((p, i) => (
                  <span className="legend-item" key={p.plan.id}>
                    <span
                      className="legend-key"
                      style={{ background: i === 0 ? 'var(--series-1)' : 'var(--series-2)' }}
                    />
                    {p.plan.name}
                    <span className="mono" style={{ color: 'var(--ink-3)', fontSize: 10.5 }}>
                      {p.rtoMin === null ? '未全恢' : `RTO ${p.rtoMin}′`}
                    </span>
                  </span>
                ))}
                <span className="legend-item">
                  <span className="legend-key dashed" />
                  目标 {targets.rto}′
                </span>
              </div>
            </div>
            <div className="chart-outer" ref={chartRef}>
              {chartWidth > 0 && (
                <AvailabilityChart
                  paths={tradeoff.paths}
                  rtoTarget={targets.rto}
                  width={chartWidth}
                />
              )}
            </div>
            <details className="table-view">
              <summary>数据表</summary>
              <table className="mini-table">
                <thead>
                  <tr>
                    <th>路径</th>
                    <th>RTO</th>
                    <th>RPO</th>
                    <th>核心服务可用</th>
                    <th>总耗时</th>
                    <th>必须等待</th>
                  </tr>
                </thead>
                <tbody>
                  {tradeoff.paths.map((p) => (
                    <tr key={p.plan.id}>
                      <td>{p.plan.name}</td>
                      <td>{p.rtoMin === null ? '不可用' : `${p.rtoMin}′`}</td>
                      <td>{p.rpoMin === null ? '—' : `${p.rpoMin}′`}</td>
                      <td>
                        {p.run.criticalAvailable}/{p.run.criticalTotal}
                      </td>
                      <td>{p.run.makespanMin}′</td>
                      <td>{p.run.waitingCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </div>
        </section>

        <section className="workbench" aria-labelledby="workbench-title">
          <div className="panel timeline-panel">
            <div className="timeline-head">
              <div>
                <div className="eyebrow">
                  <span className="num">02</span> 执行时序
                </div>
                <h2 className="section-title" id="workbench-title">
                  {PATH_TEXT[preferred]} · {timeouts && Object.keys(timeouts).length > 0 ? '注入超时后' : '计划推演'}
                </h2>
              </div>
              <div className="timeline-actions">
                {archived ? (
                  <span className="badge carried">
                    <ShieldCheck size={11} /> 已执行 {archived.requestId}
                  </span>
                ) : (
                  <span className="badge neutral">推演中 · 未落账</span>
                )}
                <button className="btn small" onClick={requestDecision}>
                  <Play size={12} /> 执行本次推演
                </button>
                {Object.keys(timeouts).length > 0 && (
                  <button
                    className="btn small ghost"
                    onClick={() => {
                      setTimeouts({});
                      setSelectedStep(null);
                    }}
                  >
                    <Undo2 size={12} /> 清除全部超时
                  </button>
                )}
              </div>
            </div>

            <div className="legend-row" style={{ marginBottom: 10 }}>
              <span>
                <span className="legend-swatch" style={{ background: 'var(--series-1)' }} />
                计划步骤
              </span>
              <span>
                <span className="legend-swatch" style={{ background: 'var(--critical)' }} />
                超时中止
              </span>
              <span>
                <span
                  className="legend-swatch"
                  style={{ background: 'var(--carried)' }}
                />
                沿用已执行
              </span>
              <span>
                <span className="legend-swatch" style={{ border: '1px dashed var(--baseline)' }} />
                必须等待 · 未排入
              </span>
            </div>

            {breachState.length > 0 && (
              <div className="notice critical" style={{ marginBottom: 12 }}>
                <CircleAlert size={15} className="icon" />
                <div className="notice-body">
                  <strong>当前路径未达标：</strong>
                  {breachState.join('；')}。
                  {activeRun.waitingCount > 0 && (
                    <> {activeRun.waitingCount} 个服务必须等待上游恢复。</>
                  )}
                </div>
              </div>
            )}

            <div ref={tlRef}>
              {tlWidth > 0 && (
                <Timeline
                  run={activeRun}
                  lanes={lanes}
                  selected={selectedStep}
                  onSelect={openStep}
                  width={tlWidth}
                />
              )}
            </div>

            <div className="tl-footnote">
              <span>
                <Database size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
                通道并行：恢复 {plans.find((p) => p.id === preferred)!.restoreLanes} 条 · 配置{' '}
                {plans.find((p) => p.id === preferred)!.configLanes} 条 · 证书 1 条
              </span>
              <span>总计划耗时 {activeRun.makespanMin}′</span>
              <span>核心可恢复 {activeRun.criticalAvailable}/{activeRun.criticalTotal}</span>
              <span className="mono">{shortSig(activeRun.signature)}</span>
            </div>

            {activeRun.outcomes.some((o) => o.blockedBy.length > 0) && (
              <div className="blocked-strip">
                <span className="small muted" style={{ display: 'inline-flex', gap: 6 }}>
                  <ListTree size={12} /> 等待链
                </span>
                <div className="chips">
                  {activeRun.outcomes
                    .filter((o) => o.blockedBy.length > 0)
                    .map((o) => (
                      <span className="blocked-chip" key={o.id}>
                        {o.name}
                        <ArrowRight size={10} style={{ opacity: 0.6 }} />
                        {o.blockedBy.map((b) => serviceById[b].name).join('、')}
                      </span>
                    ))}
                </div>
              </div>
            )}
          </div>

          <aside className="panel inspector" aria-label="步骤检查器">
            <StepInspector
              step={activeStep}
              run={activeRun}
              timeout={selectedStep ? timeouts[selectedStep] : undefined}
              onTimeoutChange={(value) => {
                if (!selectedStep) return;
                setTimeouts((t) => {
                  const next = { ...t };
                  if (value === undefined) delete next[selectedStep!];
                  else next[selectedStep!] = value;
                  return next;
                });
              }}
              selectedService={selectedService}
              onSelectService={openService}
              effect={activeEffect}
            />
          </aside>
        </section>

        <section className="panel outcomes" aria-labelledby="outcomes-title">
          <div className="outcome-head">
            <div>
              <div className="eyebrow">
                <span className="num">03</span> 恢复判定
              </div>
              <h2 className="section-title" id="outcomes-title">
                哪些服务能恢复，哪些必须等待
              </h2>
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Badge tone="good">
                <CircleCheck size={11} /> 可恢复 {activeRun.restoredCount}
              </Badge>
              <Badge tone="warn">
                <CircleCheck size={11} /> 降级 {activeRun.degradedCount}
              </Badge>
              <Badge tone="critical">
                <CircleAlert size={11} /> 必须等待 {activeRun.waitingCount}
              </Badge>
              {activeRun.failedCount > 0 && (
                <Badge tone="critical">不可用 {activeRun.failedCount}</Badge>
              )}
            </div>
          </div>

          <div className="outcome-grid">
            <OutcomeColumn
              tone="ok"
              title="可恢复 / 降级可用"
              states={['restored', 'degraded']}
              outcomes={activeRun.outcomes}
              onSelect={openService}
              empty="没有服务恢复"
            />
            <OutcomeColumn
              tone="wait"
              title="必须等待（上游未就绪）"
              states={['waiting']}
              outcomes={activeRun.outcomes}
              onSelect={openService}
              empty="所有服务的上游都已就绪"
            />
            <OutcomeColumn
              tone="bad"
              title="不可用（自身链路失败）"
              states={['failed']}
              outcomes={activeRun.outcomes}
              onSelect={openService}
              empty="没有服务失败"
            />
          </div>

          {selectedOutcome && (
            <div className="notice accent" style={{ marginTop: 12 }}>
              <ListTree size={15} className="icon" />
              <div className="notice-body">
                <strong>{selectedOutcome.name}</strong>
                <span style={{ marginLeft: 8 }} className="badge neutral">
                  {STATE_TEXT[selectedOutcome.state]}
                </span>
                <div className="small" style={{ marginTop: 3 }}>
                  {selectedOutcome.reasons.join('；') || '—'}
                  {selectedOutcome.risks.length > 0 && (
                    <span style={{ color: 'var(--serious)' }}>
                      {' '}
                      · 风险：{selectedOutcome.risks.join('；')}
                    </span>
                  )}
                </div>
              </div>
              <button className="icon-btn" onClick={() => setSelectedService(null)} aria-label="关闭">
                ×
              </button>
            </div>
          )}

          <div className="outcome-foot">
            「必须等待」的服务本身没有报错，只是上游未通过验证，因此不排入恢复；清除超时或改用另一条路径后会自动重新评估。
          </div>
        </section>

        <section className="panel lower">
          <div className="tabbar" role="tablist" aria-label="详情">
            {(
              [
                ['services', '服务明细', ListTree, activeRun.outcomes.length],
                ['execution', '执行记录', History, workspace.requests.length],
                ['ledger', '副作用台账', Database, summary.total],
                ['decisions', '操作者确认', ShieldCheck, workspace.decisions.length],
              ] as const
            ).map(([id, label, Icon, count]) => (
              <button
                key={id}
                className="tab"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
              >
                <Icon size={13} />
                {label}
                <span className="tab-count">{count}</span>
              </button>
            ))}
          </div>
          <div className="tab-body">
            {tab === 'services' && (
              <ServiceTable
                run={activeRun}
                expanded={expandedService}
                onExpand={(id) => setExpandedService(expandedService === id ? null : id)}
                onOpenStep={openStep}
              />
            )}
            {tab === 'execution' && (
              <ExecutionTab
                workspace={workspace}
                onOpen={(sig) => {
                  const e = workspace.archive[sig];
                  if (e) {
                    setPreferred(e.planId);
                    setTab('services');
                  }
                }}
              />
            )}
            {tab === 'ledger' && <LedgerTab workspace={workspace} />}
            {tab === 'decisions' && <DecisionsTab workspace={workspace} />}
          </div>
        </section>

        <footer className="page-foot">
          <Gauge size={12} />
          <span>
            场景 {scenario.version} · 演练时钟 {fmtDateTime(scenario.drillAt)}
          </span>
          <span className="sig">{shortSig(activeRun.signature)}</span>
          <span>·</span>
          <span>
            调度综合考虑服务依赖、配置漂移、证书有效期与恢复点新旧；副作用按台账去重。
          </span>
        </footer>
      </main>

      <DecisionDialog
        open={dialogOpen}
        tradeoff={tradeoff}
        preferred={activeAssessment}
        onChoose={(id) => setPreferred(id)}
        onConfirm={confirmFromDialog}
        onClose={() => setDialogOpen(false)}
      />
    </>
  );
}

function PathCard({
  path: p,
  selected,
  archived,
  onSelect,
  onRun,
}: {
  path: PathAssessment;
  selected: boolean;
  archived: ExecutedRun | undefined;
  onSelect: () => void;
  onRun: () => void;
}) {
  const max = Math.max(p.rtoMin ?? 0, p.rpoMin ?? 0, p.run.targets.rto, p.run.targets.rpo) * 1.25;
  return (
    <article
      className={`path-card${selected ? ' selected' : ''}`}
      onClick={onSelect}
      aria-selected={selected}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="path-top">
        <span className="path-radio" aria-hidden="true" />
        <div style={{ flex: 1 }}>
          <div className="path-name">
            {p.plan.name}
            {archived && <Badge tone="carried">已执行</Badge>}
          </div>
          <div className="path-tagline">{p.plan.tagline}</div>
        </div>
      </div>

      <div className="path-badges">
        <PathBadges path={p} />
      </div>

      <div style={{ display: 'grid', gap: 12 }}>
        <Meter
          label="RTO 恢复时间"
          value={p.rtoMin}
          target={p.run.targets.rto}
          over={!p.rtoOk}
          max={max}
          format={(n) => (n === null ? '未全恢' : `${Math.round(n)}′`)}
        />
        <Meter
          label="RPO 数据丢失"
          value={p.rpoMin}
          target={p.run.targets.rpo}
          over={!p.rpoOk}
          max={max}
          format={(n) => (n === null ? '—' : `${Math.round(n)}′`)}
        />
      </div>

      <div className="path-meta">
        <div className="kv">
          <dt>恢复点</dt>
          <dd>{p.plan.snapshotPolicy === 'local' ? '本地快照' : '备份库 + 归档日志'}</dd>
        </div>
        <div className="kv">
          <dt>配置范围</dt>
          <dd>{p.plan.configScope === 'all' ? '全量服务' : '仅核心服务'}</dd>
        </div>
        <div className="kv">
          <dt>证书窗口</dt>
          <dd>{p.plan.certWindowMin <= 150 ? '48 小时' : '30 天'}</dd>
        </div>
        <div className="kv">
          <dt>准备步骤</dt>
          <dd>
            {p.configServices.length} 配置 · {p.certServices.length} 证书 ·{' '}
            {p.scanServiceCount} 校验
          </dd>
        </div>
      </div>

      <div>
        <div className="path-section-label" style={{ marginBottom: 6 }}>
          要付出的代价
        </div>
        <CostList items={p.costs} tone="plain" />
      </div>

      <div>
        <div className="path-section-label" style={{ marginBottom: 6 }}>
          能换来什么
        </div>
        <CostList items={p.gains} tone="gain" />
      </div>

      <div className="path-foot">
        <button className="btn small path-choice" onClick={(e) => { e.stopPropagation(); onRun(); }}>
          <Play size={12} /> 按此路径演练
        </button>
        {p.run.waitingCount > 0 && (
          <span className="small muted">{p.run.waitingCount} 个服务将等待</span>
        )}
      </div>
    </article>
  );
}

function ServiceTable({
  run,
  expanded,
  onExpand,
  onOpenStep,
}: {
  run: RunResult;
  expanded: string | null;
  onExpand: (id: string) => void;
  onOpenStep: (stepId: string, serviceId: string) => void;
}) {
  return (
    <table className="detail-table">
      <thead>
        <tr>
          <th style={{ width: 26 }} />
          <th>服务</th>
          <th>层级</th>
          <th>状态</th>
          <th>可用时间</th>
          <th>数据丢失</th>
          <th>证书剩余</th>
          <th>准备步骤</th>
        </tr>
      </thead>
      <tbody>
        {run.outcomes.map((o) => {
          const svc = serviceById[o.id];
          const certLeft = certMinutesLeft(o.id);
          const open = expanded === o.id;
          const steps = run.steps.filter((s) => s.serviceId === o.id);
          return (
            <Fragment key={o.id}>
              <tr className={`row${open ? ' open' : ''}`}>
                <td>
                  <button
                    className="expand-btn"
                    onClick={() => onExpand(o.id)}
                    aria-label={open ? '收起' : '展开'}
                    aria-expanded={open}
                  >
                    {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </button>
                </td>
                <td>
                  <div className="svc-name">
                    {o.name}
                    {o.carriedPrep.length > 0 && (
                      <span className="badge carried" style={{ height: 16, fontSize: 9 }}>
                        沿用 {o.carriedPrep.length}
                      </span>
                    )}
                  </div>
                  <div className="svc-id">{svc.id}</div>
                </td>
                <td>{TIER_TEXT[o.tier]}</td>
                <td>
                  <Badge
                    tone={
                      o.state === 'restored'
                        ? 'good'
                        : o.state === 'degraded'
                          ? 'warn'
                          : o.state === 'waiting'
                            ? 'critical'
                            : 'critical'
                    }
                  >
                    {STATE_TEXT[o.state]}
                  </Badge>
                </td>
                <td className="num">{o.restoredAtMin === null ? '—' : `T+${o.restoredAtMin}′`}</td>
                <td className="num">{o.dataLossMin}′</td>
                <td className="num">
                  {certLeft <= 0 ? (
                    <span style={{ color: 'var(--critical)' }}>已过期</span>
                  ) : (
                    `${Math.round(certLeft / 60)} h`
                  )}
                </td>
                <td className="num">{steps.length}</td>
              </tr>
              {open && (
                <tr className="detail-row">
                  <td colSpan={8}>
                    <div className="detail-inner">
                      <div className="detail-block">
                        <h4>判定依据</h4>
                        <ul>
                          {o.reasons.map((r, i) => (
                            <li key={i}>{r}</li>
                          ))}
                          {o.reasons.length === 0 && <li className="none">—</li>}
                        </ul>
                      </div>
                      <div className="detail-block">
                        <h4>遗留风险</h4>
                        {o.risks.length ? (
                          <ul>
                            {o.risks.map((r, i) => (
                              <li key={i} style={{ color: 'var(--serious)' }}>
                                {r}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <div className="none">无</div>
                        )}
                        {o.carriedPrep.length > 0 && (
                          <>
                            <h4 style={{ marginTop: 10 }}>沿用的准备</h4>
                            <ul>
                              {o.carriedPrep.map((c, i) => (
                                <li key={i}>{c}</li>
                              ))}
                            </ul>
                          </>
                        )}
                      </div>
                      <div className="detail-block">
                        <h4>依赖链</h4>
                        <div className="dep-line">
                          上游：
                          {o.upstream.length === 0 ? (
                            <span className="muted">无</span>
                          ) : (
                            o.upstream.map((d) => serviceById[d].name).join('、')
                          )}
                        </div>
                        {o.blockedBy.length > 0 && (
                          <div className="dep-line">
                            等待：{o.blockedBy.map((d) => serviceById[d].name).join('、')}
                          </div>
                        )}
                        {o.failedStep && (
                          <div className="dep-line">
                            失败步骤：
                            <span className="mono">{o.failedStep}</span>
                          </div>
                        )}
                        <div className="dep-line" style={{ marginTop: 8 }}>
                          <h4>步骤</h4>
                          <ul>
                            {steps.map((s) => (
                              <li key={s.id} style={{ listStyle: 'none', marginLeft: -14 }}>
                                <button
                                  className="btn small ghost"
                                  style={{ height: 22, padding: '0 6px' }}
                                  onClick={() => onOpenStep(s.id, s.serviceId)}
                                >
                                  {KIND_TEXT[s.kind]}
                                  <span className="mono muted" style={{ fontSize: 10 }}>
                                    {s.status === 'done' ? `T+${s.end}` : s.status}
                                  </span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function ExecutionTab({
  workspace,
  onOpen,
}: {
  workspace: ReturnType<typeof useWorkspace>['workspace'];
  onOpen: (signature: string) => void;
}) {
  if (workspace.requests.length === 0) {
    return (
      <div className="empty-state">
        还没有执行记录。点击「执行演练」后，这里会按批次记录每一次请求：
        <br />
        相同签名只回放，不重复产生副作用；改变超时或目标会生成新请求，但已落账的步骤会被沿用。
      </div>
    );
  }
  return (
    <div className="req-list">
      {workspace.requests.map((r) => (
        <div className="req-item" key={r.requestId}>
          <div className="req-top">
            <span className="req-id">{r.requestId}</span>
            <Badge tone="neutral">{PATH_TEXT[r.pathId]}</Badge>
            <span className="req-sig">{shortSig(r.signature)}</span>
            <span className="req-sig">批次 {r.batchId}</span>
            {r.replays > 0 && <Badge tone="accent">回放 {r.replays} 次</Badge>}
            {r.breached ? (
              <Badge tone="critical">突破目标</Badge>
            ) : (
              <Badge tone="good">达标</Badge>
            )}
            <button
              className="btn small ghost"
              style={{ marginLeft: 'auto' }}
              onClick={() => onOpen(r.signature)}
            >
              查看时序 <ArrowRight size={11} />
            </button>
          </div>
          <div className="req-stats">
            <span>
              新增副作用 <b>{r.newEffects}</b>
            </span>
            <span>
              沿用 <b>{r.reusedEffects}</b>
            </span>
            <span>
              沿用步骤 <b>{r.carriedSteps}</b>
            </span>
            <span>
              超时 <b>{r.timedOutSteps}</b>
            </span>
            <span>
              RTO <b>{r.rtoMin === null ? '未达标' : `${r.rtoMin}′`}</b>
            </span>
            <span>
              RPO <b>{r.rpoMin === null ? '—' : `${r.rpoMin}′`}</b>
            </span>
            <span>
              总耗时 <b>{r.makespanMin}′</b>
            </span>
            <span className="muted">{fmtDateTime(r.createdAt)}</span>
          </div>
          {r.breaches.length > 0 && (
            <div className="req-breach">
              <CircleAlert size={11} style={{ marginTop: 2 }} />
              {r.breaches.join('；')}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function LedgerTab({ workspace }: { workspace: ReturnType<typeof useWorkspace>['workspace'] }) {
  const effects = Object.values(workspace.ledger.effects);
  if (effects.length === 0) {
    return (
      <div className="empty-state">
        台账为空。配置下发与证书续期是持久副作用，只会在首次执行时写入一次；
        之后无论重跑多少次同一请求，还是换一条路径，都不会再写第二次。
      </div>
    );
  }
  const groups = new Map<string, EffectEntry[]>();
  for (const e of effects) {
    const arr = groups.get(e.batchId) ?? [];
    arr.push(e);
    groups.set(e.batchId, arr);
  }
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="subhead">
        共 {effects.length} 项副作用 · {groups.size} 个批次
        <span className="muted">（每项只落账一次）</span>
      </div>
      <table className="effect-table">
        <thead>
          <tr>
            <th>副作用</th>
            <th>服务</th>
            <th>类型</th>
            <th>批次</th>
            <th>请求</th>
            <th>落账时间</th>
          </tr>
        </thead>
        <tbody>
          {effects
            .sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key))
            .map((e) => (
              <tr key={e.key}>
                <td>
                  <div style={{ color: 'var(--ink)' }}>{e.label}</div>
                  <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>
                    {e.key}
                  </div>
                </td>
                <td>{serviceById[e.serviceId]?.name ?? e.serviceId}</td>
                <td>
                  <span className="effect-kind">
                    <span
                      className="ek-dot"
                      style={{
                        background:
                          e.kind === 'config' ? 'var(--series-1)' : 'var(--series-4)',
                      }}
                    />
                    {e.kind === 'config' ? '配置' : '证书'}
                  </span>
                </td>
                <td className="mono">{e.batchId}</td>
                <td className="mono">{e.requestId}</td>
                <td className="mono">{fmtDateTime(e.at)}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

function DecisionsTab({ workspace }: { workspace: ReturnType<typeof useWorkspace>['workspace'] }) {
  if (workspace.decisions.length === 0) {
    return (
      <div className="empty-state">
        还没有操作者确认记录。当两条路径都无法同时满足 RTO 与 RPO
        时，执行前会要求勾选确认，确认内容会记录在这里。
      </div>
    );
  }
  return (
    <div className="decision-list">
      {workspace.decisions.map((d) => (
        <div className="decision-item" key={`${d.requestId}-${d.acceptedAt}`}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <ShieldCheck size={12} style={{ color: 'var(--warning)' }} />
            <span className="mono" style={{ fontSize: 11 }}>
              {d.requestId}
            </span>
            <Badge tone="neutral">{PATH_TEXT[d.pathId]}</Badge>
            <span className="muted small">{fmtDateTime(d.acceptedAt)}</span>
          </div>
          <div style={{ marginTop: 4 }}>
            目标 RTO ≤ {d.rtoTarget}′ / RPO ≤ {d.rpoTarget}′ · 实际 RTO{' '}
            {fmtMin(d.rtoActual)} / RPO {fmtMin(d.rpoActual)}
          </div>
          {d.breaches.length > 0 && (
            <ul className="cost-list critical" style={{ marginTop: 4 }}>
              {d.breaches.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

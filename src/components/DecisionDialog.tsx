import { useEffect, useMemo, useState } from 'react';
import { CircleAlert, CircleCheck, LockKeyhole, TriangleAlert } from 'lucide-react';
import type { ExecutedRun, PathAssessment, Tradeoff } from '../domain/types';
import { breachList } from '../domain/tradeoff';
import { fmtMin, PATH_TEXT } from '../lib/format';
import { Badge } from './Panels';

/**
 * The gate between "here are two paths" and "execute". When RTO and RPO cannot
 * both be met, the operator must see what each path costs and explicitly accept
 * the breach. Nothing is written to the ledger before confirmation.
 */
export function DecisionDialog({
  open,
  tradeoff,
  preferred,
  onChoose,
  onConfirm,
  onClose,
}: {
  open: boolean;
  tradeoff: Tradeoff;
  preferred: PathAssessment;
  onChoose: (id: 'latency' | 'data') => void;
  onConfirm: (pathId: 'latency' | 'data') => void;
  onClose: () => void;
}) {
  const [ack, setAck] = useState(false);
  const target = tradeoff.paths.find((p) => p.plan.id === preferred.plan.id) ?? preferred;
  const breaches = useMemo(() => breachList(target.run), [target.run]);

  useEffect(() => {
    if (!open) setAck(false);
  }, [open]);

  if (!open) return null;

  const needsAck = breaches.length > 0;

  return (
    <dialog
      className="decision"
      open
      aria-labelledby="decision-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="dlg-head">
        <div className="dlg-icon">
          <TriangleAlert size={16} />
        </div>
        <div style={{ flex: 1 }}>
          <h2 className="dlg-title" id="decision-title">
            目标无法同时满足 — 请确认代价
          </h2>
          <p className="dlg-sub">
            当前目标 RTO ≤ {tradeoff.targets.rto}′ · RPO ≤ {tradeoff.targets.rpo}
            ′。两条候选路径各有一项必须放弃，选择权在操作者。
          </p>
        </div>
      </div>

      <div className="dlg-body">
        <div className="compare-grid">
          {tradeoff.paths.map((p) => {
            const active = p.plan.id === target.plan.id;
            return (
              <div
                key={p.plan.id}
                className={`compare-card${active ? ' active' : ''}`}
                onClick={() => onChoose(p.plan.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') onChoose(p.plan.id);
                }}
              >
                <div className="compare-title">
                  <span className="path-radio" aria-hidden="true" />
                  {p.plan.name}
                  {active && <Badge tone="accent">当前选择</Badge>}
                </div>
                <div className="compare-metrics">
                  <Badge tone={p.rtoOk ? 'good' : 'critical'}>RTO {fmtMin(p.rtoMin)}</Badge>
                  <Badge tone={p.rpoOk ? 'good' : 'warn'}>RPO {fmtMin(p.rpoMin)}</Badge>
                </div>
                <div>
                  <div className="path-section-label" style={{ marginBottom: 4 }}>
                    要付出的代价
                  </div>
                  <ul className="cost-list critical">
                    {p.costs.slice(0, 3).map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <div className="path-section-label" style={{ marginBottom: 4 }}>
                    能换来什么
                  </div>
                  <ul className="cost-list gain">
                    {p.gains.slice(0, 2).map((g) => (
                      <li key={g}>{g}</li>
                    ))}
                  </ul>
                </div>
                <div className="small muted" style={{ marginTop: 2 }}>
                  {p.rtoOk ? '恢复时间守住' : `恢复时间超 ${Math.round(p.rtoOverMin)}′`}
                  {'；'}
                  {p.rpoOk ? '数据丢失守住' : `数据丢失超 ${Math.round(p.rpoOverMin)}′`}
                </div>
              </div>
            );
          })}
        </div>

        {needsAck ? (
          <div className="notice warn">
            <CircleAlert size={15} className="icon" />
            <div className="notice-body">
              <strong>「{target.plan.name}」的突破项：</strong>
              {breaches.join('；')}。
              {target.rpoBreachServices.length > 0 && (
                <>
                  {' '}
                  受影响服务：
                  {target.rpoBreachServices.map((s) => s.name).join('、')}。
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="notice good">
            <CircleCheck size={15} className="icon" />
            <div className="notice-body">
              「{target.plan.name}」可同时满足 RTO 与 RPO，确认后写入演练台账。
            </div>
          </div>
        )}

        <label className="ack">
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
            disabled={!needsAck}
          />
          <span>
            {needsAck
              ? `我已知悉「${target.plan.name}」在本次演练中无法同时满足 RTO 与 RPO，并接受上述代价。`
              : '确认以「' + target.plan.name + '」执行演练。'}
          </span>
        </label>
      </div>

      <div className="dlg-foot">
        <span className="small muted">
          <LockKeyhole size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
          确认前不会写入台账，也不会产生任何副作用
        </span>
        <span className="spacer" />
        <button className="btn ghost" onClick={onClose}>
          返回比较
        </button>
        <button
          className="btn primary"
          disabled={needsAck && !ack}
          onClick={() => onConfirm(target.plan.id)}
        >
          以「{target.plan.name}」继续
        </button>
      </div>
    </dialog>
  );
}

export function ExecutionNotice({
  executed,
  onOpenDecision,
}: {
  executed: ExecutedRun;
  onOpenDecision: () => void;
}) {
  const prior = executed.decision;
  return (
    <div className="notice accent">
      <LockKeyhole size={15} className="icon" />
      <div className="notice-body">
        已在批次 <strong className="mono">{executed.batchId}</strong> 执行「
        {PATH_TEXT[executed.planId]}」。新增副作用{' '}
        <strong>{executed.newEffectCount}</strong> 项，沿用已执行{' '}
        <strong>{executed.reusedEffectCount}</strong> 项；台账共{' '}
        <strong>{executed.effectIntents.length}</strong> 项准备步骤。
        {prior ? (
          <> 操作者已在 {prior.acceptedAt.slice(11, 16)} 确认突破项。</>
        ) : (
          <>
            {' '}
            本次结果未达标，尚未记录操作者确认。
            <button
              className="btn small ghost"
              style={{ marginLeft: 8, height: 22 }}
              onClick={onOpenDecision}
            >
              记录确认
            </button>
          </>
        )}
      </div>
    </div>
  );
}

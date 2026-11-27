import { useMemo, useRef, useState } from 'react';
import { LANE_TEXT, KIND_TEXT } from '../lib/format';
import { laneRows, niceMax, tickValues } from '../lib/layout';
import { serviceById } from '../domain/scenario';
import { certMinutesLeft } from '../domain/simulate';
import type { LaneId, PlannedStep, RunResult } from '../domain/types';

const LANE_ORDER: LaneId[] = ['config', 'pki', 'scan', 'restore', 'verify'];
const ROW_H = 27;
const LABEL_W = 92;
const AXIS_H = 26;

export function laneList(run: RunResult): LaneId[] {
  // A lane whose only steps are carried from the ledger has nothing left to plot;
  // those steps still appear in the "已执行 · 不再重复" strip below.
  const present = new Set(run.steps.filter((s) => !s.carried).map((s) => s.lane));
  return LANE_ORDER.filter((l) => present.has(l));
}

export function Timeline({
  run,
  lanes,
  selected,
  onSelect,
  width,
}: {
  run: RunResult;
  lanes: LaneId[];
  selected: string | null;
  onSelect: (stepId: string, serviceId: string) => void;
  width: number;
}) {
  const rows = useMemo(() => laneRows(run.steps), [run]);
  const [hover, setHover] = useState<{ step: PlannedStep; x: number; y: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const maxMinute = useMemo(() => niceMax(run.makespanMin + 2), [run.makespanMin]);
  const plotW = Math.max(200, width - LABEL_W);
  const carried = run.steps.filter((s) => s.carried);
  const targetLeft = (Math.min(run.targets.rto, maxMinute) / maxMinute) * plotW;

  const laneHeight = (lane: LaneId) => Math.max(1, rows[lane].length) * ROW_H + 6;
  const bodyHeight = lanes.reduce((h, l) => h + laneHeight(l), 0);

  const moveHover = (event: React.PointerEvent, step: PlannedStep) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    setHover({
      step,
      x: Math.min(Math.max(event.clientX - rect.left + 16, 8), rect.width - 246),
      y: event.clientY - rect.top + 18,
    });
  };

  return (
    <div className="timeline-grid" ref={wrapRef}>
      <div className="tl-corner" style={{ height: AXIS_H }}>
        通道
      </div>
      <div className="tl-axis" style={{ height: AXIS_H }}>
        {tickValues(maxMinute, 6).map((m, i, arr) => (
          <span
            key={m}
            className={`tl-axis-tick${i === 0 ? ' first' : i === arr.length - 1 ? ' last' : ''}`}
            style={{ left: `${(m / maxMinute) * 100}%` }}
          >
            {m}′
          </span>
        ))}
      </div>

      <div className="tl-labels" style={{ height: bodyHeight }}>
        {lanes.map((lane) => (
          <div
            key={lane}
            className="tl-label"
            style={{ height: laneHeight(lane) }}
            title={`${LANE_TEXT[lane]}：${rows[lane].length} 条并行通道`}
          >
            {LANE_TEXT[lane]}
            <span className="lane-cap">{rows[lane].length}</span>
          </div>
        ))}
      </div>

      <div
        className="tl-plot"
        style={{ height: bodyHeight, width: plotW, position: 'relative' }}
      >
        <div className="tl-target" style={{ left: targetLeft }} aria-hidden="true" />
        <span className="tl-target-label" style={{ left: targetLeft }}>
          RTO {run.targets.rto}′
        </span>        {lanes.map((lane) => (
          <div
            key={lane}
            className="tl-lane"
            style={{ height: laneHeight(lane), position: 'relative' }}
          >
            {rows[lane].map((row, ri) =>
              row.map((step) => {
                const leftPct = (step.start / maxMinute) * 100;
                const widthPct = Math.max(1.6, ((step.end - step.start) / maxMinute) * 100);
                const label =
                  step.kind === 'restore' || step.kind === 'verify'
                    ? serviceById[step.serviceId].name
                    : serviceById[step.serviceId].shortName;
                const roomPx = (widthPct / 100) * plotW;
                const labelPx = label.length * 11 + 22;
                return (
                  <button
                    key={step.id}
                    className={`tl-block${step.timedOut ? ' timed-out' : ''}${
                      selected === step.id ? ' selected' : ''
                    }`}
                    style={{
                      left: `${leftPct}%`,
                      width: `${widthPct}%`,
                      top: ri * ROW_H + 4,
                    }}
                    onClick={() => onSelect(step.id, step.serviceId)}
                    onPointerMove={(e) => moveHover(e, step)}
                    onPointerLeave={() => setHover(null)}
                    aria-label={`${serviceById[step.serviceId].name} ${KIND_TEXT[step.kind]}，T+${step.start} 到 T+${step.end} 分钟，${step.timedOut ? '超时中止' : '计划完成'}`}
                  >
                    <span className="blk-dot" />
                    {roomPx > labelPx && <span className="blk-label">{label}</span>}
                  </button>
                );
              }),
            )}
          </div>
        ))}
      </div>

      {hover && (
        <div className="tl-hover-card" style={{ left: hover.x, top: hover.y }}>
          <div className="hc-title">
            {serviceById[hover.step.serviceId].name}
            <span className="badge neutral">{KIND_TEXT[hover.step.kind]}</span>
            {hover.step.timedOut && <span className="badge critical">超时中止</span>}
          </div>
          <div className="hc-meta">
            T+{hover.step.start}′ → T+{hover.step.end}′ · 计划 {hover.step.durationMin}′
          </div>
          <div className="hc-note">{stepNote(hover.step)}</div>
        </div>
      )}

      {carried.length > 0 && (
        <div style={{ gridColumn: '1 / -1' }}>
          <div className="carried-strip">
            <span className="badge carried">已执行 · 不再重复</span>
            <div className="chips">
              {carried.map((s) => (
                <span
                  className="chip"
                  key={s.id}
                  title="台账中已有该副作用，本次演练直接沿用结果"
                >
                  {serviceById[s.serviceId].name} · {KIND_TEXT[s.kind]}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function stepNote(step: PlannedStep): string {
  if (step.timedOut) return '演练注入超时：下游服务不会恢复，将标记为「必须等待」。';
  if (step.carried) return '该副作用已在台账中，本次演练不再执行。';
  if (step.kind === 'cert') {
    const left = certMinutesLeft(step.serviceId);
    return left <= 0
      ? `证书在演练开始时已过期 ${Math.abs(Math.round(left))} 分钟，必须续期。`
      : `证书剩余 ${Math.round(left)} 分钟到期，已进入续期窗口。`;
  }
  if (step.kind === 'config') return `配置漂移需在恢复前对齐：${step.effectLabel ?? ''}。`;
  if (step.kind === 'scan') return `恢复点完整性校验 ${step.durationMin} 分钟，通过后才允许恢复。`;
  if (step.kind === 'restore') return '从恢复点拉起数据与服务进程。';
  return '业务验证：探活与关键接口校验。';
}

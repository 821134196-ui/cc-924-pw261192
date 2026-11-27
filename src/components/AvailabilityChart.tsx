import { useMemo, useRef, useState } from 'react';
import { niceMax, tickValues } from '../lib/layout';
import type { PathAssessment } from '../domain/types';

const H = 172;
const PAD = { top: 18, right: 16, bottom: 26, left: 34 };

/**
 * Core-service availability over drill time. Two paths on one shared scale — never
 * a second y-axis. Each is a single series, identified by the legend and by the
 * direct end-label, so the color is reinforcement rather than the only cue.
 */
export function AvailabilityChart({
  paths,
  rtoTarget,
  width,
}: {
  paths: PathAssessment[];
  rtoTarget: number;
  width: number;
}) {
  const [hoverMinute, setHoverMinute] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const maxMinute = useMemo(() => {
    const ends = paths.map((p) => p.run.makespanMin);
    return niceMax(Math.max(rtoTarget + 8, ...ends));
  }, [paths, rtoTarget]);

  const plotW = Math.max(200, width - PAD.left - PAD.right);
  const plotH = H - PAD.top - PAD.bottom;
  const total = paths[0]?.run.criticalTotal ?? 6;

  const x = (m: number) => PAD.left + (m / maxMinute) * plotW;
  const y = (count: number) => PAD.top + plotH - (count / total) * plotH;

  const series = paths.map((p) => {
    const core = p.run.outcomes.filter((o) => o.tier === 1);
    const pts: { minute: number; count: number }[] = [
      { minute: 0, count: 0 },
      { minute: 0.001, count: 0 },
    ];
    let running = 0;
    const events = core
      .filter((o) => o.restoredAtMin !== null)
      .map((o) => o.restoredAtMin!)
      .sort((a, b) => a - b);
    for (const m of events) {
      running += 1;
      pts.push({ minute: m, count: running });
    }
    const last = pts[pts.length - 1];
    if (last.minute < maxMinute) pts.push({ minute: maxMinute, count: running });
    return { path: p, pts, final: running };
  });

  // Step-after: availability is a state, not a slope. A diagonal segment would
  // imply services come up gradually between verify completions.
  const path2 = (pts: { minute: number; count: number }[]) =>
    pts
      .map((pt, i) => {
        const px = x(pt.minute).toFixed(2);
        const py = y(pt.count).toFixed(2);
        if (i === 0) return `M${px},${py}`;
        const prevY = y(pts[i - 1].count).toFixed(2);
        return `L${px},${prevY} L${px},${py}`;
      })
      .join(' ');

  const onMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = event.clientX - rect.left;
    const ratio = (px - PAD.left) / plotW;
    setHoverMinute(Math.round(Math.max(0, Math.min(1, ratio)) * maxMinute));
  };

  const atMinute = (pts: { minute: number; count: number }[], m: number) => {
    let c = 0;
    for (const pt of pts) {
      if (pt.minute <= m) c = pt.count;
      else break;
    }
    return c;
  };

  return (
    <div className="chart-wrap" style={{ height: H }}>
      <svg
        ref={svgRef}
        width={width}
        height={H}
        role="img"
        aria-label={`核心服务可用数量随时间变化，RTO 目标 ${rtoTarget} 分钟`}
        onPointerMove={onMove}
        onPointerLeave={() => setHoverMinute(null)}
      >
        {tickValues(total, total).map((v) => (
          <g key={v}>
            <line
              x1={PAD.left}
              x2={PAD.left + plotW}
              y1={y(v)}
              y2={y(v)}
              stroke="var(--grid)"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 8}
              y={y(v) + 3.5}
              textAnchor="end"
              fill="var(--ink-3)"
              fontSize={9.5}
              fontFamily="var(--mono)"
            >
              {v}
            </text>
          </g>
        ))}

        {tickValues(maxMinute, 6).map((m, i, arr) => (
          <text
            key={m}
            x={x(m)}
            y={H - 8}
            textAnchor={i === 0 ? 'start' : i === arr.length - 1 ? 'end' : 'middle'}
            fill="var(--ink-3)"
            fontSize={9.5}
            fontFamily="var(--mono)"
          >
            {m}′
          </text>
        ))}

        <line
          x1={x(rtoTarget)}
          x2={x(rtoTarget)}
          y1={PAD.top - 6}
          y2={PAD.top + plotH}
          stroke="var(--ink-3)"
          strokeWidth={1}
          strokeDasharray="3 3"
        />
        <text
          x={x(rtoTarget) + 5}
          y={PAD.top - 7}
          fill="var(--ink-3)"
          fontSize={9.5}
          fontFamily="var(--mono)"
        >
          RTO {rtoTarget}′
        </text>

        {series.map(({ path: p, pts }, idx) => {
          const color = idx === 0 ? 'var(--series-1)' : 'var(--series-2)';
          const endX = x(maxMinute);
          const endY = y(pts[pts.length - 1].count);
          return (
            <g key={p.plan.id}>
              <path d={path2(pts)} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              <circle cx={endX} cy={endY} r={3.5} fill={color} stroke="var(--surface)" strokeWidth={2} />
            </g>
          );
        })}

        {hoverMinute !== null && (
          <>
            <line
              x1={x(hoverMinute)}
              x2={x(hoverMinute)}
              y1={PAD.top}
              y2={PAD.top + plotH}
              stroke="var(--baseline)"
              strokeWidth={1}
            />
            {series.map(({ pts }, idx) => (
              <circle
                key={idx}
                cx={x(hoverMinute)}
                cy={y(atMinute(pts, hoverMinute))}
                r={4}
                fill={idx === 0 ? 'var(--series-1)' : 'var(--series-2)'}
                stroke="var(--surface)"
                strokeWidth={2}
              />
            ))}
          </>
        )}
      </svg>

      {hoverMinute !== null && (
        <div
          className="chart-tooltip"
          style={{
            left: Math.min(Math.max(x(hoverMinute) + 12, 8), width - 156),
            top: 8,
          }}
        >
          <div className="tt-time">T+{hoverMinute} 分钟</div>
          {series.map(({ pts }, idx) => (
            <div className="tt-row" key={idx}>
              <span
                className="tt-key"
                style={{ background: idx === 0 ? 'var(--series-1)' : 'var(--series-2)' }}
              />
              <span className="tt-name">{paths[idx].plan.name}</span>
              <span className="tt-val">
                {atMinute(pts, hoverMinute)}/{total}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

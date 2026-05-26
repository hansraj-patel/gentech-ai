/**
 * Generative-UI renderer. Maps each `UIComponentKind` to a React component that
 * reads `UIBlock.props` (shaped by the contracts `UIComponentRegistry`
 * propsSchemas). `renderUISpec(spec)` walks the blocks and renders each via the
 * registry — this is the "pixels" side of "intelligence real, pixels faked".
 */
import React from "react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import type { UIBlock, UIComponentKind, UISpec } from "@gentech/contracts";

type Props = Record<string, unknown>;
type BlockComponent = (props: Props) => React.ReactElement;

// ── individual components ─────────────────────────────────────────────────────

const Counter: BlockComponent = (p) => {
  const value = typeof p.value === "number" ? p.value : 0;
  const label = typeof p.label === "string" ? p.label : "Count";
  const unit = typeof p.unit === "string" ? p.unit : "";
  const delta = typeof p.delta === "number" ? p.delta : undefined;
  return (
    <div className="block block-counter">
      <div className="counter-value">
        {value.toLocaleString()}
        {unit ? <span className="counter-unit"> {unit}</span> : null}
      </div>
      <div className="counter-label">{label}</div>
      {delta !== undefined ? (
        <div className={`counter-delta ${delta >= 0 ? "up" : "down"}`}>
          {delta >= 0 ? "▲" : "▼"} {Math.abs(delta)}
        </div>
      ) : null}
    </div>
  );
};

interface SeriesPoint {
  x: number | string;
  y: number;
}
interface Series {
  name: string;
  points: SeriesPoint[];
}

function chartData(p: Props): { data: Array<Record<string, unknown>>; names: string[] } {
  const series = Array.isArray(p.series) ? (p.series as Series[]) : [];
  if (series.length > 0) {
    const names = series.map((s) => s.name);
    // merge series points by x
    const byX = new Map<string | number, Record<string, unknown>>();
    for (const s of series) {
      for (const pt of s.points ?? []) {
        const row = byX.get(pt.x) ?? { x: pt.x };
        row[s.name] = pt.y;
        byX.set(pt.x, row);
      }
    }
    return { data: [...byX.values()], names };
  }
  // labels/values fallback (bar)
  const labels = Array.isArray(p.labels) ? (p.labels as string[]) : [];
  const values = Array.isArray(p.values) ? (p.values as number[]) : [];
  const data = labels.map((x, i) => ({ x, value: values[i] ?? 0 }));
  return { data, names: ["value"] };
}

const COLORS = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#06b6d4"];

const LineChartBlock: BlockComponent = (p) => {
  const { data, names } = chartData(p);
  const title = typeof p.title === "string" ? p.title : "Time series";
  return (
    <div className="block block-chart">
      <div className="block-title">{title}</div>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2a3a" />
          <XAxis dataKey="x" stroke="#888" fontSize={11} />
          <YAxis stroke="#888" fontSize={11} />
          <Tooltip contentStyle={{ background: "#1a1a26", border: "1px solid #333" }} />
          {names.map((n, i) => (
            <Line key={n} type="monotone" dataKey={n} stroke={COLORS[i % COLORS.length]} dot={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

const BarChartBlock: BlockComponent = (p) => {
  const { data, names } = chartData(p);
  const title = typeof p.title === "string" ? p.title : "Breakdown";
  return (
    <div className="block block-chart">
      <div className="block-title">{title}</div>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2a3a" />
          <XAxis dataKey="x" stroke="#888" fontSize={11} />
          <YAxis stroke="#888" fontSize={11} />
          <Tooltip contentStyle={{ background: "#1a1a26", border: "1px solid #333" }} />
          {names.map((n, i) => (
            <Bar key={n} dataKey={n} fill={COLORS[i % COLORS.length]} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
};

const TimelineBlock: BlockComponent = (p) => {
  const events = Array.isArray(p.events)
    ? (p.events as Array<{ t: number | string; label: string }>)
    : [];
  return (
    <div className="block block-timeline">
      <div className="block-title">Timeline</div>
      <ol className="timeline-list">
        {events.map((e, i) => (
          <li key={i}>
            <span className="timeline-t">{String(e.t)}</span>
            <span className="timeline-label">{e.label}</span>
          </li>
        ))}
      </ol>
    </div>
  );
};

const HeatmapBlock: BlockComponent = (p) => {
  const grid = Array.isArray(p.grid) ? (p.grid as number[][]) : [];
  const flat = grid.flat();
  const max = flat.length ? Math.max(...flat) : 1;
  return (
    <div className="block block-heatmap">
      <div className="block-title">Heatmap</div>
      <div className="heatmap-grid">
        {grid.map((row, r) => (
          <div key={r} className="heatmap-row">
            {row.map((cell, c) => {
              const intensity = max > 0 ? cell / max : 0;
              return (
                <div
                  key={c}
                  className="heatmap-cell"
                  title={String(cell)}
                  style={{ background: `rgba(99,102,241,${0.1 + intensity * 0.9})` }}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
};

const TableBlock: BlockComponent = (p) => {
  const columns = Array.isArray(p.columns) ? (p.columns as string[]) : [];
  const rows = Array.isArray(p.rows) ? (p.rows as unknown[][]) : [];
  return (
    <div className="block block-table">
      <div className="block-title">Detections</div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td key={j}>{typeof cell === "object" ? JSON.stringify(cell) : String(cell)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const VideoOverlayBlock: BlockComponent = (p) => {
  const segmentRef = typeof p.segmentRef === "string" ? p.segmentRef : "segment";
  const boxes = Array.isArray(p.boxes)
    ? (p.boxes as Array<{ x: number; y: number; w: number; h: number; label?: string }>)
    : [];
  return (
    <div className="block block-video">
      <div className="block-title">Video overlay — {segmentRef}</div>
      <div className="video-placeholder">
        <span className="video-watermark">faked pixels · {boxes.length} boxes</span>
        {boxes.map((b, i) => (
          <div
            key={i}
            className="video-box"
            style={{
              left: `${b.x * 100}%`,
              top: `${b.y * 100}%`,
              width: `${b.w * 100}%`,
              height: `${b.h * 100}%`,
            }}
          >
            {b.label ? <span className="video-box-label">{b.label}</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
};

const MapBlock: BlockComponent = (p) => {
  const points = Array.isArray(p.points)
    ? (p.points as Array<{ lat: number; lng: number; label?: string }>)
    : [];
  return (
    <div className="block block-map">
      <div className="block-title">Map ({points.length} points)</div>
      <ul className="map-list">
        {points.map((pt, i) => (
          <li key={i}>
            <span className="map-coord">
              {pt.lat.toFixed(4)}, {pt.lng.toFixed(4)}
            </span>
            {pt.label ? <span className="map-label">{pt.label}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
};

const SummaryCardBlock: BlockComponent = (p) => {
  const title = typeof p.title === "string" ? p.title : "Summary";
  const body = typeof p.body === "string" ? p.body : "";
  const stats = Array.isArray(p.stats)
    ? (p.stats as Array<{ label: string; value: number | string }>)
    : [];
  const blocked = /block|denied|policy/i.test(title) || /denied by policy/i.test(body);
  return (
    <div className={`block block-summary ${blocked ? "blocked" : ""}`}>
      <div className="block-title">{blocked ? "⛔ " : ""}{title}</div>
      <p className="summary-body">{body}</p>
      {stats.length > 0 ? (
        <div className="summary-stats">
          {stats.map((s, i) => (
            <div key={i} className="summary-stat">
              <div className="stat-value">{String(s.value)}</div>
              <div className="stat-label">{s.label}</div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};

// ── the registry ──────────────────────────────────────────────────────────────

export const REGISTRY: Record<UIComponentKind, BlockComponent> = {
  counter: Counter,
  line_chart: LineChartBlock,
  bar_chart: BarChartBlock,
  timeline: TimelineBlock,
  heatmap: HeatmapBlock,
  table: TableBlock,
  video_overlay: VideoOverlayBlock,
  map: MapBlock,
  summary_card: SummaryCardBlock,
};

function renderBlock(block: UIBlock): React.ReactElement {
  const Comp = REGISTRY[block.kind];
  if (!Comp) {
    return (
      <div className="block block-unknown">
        Unknown component kind: <code>{block.kind}</code>
      </div>
    );
  }
  return <Comp {...(block.props as Props)} />;
}

/** Render a full UISpec — maps each block through the registry. */
export function renderUISpec(spec: UISpec): React.ReactElement {
  return (
    <div className="uispec">
      {spec.explanation ? <div className="uispec-explanation">{spec.explanation}</div> : null}
      {spec.partial ? <div className="uispec-partial">streaming partial results…</div> : null}
      <div className="uispec-blocks">
        {spec.blocks.map((b) => (
          <div key={b.blockId} className="uispec-block-wrap">
            {renderBlock(b)}
          </div>
        ))}
      </div>
    </div>
  );
}

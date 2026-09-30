import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { interFont, spaceFont } from "../utils/fonts";

const DEFAULT_PALETTE = {
  bg: "#0A1119",
  surface: "#13202B",
  surfaceDeep: "#0A1119",
  primary: "#C9A36B",
  primaryDim: "#7A6240",
  label: "#E8E1D2",
  labelDim: "#8E887C",
  grid: "rgba(232,225,210,0.06)",
  divider: "rgba(232,225,210,0.10)",
};

export type Palette = Partial<typeof DEFAULT_PALETTE>;

export interface TrendPanelData {
  type: "trend";
  title: string;
  meta?: string;
  value: string;
  suffix?: string;
  subtitle?: string;
  dataPoints?: Array<[number, number]>;
}

export interface DonutPanelData {
  type: "donut";
  title: string;
  meta?: string;
  centerValue?: string;
  centerLabel?: string;
  segments: Array<{ label: string; value: number; color?: string }>;
}

export interface BarsPanelData {
  type: "bars";
  title: string;
  meta?: string;
  value: string;
  valueLabel?: string;
  subtitle?: string;
  bars: Array<{ label: string; value: number }>;
  highlightIndex?: number;
}

export type PanelData = TrendPanelData | DonutPanelData | BarsPanelData;

export interface KineticDashboardProps {
  panels: PanelData[];
  palette?: Palette;
}

const DEFAULT_DATA_POINTS: Array<[number, number]> = [
  [0, 96], [6, 89], [12, 92], [18, 80], [24, 78], [30, 82],
  [36, 70], [42, 67], [48, 58], [54, 48], [60, 52], [66, 40],
  [72, 32], [78, 28], [84, 20], [90, 14], [100, 8],
];

const PanelFrame: React.FC<{
  delay: number;
  height: number;
  palette: typeof DEFAULT_PALETTE;
  children: React.ReactNode;
}> = ({ delay, height, palette, children }) => {
  const frame = useCurrentFrame();
  const surfaceOn = interpolate(frame, [delay, delay + 14], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        position: "relative",
        height,
        width: "100%",
        overflow: "hidden",
        background: `linear-gradient(180deg, ${palette.surface} 0%, ${palette.surfaceDeep} 100%)`,
        opacity: surfaceOn,
        boxShadow: `inset 0 0 0 1px ${palette.primary}33, inset 0 0 90px ${palette.primary}1A`,
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          height: 1,
          background: `${palette.primary}66`,
        }}
      />
      <div
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          padding: "36px 52px 38px 52px",
          boxSizing: "border-box",
          fontFamily: interFont,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {children}
      </div>
    </div>
  );
};

const PanelHeader: React.FC<{
  title: string;
  meta?: string;
  palette: typeof DEFAULT_PALETTE;
}> = ({ title, meta, palette }) => (
  <div
    style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      paddingBottom: 14,
      borderBottom: `1px solid ${palette.grid}`,
    }}
  >
    <span
      style={{
        fontFamily: spaceFont,
        fontSize: 22,
        color: palette.label,
        letterSpacing: 3,
        fontWeight: 600,
        textTransform: "uppercase",
      }}
    >
      {title}
    </span>
    {meta && (
      <span
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          fontSize: 14,
          color: palette.labelDim,
          letterSpacing: 2,
          textTransform: "uppercase",
        }}
      >
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: "50%",
            background: palette.primary,
            boxShadow: `0 0 10px ${palette.primary}`,
          }}
        />
        {meta}
      </span>
    )}
  </div>
);

const TrendPanel: React.FC<{
  data: TrendPanelData;
  delay: number;
  height: number;
  palette: typeof DEFAULT_PALETTE;
}> = ({ data, delay, height, palette }) => {
  const frame = useCurrentFrame();
  const valueNum = parseFloat(data.value.replace(/[^\-0-9.]/g, "")) || 0;
  const numProgress = interpolate(frame, [delay + 18, delay + 60], [0, valueNum], {
    extrapolateRight: "clamp",
  });
  const lineProgress = interpolate(frame, [delay + 18, delay + 100], [0, 1], {
    extrapolateRight: "clamp",
  });
  const valueSign = data.value.startsWith("+") || data.value.startsWith("-") ? data.value[0] : "";
  const displayNum = `${valueSign}${Math.abs(Math.round(numProgress))}`;

  const points = data.dataPoints && data.dataPoints.length >= 2 ? data.dataPoints : DEFAULT_DATA_POINTS;
  const visibleCount = Math.max(2, Math.floor(points.length * lineProgress));
  const visiblePts = points.slice(0, visibleCount);

  const chartW = 900;
  const chartH = height - 240;
  const path = visiblePts
    .map((p, i) => `${i === 0 ? "M" : "L"} ${(p[0] / 100) * chartW} ${(p[1] / 100) * chartH}`)
    .join(" ");
  const lastPt = visiblePts[visiblePts.length - 1];
  const areaPath = `${path} L ${(lastPt[0] / 100) * chartW} ${chartH} L 0 ${chartH} Z`;

  return (
    <PanelFrame delay={delay} height={height} palette={palette}>
      <PanelHeader title={data.title} meta={data.meta} palette={palette} />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", paddingTop: 28 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span
            style={{
              fontSize: 168,
              fontWeight: 700,
              color: palette.primary,
              fontFamily: spaceFont,
              lineHeight: 0.95,
              letterSpacing: -4,
            }}
          >
            {displayNum}
          </span>
          {data.suffix && (
            <span
              style={{
                fontSize: 80,
                color: palette.primary,
                fontWeight: 600,
                fontFamily: spaceFont,
              }}
            >
              {data.suffix}
            </span>
          )}
        </div>
        {data.subtitle && (
          <span
            style={{
              fontSize: 20,
              color: palette.labelDim,
              letterSpacing: 2.5,
              textTransform: "uppercase",
              marginTop: 12,
            }}
          >
            {data.subtitle}
          </span>
        )}
        <div style={{ flex: 1, display: "flex", alignItems: "flex-end", marginTop: 32 }}>
          <svg width={chartW} height={chartH} style={{ display: "block" }}>
            <defs>
              <linearGradient id={`trendFill-${delay}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={palette.primary} stopOpacity="0.5" />
                <stop offset="100%" stopColor={palette.primary} stopOpacity="0" />
              </linearGradient>
            </defs>
            {[0.25, 0.5, 0.75].map((t) => (
              <line
                key={t}
                x1={0}
                x2={chartW}
                y1={chartH * t}
                y2={chartH * t}
                stroke={palette.grid}
                strokeWidth={1}
              />
            ))}
            <path d={areaPath} fill={`url(#trendFill-${delay})`} />
            <path
              d={path}
              fill="none"
              stroke={palette.primary}
              strokeWidth={5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            <circle
              cx={(lastPt[0] / 100) * chartW}
              cy={(lastPt[1] / 100) * chartH}
              r={9}
              fill={palette.primary}
            />
          </svg>
        </div>
      </div>
    </PanelFrame>
  );
};

const DEFAULT_DONUT_COLORS = ["#C9A36B", "#B08C58", "#8C6E44", "#695032", "#4A3923"];

const DonutPanel: React.FC<{
  data: DonutPanelData;
  delay: number;
  height: number;
  palette: typeof DEFAULT_PALETTE;
}> = ({ data, delay, height, palette }) => {
  const frame = useCurrentFrame();
  const reveal = interpolate(frame, [delay + 18, delay + 80], [0, 1], {
    extrapolateRight: "clamp",
  });
  const total = data.segments.reduce((acc, s) => acc + s.value, 0) || 1;
  const segments = data.segments.map((s, i) => ({
    ...s,
    color: s.color ?? DEFAULT_DONUT_COLORS[i % DEFAULT_DONUT_COLORS.length],
    pct: (s.value / total) * 100,
  }));

  const donutSize = Math.min(height - 200, 360);
  const r = donutSize / 2 - 12;
  const innerR = r * 0.6;
  const cx = donutSize / 2;
  const cy = donutSize / 2;
  let cumulative = 0;
  const arcs = segments.map((s) => {
    const startAngle = (cumulative / 100) * Math.PI * 2 - Math.PI / 2;
    const endAngle = ((cumulative + s.pct * reveal) / 100) * Math.PI * 2 - Math.PI / 2;
    cumulative += s.pct;
    const x1 = cx + r * Math.cos(startAngle);
    const y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);
    const xi2 = cx + innerR * Math.cos(endAngle);
    const yi2 = cy + innerR * Math.sin(endAngle);
    const xi1 = cx + innerR * Math.cos(startAngle);
    const yi1 = cy + innerR * Math.sin(startAngle);
    const largeArc = s.pct * reveal > 50 ? 1 : 0;
    return {
      ...s,
      d: `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} L ${xi2} ${yi2} A ${innerR} ${innerR} 0 ${largeArc} 0 ${xi1} ${yi1} Z`,
    };
  });
  const maxBarWidthRef = Math.max(...segments.map((s) => s.pct));

  return (
    <PanelFrame delay={delay} height={height} palette={palette}>
      <PanelHeader title={data.title} meta={data.meta} palette={palette} />
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          gap: 64,
          paddingTop: 24,
        }}
      >
        <div style={{ position: "relative", width: donutSize, height: donutSize, flexShrink: 0 }}>
          <svg width={donutSize} height={donutSize}>
            {arcs.map((a, i) => (
              <path key={i} d={a.d} fill={a.color} />
            ))}
            <circle cx={cx} cy={cy} r={innerR - 2} fill={palette.surfaceDeep} />
          </svg>
          {data.centerValue && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <span
                style={{
                  fontSize: 64,
                  fontWeight: 700,
                  color: palette.label,
                  fontFamily: spaceFont,
                  lineHeight: 1,
                }}
              >
                {data.centerValue}
              </span>
              {data.centerLabel && (
                <span
                  style={{
                    fontSize: 16,
                    color: palette.labelDim,
                    letterSpacing: 2.2,
                    textTransform: "uppercase",
                    marginTop: 6,
                  }}
                >
                  {data.centerLabel}
                </span>
              )}
            </div>
          )}
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 20 }}>
          {segments.map((s, i) => {
            const barW = (s.pct * reveal) / (maxBarWidthRef || 1);
            return (
              <div key={i} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <span
                    style={{
                      fontSize: 24,
                      color: palette.label,
                      fontWeight: 500,
                      letterSpacing: 0.5,
                    }}
                  >
                    {s.label}
                  </span>
                  <span
                    style={{
                      fontSize: 26,
                      color: palette.label,
                      fontWeight: 700,
                      fontFamily: spaceFont,
                      letterSpacing: 0.5,
                    }}
                  >
                    {Math.round(s.pct * reveal)}%
                  </span>
                </div>
                <div
                  style={{
                    height: 6,
                    background: "rgba(232,225,210,0.08)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: `${barW * 100}%`,
                      background: s.color,
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </PanelFrame>
  );
};

const BarsPanel: React.FC<{
  data: BarsPanelData;
  delay: number;
  height: number;
  palette: typeof DEFAULT_PALETTE;
}> = ({ data, delay, height, palette }) => {
  const frame = useCurrentFrame();
  const valueNum = parseFloat(data.value.replace(/[^\-0-9.]/g, "")) || 0;
  const numProgress = interpolate(frame, [delay + 18, delay + 60], [0, valueNum], {
    extrapolateRight: "clamp",
  });
  const numToday = Math.round(numProgress);

  const highlightIdx = data.highlightIndex ?? data.bars.length - 1;
  const max = Math.max(...data.bars.map((b) => b.value)) * 1.1;
  const barReveal = interpolate(frame, [delay + 18, delay + 90], [0, 1], {
    extrapolateRight: "clamp",
  });

  const chartW = 900;
  const chartH = height - 280;
  const barGap = 18;
  const barW = (chartW - barGap * (data.bars.length - 1)) / data.bars.length;

  return (
    <PanelFrame delay={delay} height={height} palette={palette}>
      <PanelHeader title={data.title} meta={data.meta} palette={palette} />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", paddingTop: 28 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 16 }}>
          <span
            style={{
              fontSize: 168,
              fontWeight: 700,
              color: palette.primary,
              fontFamily: spaceFont,
              lineHeight: 0.95,
              letterSpacing: -4,
            }}
          >
            {numToday}
          </span>
          {data.valueLabel && (
            <span
              style={{
                fontSize: 22,
                color: palette.labelDim,
                letterSpacing: 2.5,
                textTransform: "uppercase",
              }}
            >
              {data.valueLabel}
            </span>
          )}
        </div>
        {data.subtitle && (
          <span
            style={{
              fontSize: 20,
              color: palette.labelDim,
              letterSpacing: 2.5,
              textTransform: "uppercase",
              marginTop: 12,
            }}
          >
            {data.subtitle}
          </span>
        )}
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "center",
            marginTop: 32,
          }}
        >
          <div style={{ display: "flex", gap: barGap, alignItems: "flex-end", height: chartH }}>
            {data.bars.map((b, i) => {
              const isHi = i === highlightIdx;
              const targetH = (b.value / max) * chartH * barReveal;
              return (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    width: barW,
                    gap: 10,
                  }}
                >
                  {isHi && (
                    <span
                      style={{
                        fontSize: 22,
                        color: palette.primary,
                        fontFamily: spaceFont,
                        fontWeight: 700,
                      }}
                    >
                      {Math.round(b.value * barReveal)}
                    </span>
                  )}
                  <div
                    style={{
                      width: barW,
                      height: targetH,
                      background: isHi ? palette.primary : palette.primaryDim,
                      boxShadow: isHi ? `0 0 22px ${palette.primary}99` : "none",
                    }}
                  />
                  <span
                    style={{
                      fontSize: 17,
                      color: isHi ? palette.label : palette.labelDim,
                      fontWeight: isHi ? 700 : 500,
                      letterSpacing: 1.5,
                      textTransform: "uppercase",
                    }}
                  >
                    {b.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </PanelFrame>
  );
};

export const KineticDashboard: React.FC<KineticDashboardProps> = ({ panels, palette }) => {
  const { height: H } = useVideoConfig();
  const merged = { ...DEFAULT_PALETTE, ...(palette ?? {}) };

  const safePanels = panels.slice(0, 3);
  const count = safePanels.length;
  const outerPadding = 60;
  const panelGap = 24;
  const availableH = H - outerPadding * 2 - panelGap * (count - 1);
  const panelH = availableH / count;

  return (
    <AbsoluteFill style={{ background: merged.bg }}>
      <div
        style={{
          position: "absolute",
          inset: outerPadding,
          display: "flex",
          flexDirection: "column",
          gap: panelGap,
        }}
      >
        {safePanels.map((panel, i) => {
          const delay = i * 10;
          if (panel.type === "trend") {
            return <TrendPanel key={i} data={panel} delay={delay} height={panelH} palette={merged} />;
          }
          if (panel.type === "donut") {
            return <DonutPanel key={i} data={panel} delay={delay} height={panelH} palette={merged} />;
          }
          return <BarsPanel key={i} data={panel} delay={delay} height={panelH} palette={merged} />;
        })}
      </div>
    </AbsoluteFill>
  );
};

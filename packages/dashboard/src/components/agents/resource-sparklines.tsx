"use client"

interface MetricData {
  label: string
  value: string
  unit: string
  delta?: string
  deltaType?: "positive" | "negative" | "neutral"
  samples: number[]
  icon: string
}

interface ResourceSparklinesProps {
  metrics: MetricData[]
}

// ---------------------------------------------------------------------------
// SVG Sparkline
// ---------------------------------------------------------------------------

function Sparkline({
  samples,
  width = 120,
  height = 32,
}: {
  samples: number[]
  width?: number
  height?: number
}): React.JSX.Element {
  const data = samples.length > 0 ? samples.slice(-20) : []
  if (data.length < 2) {
    return (
      <div
        className="flex items-center justify-center rounded bg-slate-200 dark:bg-primary/20"
        style={{ width, height }}
      >
        <span className="text-[9px] text-slate-400">No data</span>
      </div>
    )
  }

  const max = Math.max(...data, 1)
  const stepX = width / (data.length - 1)
  const padding = 2

  const points = data
    .map((v, i) => {
      const x = i * stepX
      const y = height - padding - (v / max) * (height - padding * 2)
      return `${x},${y}`
    })
    .join(" ")

  // Create gradient fill path
  const fillPoints = [
    `0,${height}`,
    ...data.map((v, i) => {
      const x = i * stepX
      const y = height - padding - (v / max) * (height - padding * 2)
      return `${x},${y}`
    }),
    `${(data.length - 1) * stepX},${height}`,
  ].join(" ")

  return (
    <svg width={width} height={height} className="overflow-visible">
      <defs>
        <linearGradient id="sparkGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0.3" />
          <stop offset="100%" stopColor="var(--color-primary)" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <polygon points={fillPoints} fill="url(#sparkGradient)" />
      <polyline
        points={points}
        fill="none"
        stroke="var(--color-primary)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Current value dot */}
      {data.length > 0 && (
        <circle
          cx={(data.length - 1) * stepX}
          cy={height - padding - (data[data.length - 1]! / max) * (height - padding * 2)}
          r="2.5"
          fill="var(--color-primary)"
        />
      )}
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const deltaColors: Record<string, string> = {
  positive: "text-emerald-500",
  negative: "text-red-500",
  neutral: "text-amber-500",
}

export function ResourceSparklines({ metrics }: ResourceSparklinesProps): React.JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {metrics.map((metric) => (
        <div
          key={metric.label}
          className="rounded-xl border border-slate-200 bg-white p-4 dark:border-primary/10 dark:bg-primary/5"
        >
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span className="material-symbols-outlined text-[16px] text-slate-400">
                {metric.icon}
              </span>
              <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                {metric.label}
              </span>
            </div>
            {metric.delta && (
              <span
                className={`text-[10px] font-bold ${deltaColors[metric.deltaType ?? "neutral"]}`}
              >
                {metric.delta}
              </span>
            )}
          </div>
          <div className="mb-2 flex items-baseline gap-1">
            <span className="text-xl font-bold text-slate-900 dark:text-white">{metric.value}</span>
            <span className="text-sm font-normal text-slate-400">{metric.unit}</span>
          </div>
          <Sparkline samples={metric.samples} width={140} height={28} />
        </div>
      ))}
    </div>
  )
}

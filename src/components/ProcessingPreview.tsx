import type { ProcessingProgressEvent, ProcessingStageDefinition } from '../types'

interface ProcessingPreviewProps {
  fileName: string
  sourceImageUrl: string | null
  progress: ProcessingProgressEvent | null
  stages: ProcessingStageDefinition[]
  /** True when a pattern already exists and this run refreshes it with new settings. */
  isRegeneration?: boolean
}

function clampProgress(value: number) {
  return Math.min(Math.max(value, 0), 1)
}

export function ProcessingPreview({
  fileName,
  sourceImageUrl,
  progress,
  stages,
  isRegeneration = false,
}: ProcessingPreviewProps) {
  const currentStageIndex = progress ? Math.max(progress.stageIndex - 1, 0) : 0
  const totalStages = progress?.totalStages ?? stages.length
  const activeLabel = progress?.label ?? 'Starting'
  const pct = clampProgress(progress?.progress ?? 0)
  const progressWidth = `${pct * 100}%`
  const indeterminate = pct < 0.035

  const title = isRegeneration ? 'Refreshing your masterpiece.' : 'Your pattern is taking shape.'
  const subtitle = isRegeneration
    ? 'New threads, new grid — hang tight while the heavy pass runs.'
    : 'Color, DMC matches, and stitch outlines are coming together.'

  return (
    <div className="magpie-processing-root relative z-10 flex h-full w-full overflow-hidden rounded-[2rem] border border-white/10 bg-[#0d0911]/92 shadow-[0_30px_80px_rgba(10,6,16,0.42)]">
      {sourceImageUrl && (
        <>
          <img
            src={sourceImageUrl}
            alt=""
            aria-hidden="true"
            className="absolute inset-0 h-full w-full scale-105 object-cover opacity-[0.18] blur-2xl"
          />
          <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(6,4,9,0.82),rgba(14,10,18,0.94)),radial-gradient(circle_at_top,rgba(227,181,213,0.14),transparent_42%),radial-gradient(circle_at_bottom_right,rgba(166,172,207,0.14),transparent_34%)]" />
        </>
      )}

      <div className="relative flex h-full min-h-0 w-full min-w-0 flex-col justify-between gap-6 overflow-y-auto px-4 py-5 sm:gap-8 sm:px-8 sm:py-8 lg:px-10 lg:py-9">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="magpie-label text-[var(--accent-soft)]">Magpie in process</p>
            <h2 className="magpie-display mt-4 text-3xl font-semibold text-[var(--text-strong)] sm:text-[2.2rem]">
              {title}
            </h2>
            <p className="mt-4 max-w-xl text-sm leading-7 text-[var(--text-soft)]">{subtitle}</p>
          </div>
          <div
            aria-hidden="true"
            className="magpie-processing-spinner mt-1 h-14 w-14 shrink-0 rounded-full border border-white/10 bg-white/[0.04]"
          />
        </div>

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(18rem,0.8fr)] lg:items-end">
          <div className="space-y-5">
            <div className="rounded-[1.5rem] border border-white/10 bg-black/[0.22] p-4 shadow-[0_18px_44px_rgba(10,6,16,0.28)]">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-[var(--text-muted)]">
                    Current step
                  </p>
                  <p
                    className="mt-2 text-base font-medium text-[var(--text-strong)]"
                    aria-live="polite"
                  >
                    {activeLabel}
                  </p>
                </div>
                <div className="rounded-full border border-white/10 bg-white/[0.05] px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--text-soft)]">
                  Step {Math.min(currentStageIndex + 1, totalStages)} of {totalStages}
                </div>
              </div>

              <div
                className={`relative mt-4 h-2.5 overflow-hidden rounded-full bg-white/[0.08] ${
                  indeterminate ? 'magpie-processing-bar-track--indeterminate' : ''
                }`}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={indeterminate ? undefined : Math.round(pct * 100)}
                aria-valuetext={indeterminate ? 'Starting' : `${Math.round(pct * 100)}% complete`}
              >
                <div
                  className={`magpie-processing-bar relative h-full rounded-full ${
                    indeterminate ? 'magpie-processing-bar--indeterminate' : ''
                  }`}
                  style={indeterminate ? undefined : { width: progressWidth }}
                />
              </div>

              <p className="mt-3 text-xs leading-6 text-[var(--text-muted)]">
                {indeterminate
                  ? 'Warming up — the bar will track each step as soon as the engine reports in.'
                  : 'Overall progress across color reduction, thread matching, and outlines.'}
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {stages.map((stage, index) => {
                const isComplete = index < currentStageIndex
                const isActive = stage.key === progress?.stage

                return (
                  <div
                    key={stage.key}
                    className={`rounded-[1.35rem] border px-4 py-3 transition duration-200 ${
                      isComplete
                        ? 'border-[var(--accent-strong)]/28 bg-[var(--accent-strong)]/10 text-[var(--text-strong)]'
                        : isActive
                          ? 'border-[var(--accent-cool)]/36 bg-[var(--accent-cool)]/10 text-[var(--text-strong)] shadow-[0_16px_36px_rgba(98,107,169,0.16)]'
                          : 'border-white/8 bg-white/[0.04] text-[var(--text-soft)]'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border font-mono text-[10px] uppercase tracking-[0.18em] ${
                          isComplete
                            ? 'border-[var(--accent-strong)]/40 bg-[var(--accent-strong)]/18 text-[var(--text-strong)]'
                            : isActive
                              ? 'border-[var(--accent-cool)]/45 bg-[var(--accent-cool)]/16 text-[var(--accent-cool-strong)]'
                              : 'border-white/10 bg-black/[0.2] text-[var(--text-muted)]'
                        }`}
                      >
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <p className="text-sm leading-6">{stage.label}</p>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="rounded-[1.6rem] border border-white/10 bg-black/[0.24] p-5 shadow-[0_18px_48px_rgba(10,6,16,0.26)]">
            <p className="magpie-label">Source</p>
            <p className="mt-3 truncate text-sm text-[var(--text-strong)]">{fileName}</p>
            <p className="mt-2 text-sm leading-6 text-[var(--text-soft)]">
              This is the fun part — each cell is being matched to real floss. The interactive viewer
              pops in when the pass finishes.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

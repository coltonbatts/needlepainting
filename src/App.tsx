import { useCallback, useEffect, useRef, useState } from 'react'
import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { open as dialogOpen } from '@tauri-apps/plugin-dialog'
import { ProcessingPreview } from './components/ProcessingPreview'
import { StitchMapViewer } from './components/StitchMapViewer'
import type {
  ProcessMetrics,
  PaletteEntry,
  PreviewMode,
  ProcessingProgressEvent,
  ProcessingStageDefinition,
  StitchMapData,
} from './types'

interface ResultState {
  sourceImageUrl: string
  outlineImageUrl: string | null
  threadPreviewImageUrl: string | null
  width: number
  height: number
  palette: PaletteEntry[]
  filePath: string
  fileName: string
  stitchMap: StitchMapData | null
  metrics: ProcessMetrics | null
}

interface ProcessImageResponse {
  image_path: string
  thread_preview_path: string
  labels_path: string
  width: number
  height: number
  palette: PaletteEntry[]
  metrics: ProcessMetrics
}

interface SliderProps {
  label: string
  valueLabel: string
  value: number
  min: number
  max: number
  step?: number
  hint: string
  minLabel: string
  maxLabel: string
  disabled?: boolean
  onChange: (value: number) => void
}

const PROCESSING_STAGES: ProcessingStageDefinition[] = [
  { key: 'loading_image', label: 'Loading image' },
  { key: 'reducing_colors', label: 'Reducing colors' },
  { key: 'cleaning_regions', label: 'Cleaning regions' },
  { key: 'matching_threads', label: 'Matching threads' },
  { key: 'building_outlines', label: 'Building outlines' },
  { key: 'preparing_preview', label: 'Preparing preview' },
]

function createProcessRequestId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }

  return `pattern-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function getFileName(filePath: string) {
  const normalized = filePath.replace(/\\/g, '/')
  return normalized.split('/').pop() || filePath
}

function ControlSlider({
  label,
  valueLabel,
  value,
  min,
  max,
  step = 1,
  hint,
  minLabel,
  maxLabel,
  disabled = false,
  onChange,
}: SliderProps) {
  return (
    <div className="rounded-[1.7rem] border border-white/10 bg-black/[0.18] p-4 shadow-[0_16px_40px_rgba(12,7,18,0.16)]">
      <div className="mb-3 flex items-center justify-between gap-3">
        <label className="magpie-label">{label}</label>
        <span className="font-mono text-sm text-[var(--text-strong)]">{valueLabel}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        className="magpie-range"
      />
      <div className="mt-3 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
        <span>{minLabel}</span>
        <span>{maxLabel}</span>
      </div>
      <p className="mt-2 text-sm leading-6 text-[var(--text-soft)]">{hint}</p>
    </div>
  )
}

function App() {
  const [numColors, setNumColors] = useState(12)
  const [lineThickness, setLineThickness] = useState(1)
  const [downscaleMax, setDownscaleMax] = useState(800)
  const [minRegionSize, setMinRegionSize] = useState(50)
  const [previewMode, setPreviewMode] = useState<PreviewMode>('outline')
  const [showOutline, setShowOutline] = useState(true)
  const [processing, setProcessing] = useState(false)
  const [savingPng, setSavingPng] = useState(false)
  const [processingProgress, setProcessingProgress] = useState<ProcessingProgressEvent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ResultState | null>(null)
  const [isolatedPaletteId, setIsolatedPaletteId] = useState<number | null>(null)
  const activeRequestIdRef = useRef<string | null>(null)
  const isPatternReady = Boolean(
    result &&
      result.outlineImageUrl &&
      result.threadPreviewImageUrl &&
      result.palette.length > 0 &&
      result.stitchMap,
  )
  const hasPalette = Boolean(isPatternReady && result?.palette.length)
  const activePreviewUrl = result
    ? isPatternReady
      ? previewMode === 'thread'
        ? result.threadPreviewImageUrl
        : result.outlineImageUrl
      : result.sourceImageUrl
    : null
  const currentStageLabel = processingProgress?.label ?? 'Processing'
  const processingProgressLabel = processingProgress
    ? `${currentStageLabel} · ${Math.round(processingProgress.progress * 100)}%`
    : currentStageLabel
  const processingHint = 'Loading the image, reducing colors, matching threads, and building the preview.'
  const previewTitle = processing
    ? 'Processing'
    : isPatternReady
      ? previewMode === 'thread'
        ? showOutline
          ? 'Thread Colors'
          : 'Color Only'
        : showOutline
          ? 'Line Pattern'
          : 'Color Only'
      : result
        ? 'Photo'
        : 'Preview'
  const previewDisplayLabel =
    previewMode === 'thread'
      ? showOutline
        ? 'thread colors'
        : 'color only'
      : showOutline
        ? 'line pattern'
        : 'color only'
  const previewSubtitle = result
    ? processing
      ? `${result.fileName} · ${currentStageLabel}`
      : result.fileName
    : 'Choose a photo to begin.'
  const sortedPalette = result
    ? [...result.palette].sort((a, b) => b.region_count - a.region_count || a.pal_id - b.pal_id)
    : []
  const statusText = processing
    ? `${currentStageLabel}${processingProgress ? ` · ${Math.round(processingProgress.progress * 100)}%` : ''}`
    : hasPalette
      ? result?.metrics
        ? `${result.metrics.preview ? 'Preview' : 'Final'} ready · ${Math.round(result.metrics.timings.totalMs)}ms`
        : 'Pattern ready'
      : result
        ? 'Photo loaded'
        : 'Ready'

  const handleSavePng = useCallback(async () => {
    if (!result || !isPatternReady || savingPng) {
      return
    }

    const downloadUrl =
      previewMode === 'thread'
        ? result.threadPreviewImageUrl
        : result.outlineImageUrl

    if (!downloadUrl) {
      return
    }

    setSavingPng(true)

    try {
      const response = await fetch(downloadUrl)
      if (!response.ok) {
        throw new Error(`Failed to load PNG (${response.status})`)
      }

      const blob = await response.blob()
      const blobUrl = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = blobUrl
      link.download =
        previewMode === 'thread'
          ? `magpies-needle-painter-thread-colors-${numColors}.png`
          : `magpies-needle-painter-line-pattern-${numColors}.png`
      link.rel = 'noopener'
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(blobUrl)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      setError(`Could not save PNG: ${message}`)
    } finally {
      setSavingPng(false)
    }
  }, [isPatternReady, numColors, previewMode, result, savingPng])

  useEffect(() => {
    let unlisten: UnlistenFn | null = null

    const attachListener = async () => {
      unlisten = await listen<ProcessingProgressEvent>('pattern-progress', (event) => {
        if (event.payload.requestId !== activeRequestIdRef.current) {
          return
        }

        setProcessingProgress(event.payload)
      })
    }

    void attachListener()

    return () => {
      if (unlisten) {
        unlisten()
      }
    }
  }, [])

  const togglePaletteIsolation = useCallback((paletteId: number | null) => {
    setIsolatedPaletteId((current) => (current === paletteId ? null : paletteId))
  }, [])

  const updateImageDimensions = useCallback((width: number, height: number) => {
    setResult((prev) => {
      if (!prev) return null
      if (prev.width === width && prev.height === height) return prev

      return {
        ...prev,
        width,
        height,
      }
    })
  }, [])

  const handleProcess = useCallback(async () => {
    if (!result?.filePath || processing) return

    const requestId = createProcessRequestId()
    activeRequestIdRef.current = requestId
    setProcessing(true)
    setError(null)
    setProcessingProgress({
      requestId,
      stage: 'loading_image',
      label: 'Loading image',
      stageIndex: 1,
      totalStages: PROCESSING_STAGES.length,
      progress: 0,
    })

    try {
      const res = (await invoke('process_image', {
        imagePath: result.filePath,
        requestId,
        numColors,
        lineThickness,
        downscaleMax,
        minRegionSize,
        preview: false,
      })) as ProcessImageResponse

      if (activeRequestIdRef.current !== requestId) {
        return
      }

      const outlineUrl = convertFileSrc(res.image_path)
      const threadPreviewUrl = convertFileSrc(res.thread_preview_path)
      const labelsUrl = convertFileSrc(res.labels_path)
      const labelsBuffer = await fetch(labelsUrl).then((response) => {
        if (!response.ok) {
          throw new Error(`Failed to load stitch map labels (${response.status})`)
        }

        return response.arrayBuffer()
      })

      if (activeRequestIdRef.current !== requestId) {
        return
      }

      setIsolatedPaletteId(null)

      setResult((prev) =>
        prev
          ? {
              ...prev,
              outlineImageUrl: outlineUrl,
              threadPreviewImageUrl: threadPreviewUrl,
              width: res.width,
              height: res.height,
              palette: res.palette,
              stitchMap: {
                width: res.width,
                height: res.height,
                labels: new Uint8Array(labelsBuffer),
              },
              metrics: res.metrics,
            }
          : null,
      )
    } catch (e: unknown) {
      if (activeRequestIdRef.current === requestId) {
        const errMsg = e instanceof Error ? e.message : String(e)
        setError(errMsg)
      }
    } finally {
      if (activeRequestIdRef.current === requestId) {
        activeRequestIdRef.current = null
        setProcessing(false)
      }
    }
  }, [downscaleMax, lineThickness, minRegionSize, numColors, processing, result?.filePath])

  const handlePickFile = useCallback(async () => {
    setError(null)

    try {
      const selected = await dialogOpen({
        title: "Choose a photo for Magpie's Needle Painter",
        multiple: false,
        filters: [{
          name: 'Image',
          extensions: ['png', 'jpg', 'jpeg', 'bmp', 'tiff', 'webp'],
        }],
      })

      if (typeof selected === 'string') {
        activeRequestIdRef.current = null
        setProcessing(false)
        setProcessingProgress(null)
        setPreviewMode('outline')
        setShowOutline(true)
        setIsolatedPaletteId(null)
        setError(null)
        const previewUrl = convertFileSrc(selected)

        setResult({
          sourceImageUrl: previewUrl,
          outlineImageUrl: null,
          threadPreviewImageUrl: null,
          width: 0,
          height: 0,
          palette: [],
          filePath: selected,
          fileName: getFileName(selected),
          stitchMap: null,
          metrics: null,
        })
      }
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e)
      setError(`Could not open that photo: ${errMsg}`)
    }
  }, [])

  return (
    <div className="flex min-h-screen flex-col bg-transparent text-[var(--text-main)]">
      <header className="shrink-0 border-b border-white/10 bg-black/20 backdrop-blur-2xl">
        <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-5 px-4 py-5 lg:px-6 lg:py-6">
          <div className="flex flex-col items-center gap-5">
            <h1 className="magpie-display text-center text-4xl font-semibold tracking-[0.08em] text-[var(--text-strong)] sm:text-5xl">
              Magpie&apos;s Needle Painter
            </h1>

            <div className="flex flex-wrap justify-center gap-3">
              <button
                type="button"
                onClick={handlePickFile}
                className="magpie-button border-white/12 bg-white/[0.07] text-[var(--text-strong)] hover:border-white/25 hover:bg-white/12"
              >
                Choose Photo
              </button>
              <button
                type="button"
                onClick={handleProcess}
                disabled={!result?.filePath || processing}
                aria-busy={processing}
                className="magpie-button min-w-[11.5rem] border-[var(--accent-strong)]/40 bg-[var(--accent-strong)] text-[#221622] shadow-[0_18px_40px_rgba(227,181,213,0.22)] hover:-translate-y-px hover:bg-[var(--accent-soft)] disabled:translate-y-0"
              >
                {processing ? (
                  <span className="flex items-center gap-2">
                    <span aria-hidden="true" className="magpie-button-spinner" />
                    <span>Making Pattern</span>
                  </span>
                ) : (
                  'Make Pattern'
                )}
              </button>
              {isPatternReady && result && !processing && (
                <button
                  type="button"
                  onClick={handleSavePng}
                  disabled={savingPng}
                  className="magpie-button border-[var(--accent-cool)]/40 bg-[var(--accent-cool)]/12 text-[var(--accent-cool-strong)] hover:border-[var(--accent-cool)]/70 hover:bg-[var(--accent-cool)]/20"
                >
                  {savingPng ? (
                    <span className="flex items-center gap-2">
                      <span aria-hidden="true" className="magpie-button-spinner" />
                      <span>Saving PNG</span>
                    </span>
                  ) : (
                    'Save PNG'
                  )}
                </button>
              )}
              {processing && (
                <div
                  className="flex items-center gap-2 rounded-full border border-white/10 bg-black/[0.18] px-4 py-2 font-mono text-[10px] uppercase tracking-[0.22em] text-[var(--text-soft)]"
                  aria-live="polite"
                >
                  <span aria-hidden="true" className="magpie-button-spinner h-3.5 w-3.5" />
                  <span>{processingProgressLabel}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto flex min-h-0 w-full max-w-[1500px] flex-1 flex-col gap-5 overflow-hidden px-4 py-4 lg:flex-row lg:px-6 lg:py-5">
        <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="magpie-panel flex h-full flex-col overflow-hidden">
            <div className="flex flex-col gap-3 border-b border-white/10 px-5 py-4 lg:flex-row lg:items-center lg:justify-between lg:px-6">
              <div>
                <p className="magpie-label">{previewTitle}</p>
                <p className="mt-2 text-sm text-[var(--text-soft)]">{previewSubtitle}</p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {isPatternReady && !processing && (
                  <div
                    className="inline-flex rounded-full border border-white/10 bg-black/[0.18] p-1"
                    aria-label="Preview mode"
                  >
                    <button
                      type="button"
                      aria-pressed={previewMode === 'outline'}
                      className={`magpie-toggle-segment ${
                        previewMode === 'outline'
                          ? 'bg-[var(--accent-strong)] text-[#241625] shadow-[0_10px_28px_rgba(227,181,213,0.28)]'
                          : 'text-[var(--text-soft)] hover:bg-white/10'
                      }`}
                      onClick={() => setPreviewMode('outline')}
                    >
                      Line
                    </button>
                    <button
                      type="button"
                      aria-pressed={previewMode === 'thread'}
                      className={`magpie-toggle-segment ${
                        previewMode === 'thread'
                          ? 'bg-[var(--accent-strong)] text-[#241625] shadow-[0_10px_28px_rgba(227,181,213,0.28)]'
                          : 'text-[var(--text-soft)] hover:bg-white/10'
                      }`}
                      onClick={() => setPreviewMode('thread')}
                    >
                      Threads
                    </button>
                    <button
                      type="button"
                      aria-pressed={showOutline}
                      className={`magpie-toggle-segment ${
                        showOutline
                          ? 'bg-[var(--accent-strong)] text-[#241625] shadow-[0_10px_28px_rgba(227,181,213,0.28)]'
                          : 'text-[var(--text-soft)] hover:bg-white/10'
                      }`}
                      onClick={() => setShowOutline((current) => !current)}
                    >
                      Outline
                    </button>
                  </div>
                )}
                {result && (
                  <div className="rounded-full border border-white/10 bg-white/[0.08] px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--text-soft)]">
                    {result.width} x {result.height}
                  </div>
                )}
              </div>
            </div>

            <div className="relative flex min-h-0 flex-1 items-stretch justify-stretch overflow-hidden p-4 lg:p-5">
              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(232,189,223,0.12),transparent_38%),radial-gradient(circle_at_bottom_right,rgba(170,174,235,0.12),transparent_28%),linear-gradient(135deg,rgba(255,255,255,0.04)_0%,transparent_42%)]" />

              {error && (
                <div className="relative z-10 max-w-xl rounded-[1.8rem] border border-rose-300/30 bg-rose-300/10 p-6 text-sm text-rose-50 shadow-[0_18px_48px_rgba(115,37,77,0.16)]">
                  <p className="magpie-label text-rose-100">Something Went Sideways</p>
                  <p className="mt-3 leading-7">{error}</p>
                </div>
              )}

              {!result && !error && (
                <div className="relative z-10 max-w-xl rounded-[2rem] border border-dashed border-white/15 bg-black/[0.18] px-8 py-10 text-center shadow-[0_20px_50px_rgba(10,6,16,0.18)]">
                  <p className="magpie-label text-[var(--accent-soft)]">No Photo Yet</p>
                  <h2 className="magpie-display mt-4 text-3xl font-semibold text-[var(--text-strong)]">
                    Load a photo.
                  </h2>
                  <p className="mt-4 text-base leading-7 text-[var(--text-soft)]">
                    Then generate the pattern.
                  </p>
                </div>
              )}

              {result && activePreviewUrl && (
                <div className="relative z-10 flex h-full min-h-0 w-full">
                  {isPatternReady && result.stitchMap ? (
                    <>
                      <StitchMapViewer
                        stitchMap={result.stitchMap}
                        palette={result.palette}
                        previewMode={previewMode}
                        showOutline={showOutline}
                        lineThickness={result.metrics?.lineThickness ?? lineThickness}
                        isolatedPaletteId={isolatedPaletteId}
                        onPaletteSelect={togglePaletteIsolation}
                      />
                      {processing && (
                        <div className="pointer-events-none absolute right-4 top-4 z-20 rounded-full border border-white/10 bg-black/70 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.22em] text-[var(--text-soft)] shadow-[0_12px_30px_rgba(0,0,0,0.24)] backdrop-blur">
                          {currentStageLabel}
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      {processing ? (
                        <ProcessingPreview
                          fileName={result.fileName}
                          sourceImageUrl={result.sourceImageUrl}
                          progress={processingProgress}
                          stages={PROCESSING_STAGES}
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center rounded-[2rem] border border-white/10 bg-[#120d16]/88 p-4 shadow-[0_30px_80px_rgba(10,6,16,0.36)]">
                          <img
                            src={activePreviewUrl}
                            alt="Selected source image"
                            className="max-h-full max-w-full rounded-[1.4rem] object-contain shadow-[0_18px_50px_rgba(0,0,0,0.28)]"
                            onLoad={(event) => {
                              updateImageDimensions(
                                event.currentTarget.naturalWidth,
                                event.currentTarget.naturalHeight,
                              )
                            }}
                            onError={() => {
                              setError('That preview did not load cleanly.')
                            }}
                          />
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </section>

        <aside className="w-full shrink-0 lg:w-[20rem] xl:w-[21rem]">
          <div className="magpie-panel flex h-full flex-col overflow-hidden">
            <div className="border-b border-white/10 px-5 py-4">
              <p className="magpie-label">Settings</p>
              <p className="mt-2 text-sm leading-6 text-[var(--text-soft)]">
                Adjust thread count, outline weight, detail, and cleanup.
              </p>
            </div>

            <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
              <ControlSlider
                label="Threads"
                valueLabel={`${numColors}`}
                value={numColors}
                min={2}
                max={32}
                hint="More shades keep nuance. Fewer shades make it cleaner."
                minLabel="2"
                maxLabel="32"
                onChange={setNumColors}
              />

              <ControlSlider
                label="Outline"
                valueLabel={`${lineThickness}px`}
                value={lineThickness}
                min={1}
                max={10}
                hint="How bold the borders feel."
                minLabel="1"
                maxLabel="10"
                onChange={setLineThickness}
              />

              <ControlSlider
                label="Detail"
                valueLabel={`${downscaleMax}px`}
                value={downscaleMax}
                min={200}
                max={2400}
                step={100}
                hint="Higher keeps more of the original photo."
                minLabel="200"
                maxLabel="2400"
                onChange={setDownscaleMax}
              />

              <ControlSlider
                label="Speckle Cleanup"
                valueLabel={minRegionSize === 0 ? 'Off' : `${minRegionSize}px`}
                value={minRegionSize}
                min={0}
                max={500}
                step={10}
                hint="Softens tiny flecks into nearby color."
                minLabel="0"
                maxLabel="500"
                onChange={setMinRegionSize}
              />

              <div className="rounded-[1.7rem] border border-white/10 bg-black/[0.18] p-4 shadow-[0_16px_40px_rgba(12,7,18,0.16)]">
                <p className="magpie-label">Photo</p>
                <div className="mt-3 space-y-2 text-sm text-[var(--text-soft)]">
                  <p className="truncate text-[var(--text-strong)]">
                    {result ? result.fileName : 'Nothing chosen yet'}
                  </p>
                  <p className="text-[var(--text-muted)]">
                    {result
                      ? `${result.width} x ${result.height}${processing ? ' · processing' : isPatternReady ? ` · ${previewDisplayLabel}` : ''}`
                      : 'Choose a photo to load it here.'}
                  </p>
                  {result?.metrics && (
                    <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
                      {result.metrics.preview ? 'preview' : 'final'} · {Math.round(result.metrics.timings.totalMs)}
                      ms · {result.metrics.workingWidth} x {result.metrics.workingHeight} ·{' '}
                      {result.metrics.numColors} colors · {result.metrics.downscaleMax}px · min region{' '}
                      {result.metrics.minRegionSize}px
                    </p>
                  )}
                </div>
              </div>

              <div className="rounded-[1.7rem] border border-white/10 bg-black/[0.18] p-4 shadow-[0_16px_40px_rgba(12,7,18,0.16)]">
                <div className="flex items-center justify-between gap-3">
                  <p className="magpie-label">Threads</p>
                  <div className="flex items-center gap-2">
                    {isolatedPaletteId !== null && (
                      <button
                        type="button"
                        onClick={() => setIsolatedPaletteId(null)}
                        disabled={processing}
                        className="magpie-button border-white/10 bg-white/[0.08] px-3 py-1.5 text-[10px] text-[var(--text-strong)] hover:border-white/25 hover:bg-white/12"
                      >
                        Show All
                      </button>
                    )}
                    <span className="font-mono text-xs text-[var(--text-muted)]">
                      {processing ? currentStageLabel : hasPalette ? `${result?.palette.length} shades` : 'Waiting'}
                    </span>
                  </div>
                </div>

                {processing && (
                  <p className="mt-3 text-sm leading-6 text-[var(--text-soft)]">
                    {processingHint}
                  </p>
                )}

                {!processing && !hasPalette && (
                  <p className="mt-3 text-sm leading-6 text-[var(--text-soft)]">
                    Generate a pattern to see the thread list.
                  </p>
                )}

                {!processing && hasPalette && result && (
                  <div className="mt-4 space-y-2">
                    <p className="text-xs leading-5 text-[var(--text-muted)]">
                      Largest coverage first. Select a thread to isolate it in the pattern view.
                    </p>
                    {sortedPalette.map((entry) => (
                      <button
                        type="button"
                        key={entry.pal_id}
                        onClick={() => togglePaletteIsolation(entry.pal_id)}
                        className={`flex w-full items-center gap-3 rounded-[1.25rem] border px-3 py-2 text-left transition duration-200 ${
                          isolatedPaletteId === entry.pal_id
                            ? 'border-[var(--accent-strong)]/45 bg-[var(--accent-strong)]/14 shadow-[0_14px_30px_rgba(214,166,201,0.14)]'
                            : 'border-white/8 bg-white/[0.06] hover:border-white/18 hover:bg-white/10'
                        }`}
                        aria-pressed={isolatedPaletteId === entry.pal_id}
                      >
                        <span className="w-7 shrink-0 text-right font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
                          {entry.pal_id}
                        </span>
                        <div
                          className="h-10 w-10 shrink-0 rounded-[0.95rem] border border-black/20 shadow-inner"
                          style={{ backgroundColor: entry.dmc_hex }}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm text-[var(--text-strong)]">
                            {entry.dmc_number} {entry.dmc_name}
                          </p>
                          <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
                            {entry.dmc_hex} · {entry.region_count} cells
                          </p>
                        </div>
                        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
                          {isolatedPaletteId === entry.pal_id ? 'selected' : 'isolate'}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </aside>
      </main>

      <footer className="shrink-0 border-t border-white/10 bg-black/[0.18] px-6 py-3 backdrop-blur-2xl lg:px-8">
        <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-[var(--text-muted)] sm:flex-row sm:items-center sm:justify-between">
          <span>Magpie&apos;s Needle Painter</span>
          <span>{statusText}</span>
        </div>
      </footer>
    </div>
  )
}

export default App

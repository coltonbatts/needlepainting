import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open as dialogOpen } from '@tauri-apps/plugin-dialog'

interface PaletteEntry {
  pal_id: number
  dmc_number: string
  dmc_name: string
  dmc_hex: string
  centroid_r: number
  centroid_g: number
  centroid_b: number
  region_count: number
}

interface ResultState {
  sourceImageUrl: string
  outlineImageUrl: string | null
  threadPreviewImageUrl: string | null
  width: number
  height: number
  palette: PaletteEntry[]
  filePath: string
  fileName: string
}

interface ProcessImageResponse {
  image_data: number[]
  thread_preview_data: number[]
  palette: PaletteEntry[]
}

type PreviewImageResponse = number[]
type PreviewMode = 'outline' | 'thread'

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
  onChange: (value: number) => void
}

function getFileName(filePath: string) {
  const normalized = filePath.replace(/\\/g, '/')
  return normalized.split('/').pop() || filePath
}

function mimeTypeFromPath(filePath: string) {
  const normalized = filePath.toLowerCase()

  if (normalized.endsWith('.png')) return 'image/png'
  if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) return 'image/jpeg'
  if (normalized.endsWith('.webp')) return 'image/webp'
  if (normalized.endsWith('.bmp')) return 'image/bmp'
  if (normalized.endsWith('.tiff') || normalized.endsWith('.tif')) return 'image/tiff'

  return 'application/octet-stream'
}

function revokeBlobUrl(ref: { current: string | null }) {
  if (ref.current) {
    URL.revokeObjectURL(ref.current)
    ref.current = null
  }
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
  onChange,
}: SliderProps) {
  return (
    <div className="rounded-3xl border border-white/8 bg-black/20 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <label className="magpie-label">{label}</label>
        <span className="font-mono text-sm text-stone-100">{valueLabel}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="magpie-range"
      />
      <div className="mt-3 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.18em] text-stone-500">
        <span>{minLabel}</span>
        <span>{maxLabel}</span>
      </div>
      <p className="mt-2 text-sm leading-6 text-stone-400">{hint}</p>
    </div>
  )
}

function App() {
  const [numColors, setNumColors] = useState(12)
  const [lineThickness, setLineThickness] = useState(3)
  const [downscaleMax, setDownscaleMax] = useState(800)
  const [minRegionSize, setMinRegionSize] = useState(50)
  const [previewMode, setPreviewMode] = useState<PreviewMode>('outline')
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ResultState | null>(null)
  const sourceBlobUrlRef = useRef<string | null>(null)
  const outlineBlobUrlRef = useRef<string | null>(null)
  const threadPreviewBlobUrlRef = useRef<string | null>(null)
  const hasPalette = Boolean(result && result.palette.length > 0)
  const hasGeneratedPreview = Boolean(
    result && result.outlineImageUrl && result.threadPreviewImageUrl && result.palette.length > 0,
  )
  const activePreviewUrl = result
    ? hasGeneratedPreview
      ? previewMode === 'thread'
        ? result.threadPreviewImageUrl
        : result.outlineImageUrl
      : result.sourceImageUrl
    : null

  useEffect(() => {
    return () => {
      revokeBlobUrl(sourceBlobUrlRef)
      revokeBlobUrl(outlineBlobUrlRef)
      revokeBlobUrl(threadPreviewBlobUrlRef)
    }
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
    if (!result?.filePath) return

    setProcessing(true)
    setError(null)

    try {
      const res = await invoke('process_image', {
        imagePath: result.filePath,
        numColors,
        lineThickness,
        downscaleMax,
        minRegionSize,
      }) as ProcessImageResponse

      const outlineUrl = URL.createObjectURL(
        new Blob([new Uint8Array(res.image_data)], { type: 'image/png' }),
      )
      const threadPreviewUrl = URL.createObjectURL(
        new Blob([new Uint8Array(res.thread_preview_data)], { type: 'image/png' }),
      )
      revokeBlobUrl(outlineBlobUrlRef)
      revokeBlobUrl(threadPreviewBlobUrlRef)
      outlineBlobUrlRef.current = outlineUrl
      threadPreviewBlobUrlRef.current = threadPreviewUrl
      setPreviewMode('outline')

      setResult((prev) =>
        prev
          ? {
              ...prev,
              outlineImageUrl: outlineUrl,
              threadPreviewImageUrl: threadPreviewUrl,
              width: 0,
              height: 0,
              palette: res.palette,
            }
          : null,
      )
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e)
      setError(errMsg)
    } finally {
      setProcessing(false)
    }
  }, [result?.filePath, numColors, lineThickness, downscaleMax, minRegionSize])

  const handlePickFile = useCallback(async () => {
    setError(null)

    try {
      const selected = await dialogOpen({
        title: 'Select an image to convert',
        multiple: false,
        filters: [{
          name: 'Image',
          extensions: ['png', 'jpg', 'jpeg', 'bmp', 'tiff', 'webp'],
        }],
      })

      if (typeof selected === 'string') {
        const previewBytes = await invoke('load_image_preview', {
          imagePath: selected,
        }) as PreviewImageResponse
        const previewUrl = URL.createObjectURL(
          new Blob([new Uint8Array(previewBytes)], {
            type: mimeTypeFromPath(selected),
          }),
        )
        revokeBlobUrl(sourceBlobUrlRef)
        revokeBlobUrl(outlineBlobUrlRef)
        revokeBlobUrl(threadPreviewBlobUrlRef)
        sourceBlobUrlRef.current = previewUrl
        setPreviewMode('outline')

        setResult({
          sourceImageUrl: previewUrl,
          outlineImageUrl: null,
          threadPreviewImageUrl: null,
          width: 0,
          height: 0,
          palette: [],
          filePath: selected,
          fileName: getFileName(selected),
        })
      }
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e)
      setError(`Failed to open image: ${errMsg}`)
    }
  }, [])

  return (
    <div className="flex min-h-screen flex-col bg-transparent text-stone-100">
      <header className="shrink-0 border-b border-white/10 bg-black/30 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-[1800px] flex-col gap-4 px-6 py-5 lg:px-8">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="space-y-2">
              <p className="font-mono text-[11px] uppercase tracking-[0.36em] text-amber-300/80">
                Embroidery Needle Painting Studio
              </p>
              <div className="flex flex-wrap items-baseline gap-3">
                <h1 className="font-['Avenir_Next'] text-3xl font-semibold tracking-[0.18em] text-white">
                  MAGPIE
                </h1>
                <span className="rounded-full border border-amber-400/30 bg-amber-300/10 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.22em] text-amber-100">
                  Outline + DMC Match
                </span>
              </div>
              <p className="max-w-3xl text-sm leading-6 text-stone-400">
                Convert a source image into a black-line coloring sheet, reduce noise,
                and map every quantized tone to the nearest DMC floss.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <button
                onClick={handlePickFile}
                className="magpie-button border-white/15 bg-white/[0.03] text-stone-100 hover:border-white/30 hover:bg-white/[0.09]"
              >
                Open Image
              </button>
              <button
                onClick={handleProcess}
                disabled={!result?.filePath || processing}
                className="magpie-button border-amber-300/40 bg-amber-300 text-black shadow-[0_0_30px_rgba(245,158,11,0.22)] hover:-translate-y-px hover:bg-amber-200"
              >
                {processing ? 'Generating' : 'Generate'}
              </button>
              {hasPalette && result && (
                <a
                  href={activePreviewUrl ?? result.outlineImageUrl ?? result.sourceImageUrl}
                  download={
                    previewMode === 'thread'
                      ? `magpie-thread-preview-${numColors}-colors.png`
                      : `magpie-coloring-book-${numColors}-colors.png`
                  }
                  className="magpie-button border-emerald-400/35 bg-emerald-400/10 text-emerald-100 hover:border-emerald-300/60 hover:bg-emerald-400/18"
                >
                  Save PNG
                </a>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[1800px] flex-1 flex-col gap-6 overflow-hidden px-6 py-6 lg:flex-row lg:px-8">
        <section className="flex min-h-[420px] flex-1 flex-col overflow-hidden">
          <div className="magpie-panel flex h-full flex-col overflow-hidden">
            <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
              <div>
                <p className="magpie-label">
                  {hasGeneratedPreview
                    ? previewMode === 'thread'
                      ? 'Thread-Color Preview'
                      : 'Coloring Book Preview'
                    : 'Source Preview'}
                </p>
                <p className="mt-1 text-sm text-stone-400">
                  {result
                    ? `${result.fileName}${hasGeneratedPreview ? ' processed for stitch planning' : ' ready for processing'}`
                    : 'Load a source image to begin the conversion pipeline.'}
                </p>
              </div>
              <div className="flex items-center gap-3">
                {hasGeneratedPreview && (
                  <div
                    className="inline-flex rounded-full border border-white/10 bg-black/25 p-1"
                    aria-label="Preview mode"
                  >
                    <button
                      type="button"
                      aria-pressed={previewMode === 'outline'}
                      className={`magpie-toggle-segment ${
                        previewMode === 'outline'
                          ? 'bg-amber-300 text-black shadow-[0_8px_24px_rgba(245,158,11,0.28)]'
                          : 'text-stone-300 hover:bg-white/[0.06]'
                      }`}
                      onClick={() => setPreviewMode('outline')}
                    >
                      Outline
                    </button>
                    <button
                      type="button"
                      aria-pressed={previewMode === 'thread'}
                      className={`magpie-toggle-segment ${
                        previewMode === 'thread'
                          ? 'bg-amber-300 text-black shadow-[0_8px_24px_rgba(245,158,11,0.28)]'
                          : 'text-stone-300 hover:bg-white/[0.06]'
                      }`}
                      onClick={() => setPreviewMode('thread')}
                    >
                      Thread Colors
                    </button>
                  </div>
                )}
                {result && (
                  <div className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 font-mono text-[10px] uppercase tracking-[0.22em] text-stone-300">
                    {result.width} x {result.height}
                  </div>
                )}
              </div>
            </div>

            <div className="relative flex flex-1 items-center justify-center overflow-auto p-6">
              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.06),transparent_42%),linear-gradient(135deg,rgba(255,255,255,0.05)_0%,transparent_40%)]" />

              {error && (
                <div className="relative z-10 max-w-xl rounded-3xl border border-rose-400/25 bg-rose-500/10 p-6 text-sm text-rose-100 shadow-[0_0_40px_rgba(244,63,94,0.12)]">
                  <p className="magpie-label text-rose-200">Processing Error</p>
                  <p className="mt-3 leading-7">{error}</p>
                </div>
              )}

              {!result && !error && (
                <div className="relative z-10 max-w-xl rounded-[2rem] border border-dashed border-white/15 bg-black/20 px-8 py-10 text-center">
                  <p className="magpie-label text-amber-200">Awaiting Source Image</p>
                  <h2 className="mt-4 text-3xl font-semibold text-white">
                    Build a stitch-ready coloring book from any photo.
                  </h2>
                  <p className="mt-4 text-base leading-7 text-stone-400">
                    Open an image, tune the quantization controls, then generate a clean
                    high-contrast outline with a matched DMC floss palette.
                  </p>
                </div>
              )}

              {result && activePreviewUrl && (
                <div className="relative z-10 flex max-h-full w-full justify-center">
                  <div className="rounded-[2rem] border border-white/10 bg-stone-950/90 p-4 shadow-[0_30px_80px_rgba(0,0,0,0.55)]">
                    <img
                      src={activePreviewUrl}
                      alt={
                        hasGeneratedPreview
                          ? previewMode === 'thread'
                            ? 'Generated thread color preview'
                            : 'Generated coloring book output'
                          : 'Selected source image'
                      }
                      className="max-h-[70vh] max-w-full rounded-[1.25rem] object-contain"
                      style={{ imageRendering: hasGeneratedPreview ? 'pixelated' : 'auto' }}
                      onLoad={(event) => {
                        updateImageDimensions(
                          event.currentTarget.naturalWidth,
                          event.currentTarget.naturalHeight,
                        )
                      }}
                      onError={() => {
                        setError(
                          hasGeneratedPreview
                            ? previewMode === 'thread'
                              ? 'Generated thread-color preview failed to load.'
                              : 'Generated outline preview failed to load.'
                            : 'Selected image preview failed to load.',
                        )
                      }}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>

        <aside className="w-full shrink-0 lg:w-[24rem]">
          <div className="magpie-panel flex h-full flex-col overflow-hidden">
            <div className="border-b border-white/10 px-5 py-4">
              <p className="magpie-label">Processing Controls</p>
              <p className="mt-2 text-sm leading-6 text-stone-400">
                Balance color count, line weight, scaling, and noise cleanup before
                generating the outline.
              </p>
            </div>

            <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
              <ControlSlider
                label="Colors"
                valueLabel={`${numColors}`}
                value={numColors}
                min={2}
                max={32}
                hint="Higher counts preserve tonal nuance; lower counts simplify the embroidery palette."
                minLabel="2"
                maxLabel="32"
                onChange={setNumColors}
              />

              <ControlSlider
                label="Line Thickness"
                valueLabel={`${lineThickness}px`}
                value={lineThickness}
                min={1}
                max={10}
                hint="Controls boundary weight in the generated coloring sheet."
                minLabel="1"
                maxLabel="10"
                onChange={setLineThickness}
              />

              <ControlSlider
                label="Resolution"
                valueLabel={`${downscaleMax}px`}
                value={downscaleMax}
                min={200}
                max={2400}
                step={100}
                hint="Larger values keep more detail but increase processing time."
                minLabel="200"
                maxLabel="2400"
                onChange={setDownscaleMax}
              />

              <ControlSlider
                label="Min Region Size"
                valueLabel={minRegionSize === 0 ? 'Off' : `${minRegionSize}px`}
                value={minRegionSize}
                min={0}
                max={500}
                step={10}
                hint="Merge isolated speckles into neighboring regions to keep the pattern readable."
                minLabel="0"
                maxLabel="500"
                onChange={setMinRegionSize}
              />

              <div className="rounded-3xl border border-white/8 bg-black/20 p-4">
                <p className="magpie-label">Loaded Image</p>
                <div className="mt-3 space-y-2 text-sm text-stone-300">
                  <p className="truncate text-stone-100">
                    {result ? result.fileName : 'No file selected'}
                  </p>
                  <p className="text-stone-500">
                    {result
                      ? `Current preview: ${result.width} x ${result.height}${hasGeneratedPreview ? ` · ${previewMode === 'thread' ? 'thread colors' : 'outline'}` : ''}`
                      : 'Open an image to populate the preview and enable generation.'}
                  </p>
                </div>
              </div>

              <div className="rounded-3xl border border-white/8 bg-black/20 p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="magpie-label">DMC Palette</p>
                  <span className="font-mono text-xs text-stone-500">
                    {hasPalette ? `${result?.palette.length} colors` : 'Pending'}
                  </span>
                </div>

                {!hasPalette && (
                  <p className="mt-3 text-sm leading-6 text-stone-400">
                    Generate the coloring book to see the matched floss palette and
                    region coverage data.
                  </p>
                )}

                {hasPalette && result && (
                  <div className="mt-4 space-y-2">
                    {result.palette.map((entry) => (
                      <div
                        key={entry.pal_id}
                        className="flex items-center gap-3 rounded-2xl border border-white/6 bg-white/[0.03] px-3 py-2"
                      >
                        <span className="w-7 shrink-0 text-right font-mono text-[10px] uppercase tracking-[0.18em] text-stone-500">
                          {entry.pal_id}
                        </span>
                        <div
                          className="h-10 w-10 shrink-0 rounded-xl border border-black/30 shadow-inner"
                          style={{ backgroundColor: entry.dmc_hex }}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm text-stone-100">
                            {entry.dmc_number} {entry.dmc_name}
                          </p>
                          <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.18em] text-stone-500">
                            {entry.dmc_hex} · {entry.region_count} px
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </aside>
      </main>

      <footer className="shrink-0 border-t border-white/10 bg-black/25 px-6 py-3 backdrop-blur-xl lg:px-8">
        <div className="mx-auto flex w-full max-w-[1800px] flex-col gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-stone-500 sm:flex-row sm:items-center sm:justify-between">
          <span>Magpie v0.1.0</span>
          <span>
            {processing
              ? 'Processing image'
              : hasPalette
                ? 'Outline and palette ready'
                : result
                  ? 'Source image loaded'
                  : 'Ready'}
          </span>
        </div>
      </footer>
    </div>
  )
}

export default App

import { memo, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { PaletteEntry, PreviewMode, StitchMapData } from '../types'

interface StitchMapViewerProps {
  stitchMap: StitchMapData
  palette: PaletteEntry[]
  previewMode: PreviewMode
  showOutline: boolean
  lineThickness: number
  isolatedPaletteId: number | null
  onPaletteSelect: (paletteId: number | null) => void
}

interface ViewState {
  scale: number
  offsetX: number
  offsetY: number
}

interface ViewportSize {
  width: number
  height: number
}

interface HoveredCell {
  x: number
  y: number
  paletteIndex: number
}

const FIT_PADDING = 28
const MIN_SCALE = 0.1
const MAX_SCALE = 128
const GRID_ZOOM_THRESHOLD = 12
const LABEL_ZOOM_THRESHOLD = 26
const LABEL_DRAW_LIMIT = 3200
const DRAG_THRESHOLD = 4
const FIT_VERTICAL_BIAS = 0.18
const ISOLATED_OUTLINE_FILL = 26
const ISOLATED_THREAD_FILL = [18, 19, 22] as const
const OUTLINE_SUPERSAMPLE = 2

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function parseHexColor(entry: PaletteEntry) {
  const normalized = entry.dmc_hex.trim().replace('#', '')
  if (normalized.length !== 6) {
    return [entry.centroid_r, entry.centroid_g, entry.centroid_b] as const
  }

  const r = Number.parseInt(normalized.slice(0, 2), 16)
  const g = Number.parseInt(normalized.slice(2, 4), 16)
  const b = Number.parseInt(normalized.slice(4, 6), 16)

  if ([r, g, b].some((value) => Number.isNaN(value))) {
    return [entry.centroid_r, entry.centroid_g, entry.centroid_b] as const
  }

  return [r, g, b] as const
}

function createFitView(
  viewport: ViewportSize,
  width: number,
  height: number,
): ViewState {
  const safeWidth = Math.max(width, 1)
  const safeHeight = Math.max(height, 1)
  const availableWidth = Math.max(viewport.width - FIT_PADDING * 2, 1)
  const availableHeight = Math.max(viewport.height - FIT_PADDING * 2, 1)
  const scale = clamp(
    Math.min(availableWidth / safeWidth, availableHeight / safeHeight),
    MIN_SCALE,
    MAX_SCALE,
  )
  const horizontalSlack = Math.max(viewport.width - safeWidth * scale, 0)
  const verticalSlack = Math.max(viewport.height - safeHeight * scale, 0)

  return {
    scale,
    offsetX: horizontalSlack / 2,
    offsetY: FIT_PADDING + verticalSlack * FIT_VERTICAL_BIAS,
  }
}

function createCenteredView(
  viewport: ViewportSize,
  width: number,
  height: number,
  scale: number,
): ViewState {
  const nextScale = clamp(scale, MIN_SCALE, MAX_SCALE)

  return {
    scale: nextScale,
    offsetX: (viewport.width - width * nextScale) / 2,
    offsetY: (viewport.height - height * nextScale) / 2,
  }
}

function getHoveredCell(
  pointX: number,
  pointY: number,
  view: ViewState,
  stitchMap: StitchMapData,
): HoveredCell | null {
  if (view.scale <= 0) {
    return null
  }

  const imageX = Math.floor((pointX - view.offsetX) / view.scale)
  const imageY = Math.floor((pointY - view.offsetY) / view.scale)

  if (
    imageX < 0 ||
    imageY < 0 ||
    imageX >= stitchMap.width ||
    imageY >= stitchMap.height
  ) {
    return null
  }

  const paletteIndex = stitchMap.labels[imageY * stitchMap.width + imageX]

  if (paletteIndex === undefined) {
    return null
  }

  return { x: imageX, y: imageY, paletteIndex }
}

function shouldUseDarkText([r, g, b]: readonly [number, number, number]) {
  return r * 0.299 + g * 0.587 + b * 0.114 > 160
}

function areHoveredCellsEqual(a: HoveredCell | null, b: HoveredCell | null) {
  if (a === b) {
    return true
  }

  if (!a || !b) {
    return false
  }

  return a.x === b.x && a.y === b.y && a.paletteIndex === b.paletteIndex
}

export const StitchMapViewer = memo(function StitchMapViewer({
  stitchMap,
  palette,
  previewMode,
  showOutline,
  lineThickness,
  isolatedPaletteId,
  onPaletteSelect,
}: StitchMapViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const outlineCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const threadCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const selectionMaskCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const boundaryMaskRef = useRef<Uint8Array | null>(null)
  const paletteColorsRef = useRef<ReadonlyArray<readonly [number, number, number]>>([])
  const [viewport, setViewport] = useState<ViewportSize>({ width: 0, height: 0 })
  const [view, setView] = useState<ViewState>({ scale: 1, offsetX: 0, offsetY: 0 })
  const [hoveredCell, setHoveredCell] = useState<HoveredCell | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [showGrid, setShowGrid] = useState(false)
  const [showLabels, setShowLabels] = useState(true)
  const dragStateRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    originX: number
    originY: number
    moved: boolean
  } | null>(null)

  useEffect(() => {
    const element = containerRef.current

    if (!element) {
      return
    }

    const updateSize = () => {
      const nextViewport = {
        width: Math.floor(element.clientWidth),
        height: Math.floor(element.clientHeight),
      }
      setViewport((current) =>
        current.width === nextViewport.width && current.height === nextViewport.height
          ? current
          : nextViewport,
      )
    }

    updateSize()

    const observer = new ResizeObserver(updateSize)
    observer.observe(element)

    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!viewport.width || !viewport.height) {
      return
    }

    setView(createFitView(viewport, stitchMap.width, stitchMap.height))
    setHoveredCell(null)
  }, [stitchMap.height, stitchMap.width, viewport.height, viewport.width])

  useEffect(() => {
    if (isolatedPaletteId === null) {
      selectionMaskCanvasRef.current = null
      return
    }

    const width = stitchMap.width
    const height = stitchMap.height
    const labels = stitchMap.labels
    const maskCanvas = document.createElement('canvas')
    const maskContext = maskCanvas.getContext('2d')

    if (!maskContext) {
      selectionMaskCanvasRef.current = null
      return
    }

    maskCanvas.width = width
    maskCanvas.height = height

    const maskImage = maskContext.createImageData(width, height)

    for (let index = 0; index < labels.length; index += 1) {
      if (labels[index] !== isolatedPaletteId) {
        continue
      }

      const dataOffset = index * 4
      maskImage.data[dataOffset] = 255
      maskImage.data[dataOffset + 1] = 255
      maskImage.data[dataOffset + 2] = 255
      maskImage.data[dataOffset + 3] = 255
    }

    maskContext.putImageData(maskImage, 0, 0)
    selectionMaskCanvasRef.current = maskCanvas
  }, [isolatedPaletteId, stitchMap.height, stitchMap.labels, stitchMap.width])

  useEffect(() => {
    const width = stitchMap.width
    const height = stitchMap.height
    const pixelCount = width * height
    const labels = stitchMap.labels
    const outlineWidth = width * OUTLINE_SUPERSAMPLE
    const outlineHeight = height * OUTLINE_SUPERSAMPLE
    const boundaryMask = new Uint8Array(pixelCount)
    const outlineCanvas = document.createElement('canvas')
    const outlineSupersampledCanvas = document.createElement('canvas')
    const threadCanvas = document.createElement('canvas')
    const outlineContext = outlineCanvas.getContext('2d')
    const outlineSupersampledContext = outlineSupersampledCanvas.getContext('2d')
    const threadContext = threadCanvas.getContext('2d')

    if (!outlineContext || !outlineSupersampledContext || !threadContext) {
      return
    }

    outlineCanvas.width = width
    outlineCanvas.height = height
    outlineSupersampledCanvas.width = outlineWidth
    outlineSupersampledCanvas.height = outlineHeight
    threadCanvas.width = width
    threadCanvas.height = height

    const outlineImage = outlineSupersampledContext.createImageData(outlineWidth, outlineHeight)
    const threadImage = threadContext.createImageData(width, height)
    const outlineColors = new Uint8Array(outlineWidth * outlineHeight)
    const paletteColors = palette.map(parseHexColor)
    paletteColorsRef.current = paletteColors

    for (let index = 0; index < pixelCount; index += 1) {
      const x = index % width
      const y = Math.floor(index / width)
      const blockX = x * OUTLINE_SUPERSAMPLE
      const blockY = y * OUTLINE_SUPERSAMPLE
      const paletteIndex = labels[index] ?? 0
      const isVisible = true
      const color =
        paletteColors[paletteIndex] ??
        ([255, 255, 255] as const)

      for (let dy = 0; dy < OUTLINE_SUPERSAMPLE; dy += 1) {
        for (let dx = 0; dx < OUTLINE_SUPERSAMPLE; dx += 1) {
          const hiIndex = (blockY + dy) * outlineWidth + (blockX + dx)
          const dataOffset = hiIndex * 4
          outlineImage.data[dataOffset] = isVisible ? 255 : ISOLATED_OUTLINE_FILL
          outlineImage.data[dataOffset + 1] = isVisible ? 255 : ISOLATED_OUTLINE_FILL
          outlineImage.data[dataOffset + 2] = isVisible ? 255 : ISOLATED_OUTLINE_FILL
          outlineImage.data[dataOffset + 3] = 255
          outlineColors[hiIndex] = isVisible ? 1 : 0
        }
      }

      const dataOffset = index * 4
      threadImage.data[dataOffset] = isVisible ? color[0] : ISOLATED_THREAD_FILL[0]
      threadImage.data[dataOffset + 1] = isVisible ? color[1] : ISOLATED_THREAD_FILL[1]
      threadImage.data[dataOffset + 2] = isVisible ? color[2] : ISOLATED_THREAD_FILL[2]
      threadImage.data[dataOffset + 3] = 255
    }

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const base = y * width + x
        const label = labels[base]

        if (x + 1 < width && labels[base + 1] !== label) {
          for (let delta = 0; delta < lineThickness; delta += 1) {
            const paintX = x + delta
            if (paintX < width) {
              boundaryMask[y * width + paintX] = 1
              if (showOutline) {
                const hiPaintX = paintX * OUTLINE_SUPERSAMPLE
                const hiPaintY = y * OUTLINE_SUPERSAMPLE
                for (let dy = 0; dy < OUTLINE_SUPERSAMPLE; dy += 1) {
                  for (let dx = 0; dx < OUTLINE_SUPERSAMPLE; dx += 1) {
                    const hiIndex = (hiPaintY + dy) * outlineWidth + (hiPaintX + dx)
                    outlineColors[hiIndex] = 2
                  }
                }
              }
            }
          }
        }

        if (y + 1 < height && labels[base + width] !== label) {
          for (let delta = 0; delta < lineThickness; delta += 1) {
            const paintY = y + delta
            if (paintY < height) {
              boundaryMask[paintY * width + x] = 1
              if (showOutline) {
                const hiPaintX = x * OUTLINE_SUPERSAMPLE
                const hiPaintY = paintY * OUTLINE_SUPERSAMPLE
                for (let dy = 0; dy < OUTLINE_SUPERSAMPLE; dy += 1) {
                  for (let dx = 0; dx < OUTLINE_SUPERSAMPLE; dx += 1) {
                    const hiIndex = (hiPaintY + dy) * outlineWidth + (hiPaintX + dx)
                    outlineColors[hiIndex] = 2
                  }
                }
              }
            }
          }
        }
      }
    }

    for (let index = 0; index < outlineColors.length; index += 1) {
      if (outlineColors[index] !== 2) {
        continue
      }

      const dataOffset = index * 4
      outlineImage.data[dataOffset] = 0
      outlineImage.data[dataOffset + 1] = 0
      outlineImage.data[dataOffset + 2] = 0
    }

    for (let index = 0; index < pixelCount; index += 1) {
      if (!boundaryMask[index]) {
        continue
      }

      const dataOffset = index * 4
      if (showOutline) {
        threadImage.data[dataOffset] = 0
        threadImage.data[dataOffset + 1] = 0
        threadImage.data[dataOffset + 2] = 0
      }
    }

    outlineSupersampledContext.putImageData(outlineImage, 0, 0)
    outlineContext.imageSmoothingEnabled = true
    outlineContext.imageSmoothingQuality = 'high'
    outlineContext.drawImage(outlineSupersampledCanvas, 0, 0, width, height)
    threadContext.putImageData(threadImage, 0, 0)
    boundaryMaskRef.current = boundaryMask
    outlineCanvasRef.current = outlineCanvas
    threadCanvasRef.current = threadCanvas
  }, [lineThickness, palette, showOutline, stitchMap])

  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    const sourceCanvas =
      previewMode === 'thread' || !showOutline ? threadCanvasRef.current : outlineCanvasRef.current

    if (!canvas || !container || !sourceCanvas || !viewport.width || !viewport.height) {
      return
    }

    const context = canvas.getContext('2d')
    if (!context) {
      return
    }

    const dpr = window.devicePixelRatio || 1
    const pixelWidth = Math.floor(viewport.width * dpr)
    const pixelHeight = Math.floor(viewport.height * dpr)

    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth
      canvas.height = pixelHeight
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`
    }

    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.clearRect(0, 0, viewport.width, viewport.height)
    context.fillStyle = '#120d16'
    context.fillRect(0, 0, viewport.width, viewport.height)

    const selectionMaskCanvas = selectionMaskCanvasRef.current

    context.save()
    context.imageSmoothingEnabled = false
    context.translate(view.offsetX, view.offsetY)
    context.scale(view.scale, view.scale)
    const shouldIsolate = isolatedPaletteId !== null && selectionMaskCanvas

    if (shouldIsolate) {
      context.globalAlpha = 0.18
      context.drawImage(sourceCanvas, 0, 0)
      context.globalAlpha = 1
    } else {
      context.drawImage(sourceCanvas, 0, 0)
    }
    context.restore()

    if (shouldIsolate) {
      context.save()
      context.translate(view.offsetX, view.offsetY)
      context.scale(view.scale, view.scale)
      context.drawImage(sourceCanvas, 0, 0)
      context.globalCompositeOperation = 'destination-in'
      context.drawImage(selectionMaskCanvas, 0, 0)
      context.restore()
    }

    const startX = clamp(Math.floor((-view.offsetX) / view.scale), 0, stitchMap.width)
    const endX = clamp(
      Math.ceil((viewport.width - view.offsetX) / view.scale),
      0,
      stitchMap.width,
    )
    const startY = clamp(Math.floor((-view.offsetY) / view.scale), 0, stitchMap.height)
    const endY = clamp(
      Math.ceil((viewport.height - view.offsetY) / view.scale),
      0,
      stitchMap.height,
    )

    if (showGrid && view.scale >= GRID_ZOOM_THRESHOLD) {
      context.save()
      context.strokeStyle = 'rgba(255,255,255,0.22)'
      context.lineWidth = 1
      context.beginPath()

      for (let x = startX; x <= endX; x += 1) {
        const screenX = Math.round(view.offsetX + x * view.scale) + 0.5
        context.moveTo(screenX, 0)
        context.lineTo(screenX, viewport.height)
      }

      for (let y = startY; y <= endY; y += 1) {
        const screenY = Math.round(view.offsetY + y * view.scale) + 0.5
        context.moveTo(0, screenY)
        context.lineTo(viewport.width, screenY)
      }

      context.stroke()
      context.restore()
    }

    if (showLabels && view.scale >= LABEL_ZOOM_THRESHOLD) {
      const visibleCells = (endX - startX) * (endY - startY)
      if (visibleCells <= LABEL_DRAW_LIMIT) {
        const fontSize = clamp(view.scale * 0.34, 9, 18)
        context.save()
        context.textAlign = 'center'
        context.textBaseline = 'middle'
        context.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`

        for (let y = startY; y < endY; y += 1) {
          for (let x = startX; x < endX; x += 1) {
            const paletteIndex = stitchMap.labels[y * stitchMap.width + x]
            const entry = palette[paletteIndex]

            if (!entry || (isolatedPaletteId !== null && paletteIndex !== isolatedPaletteId)) {
              continue
            }

            const textX = view.offsetX + (x + 0.5) * view.scale
            const textY = view.offsetY + (y + 0.5) * view.scale
            const textColor =
              previewMode === 'thread'
                ? paletteColorsRef.current[paletteIndex] ?? ([255, 255, 255] as const)
                : ([255, 255, 255] as const)

            context.lineWidth = 3
            context.strokeStyle = shouldUseDarkText(textColor)
              ? 'rgba(255,255,255,0.9)'
              : 'rgba(0,0,0,0.8)'
            context.strokeText(entry.dmc_number, textX, textY)
            context.fillStyle = shouldUseDarkText(textColor) ? '#140e18' : '#fff7fc'
            context.fillText(entry.dmc_number, textX, textY)
          }
        }

        context.restore()
      }
    }

  }, [
    isolatedPaletteId,
    palette,
    previewMode,
    showOutline,
    showGrid,
    showLabels,
    stitchMap,
    view,
    viewport,
  ])

  const zoomAtPoint = (nextScale: number, anchorX: number, anchorY: number) => {
    setView((current) => {
      const clampedScale = clamp(nextScale, MIN_SCALE, MAX_SCALE)
      const imageX = (anchorX - current.offsetX) / current.scale
      const imageY = (anchorY - current.offsetY) / current.scale

      return {
        scale: clampedScale,
        offsetX: anchorX - imageX * clampedScale,
        offsetY: anchorY - imageY * clampedScale,
      }
    })
  }

  const handleZoomStep = (direction: 'in' | 'out') => {
    if (!viewport.width || !viewport.height) {
      return
    }

    const factor = direction === 'in' ? 1.25 : 0.8
    zoomAtPoint(view.scale * factor, viewport.width / 2, viewport.height / 2)
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const container = containerRef.current
    if (!container) {
      return
    }

    const rect = container.getBoundingClientRect()
    const pointX = event.clientX - rect.left
    const pointY = event.clientY - rect.top

    let nextView = view

    if (dragStateRef.current && dragStateRef.current.pointerId === event.pointerId) {
      if (
        !dragStateRef.current.moved &&
        (Math.abs(event.clientX - dragStateRef.current.startX) > DRAG_THRESHOLD ||
          Math.abs(event.clientY - dragStateRef.current.startY) > DRAG_THRESHOLD)
      ) {
        dragStateRef.current.moved = true
      }

      nextView = {
        scale: view.scale,
        offsetX: dragStateRef.current.originX + (event.clientX - dragStateRef.current.startX),
        offsetY: dragStateRef.current.originY + (event.clientY - dragStateRef.current.startY),
      }
      setView(nextView)
    }

    const nextHoveredCell = getHoveredCell(pointX, pointY, nextView, stitchMap)

    setHoveredCell((current) =>
      areHoveredCellsEqual(current, nextHoveredCell) ? current : nextHoveredCell,
    )
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return
    }

    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: view.offsetX,
      originY: view.offsetY,
      moved: false,
    }
    setIsDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragStateRef.current?.pointerId === event.pointerId) {
      const wasClick = !dragStateRef.current.moved
      dragStateRef.current = null
      setIsDragging(false)
      event.currentTarget.releasePointerCapture(event.pointerId)

      if (wasClick && hoveredCell) {
        onPaletteSelect(hoveredCell.paletteIndex)
      }
    }
  }

  const hoveredEntry = hoveredCell ? palette[hoveredCell.paletteIndex] : null
  const isolatedEntry =
    isolatedPaletteId === null ? null : palette.find((entry) => entry.pal_id === isolatedPaletteId) ?? null
  const labelsVisible = showLabels && view.scale >= LABEL_ZOOM_THRESHOLD
  const gridVisible = showGrid && view.scale >= GRID_ZOOM_THRESHOLD

  return (
    <div className="relative z-10 flex h-full min-h-0 w-full flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[1.4rem] border border-white/10 bg-black/[0.22] px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => handleZoomStep('out')}
            className="magpie-viewer-button"
            aria-label="Zoom out"
          >
            -
          </button>
          <button
            type="button"
            onClick={() => handleZoomStep('in')}
            className="magpie-viewer-button"
            aria-label="Zoom in"
          >
            +
          </button>
          <button
            type="button"
            onClick={() => setView(createFitView(viewport, stitchMap.width, stitchMap.height))}
            className="magpie-viewer-chip"
          >
            Fit
          </button>
          <button
            type="button"
            onClick={() =>
              setView(createCenteredView(viewport, stitchMap.width, stitchMap.height, 1))
            }
            className="magpie-viewer-chip"
          >
            1:1
          </button>
          <button
            type="button"
            onClick={() => setShowGrid((current) => !current)}
            className={`magpie-viewer-chip ${showGrid ? 'magpie-viewer-chip-active' : ''}`}
            aria-pressed={showGrid}
          >
            Grid
          </button>
          <button
            type="button"
            onClick={() => setShowLabels((current) => !current)}
            className={`magpie-viewer-chip ${showLabels ? 'magpie-viewer-chip-active' : ''}`}
            aria-pressed={showLabels}
          >
            Labels
          </button>
          {isolatedEntry && (
            <button
              type="button"
              onClick={() => onPaletteSelect(isolatedEntry.pal_id)}
              className="magpie-viewer-chip magpie-viewer-chip-active"
            >
              Show All
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--text-soft)]">
          <span>{Math.round(view.scale * 100)}%</span>
          <span className="text-[var(--text-muted)]">/</span>
          <span>{labelsVisible ? 'numbers on' : 'hover to inspect'}</span>
          <span className="text-[var(--text-muted)]">/</span>
          <span>{gridVisible ? 'grid on' : 'grid off'}</span>
          {isolatedEntry && (
            <>
              <span className="text-[var(--text-muted)]">/</span>
              <span className="text-[var(--accent-soft)]">{isolatedEntry.dmc_number} selected</span>
            </>
          )}
        </div>
      </div>

      <div
        ref={containerRef}
        className={`relative flex-1 overflow-hidden rounded-[2rem] border border-white/10 bg-[#120d16]/92 shadow-[0_30px_80px_rgba(10,6,16,0.4)] overscroll-contain touch-none ${
          isDragging ? 'cursor-grabbing' : 'cursor-grab'
        }`}
        onWheel={(event) => {
          event.preventDefault()
          const rect = event.currentTarget.getBoundingClientRect()
          const anchorX = event.clientX - rect.left
          const anchorY = event.clientY - rect.top
          const delta =
            event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * viewport.height : event.deltaY
          const clampedDelta = clamp(delta, -240, 240)
          const factor = Math.exp(-clampedDelta * 0.001)
          zoomAtPoint(view.scale * factor, anchorX, anchorY)
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={() => {
          if (!isDragging) {
            setHoveredCell(null)
          }
        }}
      >
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.03)_0%,transparent_18%),radial-gradient(circle_at_top,rgba(245,199,230,0.08),transparent_32%),radial-gradient(circle_at_bottom_right,rgba(184,190,223,0.07),transparent_24%)]" />
        <canvas ref={canvasRef} className="h-full w-full" />

        {hoveredCell && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute border-2 border-[rgba(245,199,230,0.95)] bg-[rgba(245,199,230,0.05)] shadow-[0_0_0_1px_rgba(18,13,22,0.3)]"
            style={{
              left: `${view.offsetX + hoveredCell.x * view.scale}px`,
              top: `${view.offsetY + hoveredCell.y * view.scale}px`,
              width: `${view.scale}px`,
              height: `${view.scale}px`,
            }}
          />
        )}

        <div className="pointer-events-none absolute bottom-4 left-4 right-4 flex flex-wrap items-end justify-between gap-3">
          <div className="rounded-[1.4rem] border border-white/10 bg-[#120d16]/78 px-4 py-3 shadow-[0_16px_40px_rgba(10,6,16,0.34)] backdrop-blur">
            {hoveredEntry && hoveredCell ? (
              <div className="flex items-center gap-3">
                <div
                  className="h-10 w-10 rounded-xl border border-black/40 shadow-inner"
                  style={{ backgroundColor: hoveredEntry.dmc_hex }}
                />
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-[var(--accent-soft)]">
                    Cell {hoveredCell.x}, {hoveredCell.y}
                  </p>
                  <p className="mt-1 text-sm text-[var(--text-strong)]">
                    {hoveredEntry.dmc_number} {hoveredEntry.dmc_name}
                  </p>
                  <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--text-muted)]">
                    {hoveredEntry.dmc_hex} · palette {hoveredEntry.pal_id}
                  </p>
                </div>
              </div>
            ) : (
              <>
                <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-[var(--accent-soft)]">
                  Stitch Details
                </p>
                <p className="mt-1 text-sm text-[var(--text-soft)]">
                  Hover a square to inspect it. Select a thread to isolate it.
                </p>
              </>
            )}
          </div>

          <div className="rounded-[1.4rem] border border-white/10 bg-[#120d16]/78 px-4 py-3 font-mono text-[10px] uppercase tracking-[0.22em] text-[var(--text-muted)] shadow-[0_16px_40px_rgba(10,6,16,0.34)] backdrop-blur">
            <p>{stitchMap.width} x {stitchMap.height} cells</p>
            <p className="mt-1">
              {previewMode === 'thread'
                ? showOutline
                  ? 'thread view'
                  : 'color only'
                : showOutline
                  ? 'line view'
                  : 'color only'}
            </p>
            <p className="mt-1">{showOutline ? 'outline on' : 'outline off'}</p>
            {isolatedEntry && <p className="mt-1 text-[var(--accent-soft)]">selected {isolatedEntry.dmc_number}</p>}
          </div>
        </div>
      </div>
    </div>
  )
})

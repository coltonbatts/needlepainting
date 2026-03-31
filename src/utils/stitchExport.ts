import type { PaletteEntry, PngExportVariant, StitchMapData } from '../types'

export interface BuildPatternPngOptions {
  variant: PngExportVariant
  includeLegend: boolean
  stitchMap: StitchMapData
  palette: PaletteEntry[]
  outlineImageUrl: string
  threadPreviewImageUrl: string
}

function parseHexRgb(entry: PaletteEntry): [number, number, number] {
  const normalized = entry.dmc_hex.trim().replace('#', '')
  if (normalized.length !== 6) {
    return [entry.centroid_r, entry.centroid_g, entry.centroid_b]
  }

  const r = Number.parseInt(normalized.slice(0, 2), 16)
  const g = Number.parseInt(normalized.slice(2, 4), 16)
  const b = Number.parseInt(normalized.slice(4, 6), 16)

  if ([r, g, b].some((value) => Number.isNaN(value))) {
    return [entry.centroid_r, entry.centroid_g, entry.centroid_b]
  }

  return [r, g, b]
}

function sortPaletteForLegend(palette: PaletteEntry[]): PaletteEntry[] {
  return [...palette].sort((a, b) => b.region_count - a.region_count || a.pal_id - b.pal_id)
}

/** Thread regions only (no black grid lines). Built from the same label buffer as the viewer. */
export function renderThreadFillCanvas(
  stitchMap: StitchMapData,
  palette: PaletteEntry[],
): HTMLCanvasElement {
  const { width, height, labels } = stitchMap
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('Canvas 2D context unavailable')
  }

  const imgData = ctx.createImageData(width, height)
  const colors = palette.map(parseHexRgb)
  const n = width * height

  for (let i = 0; i < n; i += 1) {
    const paletteIndex = labels[i] ?? 0
    const c = colors[paletteIndex] ?? ([255, 255, 255] as const)
    const o = i * 4
    imgData.data[o] = c[0]
    imgData.data[o + 1] = c[1]
    imgData.data[o + 2] = c[2]
    imgData.data[o + 3] = 255
  }

  ctx.putImageData(imgData, 0, 0)
  return canvas
}

async function decodeImageUrlToCanvas(url: string): Promise<HTMLCanvasElement> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to load image (${response.status})`)
  }

  const blob = await response.blob()
  const bitmap = await createImageBitmap(blob)

  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close()
    throw new Error('Canvas 2D context unavailable')
  }

  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  return canvas
}

async function patternCanvasForVariant(opts: BuildPatternPngOptions): Promise<{
  canvas: HTMLCanvasElement
  width: number
  height: number
}> {
  const { variant, stitchMap, palette, outlineImageUrl, threadPreviewImageUrl } = opts

  if (variant === 'thread_fill') {
    const canvas = renderThreadFillCanvas(stitchMap, palette)
    return { canvas, width: stitchMap.width, height: stitchMap.height }
  }

  const url = variant === 'line' ? outlineImageUrl : threadPreviewImageUrl
  const canvas = await decodeImageUrlToCanvas(url)
  return { canvas, width: canvas.width, height: canvas.height }
}

const LEGEND_WIDTH = 300
const LEGEND_PAD = 18
const LEGEND_ROW = 54
const LEGEND_TITLE_H = 32

function compositeWithLegend(
  patternCanvas: HTMLCanvasElement,
  patternWidth: number,
  patternHeight: number,
  palette: PaletteEntry[],
): HTMLCanvasElement {
  const sorted = sortPaletteForLegend(palette)
  const legendBodyHeight = LEGEND_TITLE_H + sorted.length * LEGEND_ROW
  const contentHeight = LEGEND_PAD * 2 + legendBodyHeight
  const totalHeight = Math.max(patternHeight, contentHeight)
  const totalWidth = patternWidth + LEGEND_WIDTH

  const out = document.createElement('canvas')
  out.width = totalWidth
  out.height = totalHeight
  const ctx = out.getContext('2d')
  if (!ctx) {
    throw new Error('Canvas 2D context unavailable')
  }

  ctx.fillStyle = '#120d16'
  ctx.fillRect(0, 0, totalWidth, out.height)

  ctx.drawImage(patternCanvas, 0, 0)

  const splitX = patternWidth
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(splitX + 0.5, 0)
  ctx.lineTo(splitX + 0.5, out.height)
  ctx.stroke()

  const legendX = splitX + LEGEND_PAD
  let y = LEGEND_PAD

  ctx.fillStyle = '#ebc1dd'
  ctx.font = '600 13px ui-sans-serif, system-ui, sans-serif'
  ctx.fillText('Thread legend', legendX, y + 14)
  y += LEGEND_TITLE_H

  for (const entry of sorted) {
    const [r, g, b] = parseHexRgb(entry)
    ctx.fillStyle = `rgb(${r},${g},${b})`
    ctx.fillRect(legendX, y + 8, 30, 30)
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)'
    ctx.strokeRect(legendX + 0.5, y + 8.5, 29, 29)

    ctx.fillStyle = '#fff8fd'
    ctx.font = '600 12px ui-monospace, SFMono-Regular, Menlo, Monaco, monospace'
    ctx.fillText(entry.dmc_number, legendX + 44, y + 22)

    ctx.fillStyle = '#cdbecb'
    ctx.font = '500 11px ui-sans-serif, system-ui, sans-serif'
    const maxNameLen = 26
    const name =
      entry.dmc_name.length > maxNameLen
        ? `${entry.dmc_name.slice(0, maxNameLen - 1)}…`
        : entry.dmc_name
    ctx.fillText(name, legendX + 44, y + 38)

    ctx.fillStyle = 'rgba(133, 117, 129, 0.95)'
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Monaco, monospace'
    ctx.fillText(`${entry.region_count} cells`, legendX + 44, y + 50)

    y += LEGEND_ROW
  }

  return out
}

export async function buildPatternExportBlob(opts: BuildPatternPngOptions): Promise<Blob> {
  const { canvas: patternCanvas, width: pw, height: ph } = await patternCanvasForVariant(opts)

  const finalCanvas = opts.includeLegend
    ? compositeWithLegend(patternCanvas, pw, ph, opts.palette)
    : patternCanvas

  return new Promise((resolve, reject) => {
    finalCanvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob)
        } else {
          reject(new Error('Failed to encode PNG'))
        }
      },
      'image/png',
      1,
    )
  })
}

export function pngExportFilename(
  variant: PngExportVariant,
  includeLegend: boolean,
  numColors: number,
): string {
  const base =
    variant === 'line'
      ? 'line-pattern'
      : variant === 'thread_outline'
        ? 'thread-colors-outline'
        : 'thread-colors-fill-only'
  const legend = includeLegend ? '-with-legend' : ''
  return `magpie-needle-painter-${base}${legend}-${numColors}.png`
}

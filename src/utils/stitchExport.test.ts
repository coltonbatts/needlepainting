import { describe, expect, it } from 'vitest'
import { pngExportFilename } from './stitchExport'

describe('pngExportFilename', () => {
  it('includes variant, legend flag, and thread count', () => {
    expect(pngExportFilename('line', false, 12)).toBe(
      'magpie-needle-painter-line-pattern-12.png',
    )
    expect(pngExportFilename('thread_outline', true, 8)).toBe(
      'magpie-needle-painter-thread-colors-outline-with-legend-8.png',
    )
    expect(pngExportFilename('thread_fill', false, 24)).toBe(
      'magpie-needle-painter-thread-colors-fill-only-24.png',
    )
  })
})

import { describe, expect, it } from 'vitest'
import { validateStitchMapLabelLength } from './stitchMapValidation'

describe('validateStitchMapLabelLength', () => {
  it('accepts exact width × height byte length', () => {
    expect(() => validateStitchMapLabelLength(10, 20, 200)).not.toThrow()
  })

  it('rejects truncated buffers', () => {
    expect(() => validateStitchMapLabelLength(10, 10, 99)).toThrow(/99/)
  })

  it('rejects non-positive dimensions', () => {
    expect(() => validateStitchMapLabelLength(0, 10, 0)).toThrow(/Invalid stitch dimensions/)
  })
})

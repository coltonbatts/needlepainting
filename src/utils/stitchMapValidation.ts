/**
 * Ensures the label buffer matches the stitch grid dimensions.
 * Prevents silent mis-renders when the labels file is truncated or corrupt.
 */
export function validateStitchMapLabelLength(
  width: number,
  height: number,
  labelByteLength: number,
): void {
  if (width <= 0 || height <= 0) {
    throw new Error(`Invalid stitch dimensions: ${width}×${height}`)
  }
  const expected = width * height
  if (labelByteLength !== expected) {
    throw new Error(
      `Stitch label file size mismatch: got ${labelByteLength} bytes, expected ${expected} (${width}×${height})`,
    )
  }
}

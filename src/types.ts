export interface PaletteEntry {
  pal_id: number
  dmc_number: string
  dmc_name: string
  dmc_hex: string
  centroid_r: number
  centroid_g: number
  centroid_b: number
  region_count: number
}

export interface StitchMapData {
  width: number
  height: number
  labels: number[]
}

export interface StageTimings {
  loadMs: number
  resizeMs: number
  quantizeMs: number
  floodFillMs: number
  renderMs: number
  pngEncodeMs: number
  totalMs: number
}

export interface ProcessMetrics {
  preview: boolean
  sourceWidth: number
  sourceHeight: number
  workingWidth: number
  workingHeight: number
  numColors: number
  downscaleMax: number
  minRegionSize: number
  effectiveMinRegionSize: number
  lineThickness: number
  timings: StageTimings
}

export type PreviewMode = 'outline' | 'thread'

export type ProcessingStage =
  | 'loading_image'
  | 'reducing_colors'
  | 'cleaning_regions'
  | 'matching_threads'
  | 'building_outlines'
  | 'preparing_preview'
  | 'complete'

export interface ProcessingStageDefinition {
  key: ProcessingStage
  label: string
}

export interface ProcessingProgressEvent {
  requestId: string
  stage: ProcessingStage
  label: string
  stageIndex: number
  totalStages: number
  progress: number
}

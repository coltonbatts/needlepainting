use image::{imageops::FilterType, GenericImageView, GrayImage, Rgba, RgbaImage};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Window};
use std::{
    fs,
    path::PathBuf,
    sync::OnceLock,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone, Deserialize)]
pub struct DMCColor {
    pub number: String,
    pub name: String,
    pub rgb: DMCRgb,
    pub hex: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DMCRgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

#[derive(Debug, Clone, Serialize)]
pub struct PaletteEntry {
    pub pal_id: u8,
    pub dmc_number: String,
    pub dmc_name: String,
    pub dmc_hex: String,
    pub centroid_r: u8,
    pub centroid_g: u8,
    pub centroid_b: u8,
    pub region_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ColoringBookResult {
    pub image_path: String,
    pub thread_preview_path: String,
    pub labels_path: String,
    pub width: u32,
    pub height: u32,
    pub palette: Vec<PaletteEntry>,
    pub metrics: RunMetrics,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageTimings {
    pub load_ms: f64,
    pub resize_ms: f64,
    pub quantize_ms: f64,
    pub flood_fill_ms: f64,
    pub render_ms: f64,
    pub png_encode_ms: f64,
    pub total_ms: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunMetrics {
    pub preview: bool,
    pub source_width: u32,
    pub source_height: u32,
    pub working_width: u32,
    pub working_height: u32,
    pub num_colors: u8,
    pub downscale_max: u32,
    pub min_region_size: usize,
    pub effective_min_region_size: usize,
    pub line_thickness: u32,
    pub timings: StageTimings,
}

#[derive(Clone, Copy)]
enum ProgressStage {
    LoadingImage,
    ReducingColors,
    CleaningRegions,
    MatchingThreads,
    BuildingOutlines,
    PreparingPreview,
    Complete,
}

impl ProgressStage {
    fn as_str(self) -> &'static str {
        match self {
            Self::LoadingImage => "loading_image",
            Self::ReducingColors => "reducing_colors",
            Self::CleaningRegions => "cleaning_regions",
            Self::MatchingThreads => "matching_threads",
            Self::BuildingOutlines => "building_outlines",
            Self::PreparingPreview => "preparing_preview",
            Self::Complete => "complete",
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload<'a> {
    request_id: &'a str,
    stage: &'static str,
    label: &'a str,
    stage_index: usize,
    total_stages: usize,
    progress: f32,
}

const TOTAL_PROGRESS_STAGES: usize = 6;
const PREVIEW_ITERATIONS: usize = 8;
const FINAL_ITERATIONS: usize = 20;
const PREVIEW_SCALE_FACTOR: f64 = 0.65;

struct CachedDmcLookup {
    colors: Vec<DMCColor>,
    labs: Vec<[f64; 3]>,
}

static DMC_LOOKUP: OnceLock<CachedDmcLookup> = OnceLock::new();

fn temp_output_path(prefix: &str, request_id: &str, suffix: &str) -> Result<PathBuf, String> {
    let mut dir = std::env::temp_dir();
    dir.push("magpie-needle-painter");
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create temp output directory: {}", e))?;

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_nanos();
    let sanitized_request_id = request_id
        .replace('/', "-")
        .replace('\\', "-")
        .replace(':', "-");
    dir.push(format!("{prefix}-{sanitized_request_id}-{nanos}.{suffix}"));
    Ok(dir)
}

fn write_png_to_temp(prefix: &str, request_id: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let path = temp_output_path(prefix, request_id, "png")?;
    fs::write(&path, bytes)
        .map_err(|e| format!("Failed to write PNG to temp file '{}': {}", path.display(), e))?;
    Ok(path)
}

fn write_labels_to_temp(prefix: &str, request_id: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let path = temp_output_path(prefix, request_id, "bin")?;
    fs::write(&path, bytes)
        .map_err(|e| format!("Failed to write labels to temp file '{}': {}", path.display(), e))?;
    Ok(path)
}

fn emit_progress(
    window: &Window,
    request_id: &str,
    stage: ProgressStage,
    stage_index: usize,
    stage_progress: f32,
    label: &str,
) -> Result<(), String> {
    let clamped_progress = stage_progress.clamp(0.0, 1.0);
    let completed_stages = stage_index.saturating_sub(1) as f32;
    let overall_progress = (completed_stages + clamped_progress) / TOTAL_PROGRESS_STAGES as f32;
    let normalized_stage_index = stage_index.min(TOTAL_PROGRESS_STAGES);

    window
        .emit(
            "pattern-progress",
            ProgressPayload {
                request_id,
                stage: stage.as_str(),
                label,
                stage_index: normalized_stage_index,
                total_stages: TOTAL_PROGRESS_STAGES,
                progress: overall_progress.clamp(0.0, 1.0),
            },
        )
        .map_err(|e| format!("Failed to emit progress update: {}", e))
}

// Load DMC data at compile time.
const DMC_JSON: &str = include_str!("../data/dmc-floss.json");

fn parse_dmc() -> Vec<DMCColor> {
    serde_json::from_str(DMC_JSON).expect("failed to parse DMC JSON")
}

fn dmc_lookup() -> &'static CachedDmcLookup {
    DMC_LOOKUP.get_or_init(|| {
        let colors = parse_dmc();
        let labs = colors
            .iter()
            .map(|c| rgb_to_lab(c.rgb.r, c.rgb.g, c.rgb.b))
            .collect();

        CachedDmcLookup { colors, labs }
    })
}

// --- Color science ---

fn rgb_to_lab(r: u8, g: u8, b: u8) -> [f64; 3] {
    let rlin = srgb_to_linear(r as f64 / 255.0);
    let glin = srgb_to_linear(g as f64 / 255.0);
    let blin = srgb_to_linear(b as f64 / 255.0);

    // sRGB to XYZ (D65)
    let x = rlin * 0.4124564 + glin * 0.3575761 + blin * 0.1804375;
    let y = rlin * 0.2126729 + glin * 0.7151522 + blin * 0.0721750;
    let z = rlin * 0.0193339 + glin * 0.1191920 + blin * 0.9503041;

    // XYZ to Lab (D65 reference)
    let fx = lab_f(x / 0.95047);
    let fy = lab_f(y / 1.00000);
    let fz = lab_f(z / 1.08883);

    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

fn srgb_to_linear(c: f64) -> f64 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

fn lab_f(t: f64) -> f64 {
    if t > 0.008856 {
        t.powf(1.0 / 3.0)
    } else {
        7.787 * t + 16.0 / 116.0
    }
}

fn delta_e(lab1: [f64; 3], lab2: [f64; 3]) -> f64 {
    ((lab1[0] - lab2[0]).powi(2) + (lab1[1] - lab2[1]).powi(2) + (lab1[2] - lab2[2]).powi(2)).sqrt()
}

// --- K-means quantization ---

fn kmeans_quantize(
    pixels: &[(u8, u8, u8)],
    k: usize,
    iterations: usize,
    mut on_iteration: impl FnMut(usize, usize),
) -> (Vec<(u8, u8, u8)>, Vec<u8>) {
    let n = pixels.len();
    if k < 1 || n == 0 {
        return (vec![], vec![]);
    }

    let mut rng = SimpleRng::from_seed(42);

    // Initialize centroids from random pixels
    let mut centroids: Vec<(u8, u8, u8)> = Vec::with_capacity(k);
    for _ in 0..k {
        centroids.push(pixels[rng.next() % n]);
    }

    let mut labels = vec![0u8; n];

    for iter in 0..iterations {
        // Assign step
        for (i, &px) in pixels.iter().enumerate() {
            let mut best_label = 0u8;
            let mut best_dist = f64::MAX;
            for (l, c) in centroids.iter().enumerate() {
                let d = rgb_dist_sq(px, *c);
                if d < best_dist {
                    best_dist = d;
                    best_label = l as u8;
                }
            }
            labels[i] = best_label;
        }

        // Update step
        let mut sums = vec![(0.0f64, 0.0f64, 0.0f64, 0usize); k];
        for (i, &px) in pixels.iter().enumerate() {
            let l = labels[i] as usize;
            if l < k {
                sums[l].0 += px.0 as f64;
                sums[l].1 += px.1 as f64;
                sums[l].2 += px.2 as f64;
                sums[l].3 += 1;
            }
        }
        for (l, c) in centroids.iter_mut().enumerate() {
            if sums[l].3 > 0 {
                *c = (
                    (sums[l].0 / sums[l].3 as f64).round() as u8,
                    (sums[l].1 / sums[l].3 as f64).round() as u8,
                    (sums[l].2 / sums[l].3 as f64).round() as u8,
                );
            }
        }

        on_iteration(iter + 1, iterations);
    }

    (centroids, labels)
}

fn rgb_dist_sq(a: (u8, u8, u8), b: (u8, u8, u8)) -> f64 {
    let dr = a.0 as f64 - b.0 as f64;
    let dg = a.1 as f64 - b.1 as f64;
    let db = a.2 as f64 - b.2 as f64;
    dr * dr + dg * dg + db * db
}

struct SimpleRng(u64);

impl SimpleRng {
    fn from_seed(s: u64) -> Self {
        Self(s | 1)
    }
    fn next(&mut self) -> usize {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0 = self.0.wrapping_mul(0x2545F4914F6CDD1D);
        self.0 as usize
    }
}

// --- Map centroids -> DMC ---

fn map_to_dmc(centroids: &[(u8, u8, u8)]) -> Vec<PaletteEntry> {
    let dmc = dmc_lookup();

    centroids
        .iter()
        .enumerate()
        .map(|(idx, &c)| {
            let cl = rgb_to_lab(c.0, c.1, c.2);
            let mut best_idx = 0usize;
            let mut best_dist = f64::MAX;
            for (i, &lab) in dmc.labs.iter().enumerate() {
                let d = delta_e(cl, lab);
                if d < best_dist {
                    best_dist = d;
                    best_idx = i;
                }
            }
            let best = &dmc.colors[best_idx];
            PaletteEntry {
                pal_id: idx as u8,
                dmc_number: best.number.clone(),
                dmc_name: best.name.clone(),
                dmc_hex: best.hex.clone(),
                centroid_r: c.0,
                centroid_g: c.1,
                centroid_b: c.2,
                region_count: 0, // computed downstream
            }
        })
        .collect()
}

fn parse_hex_rgb(hex: &str) -> Option<(u8, u8, u8)> {
    let hex = hex.trim().trim_start_matches('#');
    if hex.len() != 6 {
        return None;
    }

    let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
    let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
    let b = u8::from_str_radix(&hex[4..6], 16).ok()?;

    Some((r, g, b))
}

// --- Flood-fill connected regions, merge small regions into neighbors ---

fn flood_fill(
    width: u32,
    height: u32,
    labels: &[u8],
    min_region_size: usize,
) -> Result<Vec<u8>, String> {
    let n = (width * height) as usize;
    if labels.len() != n {
        return Err(format!(
            "Label buffer length {} does not match image size {}",
            labels.len(),
            n
        ));
    }

    let mut visited = vec![false; n];
    let mut region_id = vec![usize::MAX; n];
    let mut region_sizes: Vec<usize> = Vec::new();
    let mut regions: Vec<Vec<usize>> = Vec::new();
    let mut merge_map: Vec<u8> = Vec::new();

    for y in 0..height {
        for x in 0..width {
            let idx = (y * width + x) as usize;
            if visited[idx] {
                continue;
            }

            let label = labels[idx];
            let mut stack = vec![(x, y)];
            let mut pixels: Vec<usize> = Vec::new();

            visited[idx] = true;
            while let Some((cx, cy)) = stack.pop() {
                let ci = (cy * width + cx) as usize;
                pixels.push(ci);

                for (nx, ny) in [
                    (cx.wrapping_sub(1), cy),
                    (cx + 1, cy),
                    (cx, cy.wrapping_sub(1)),
                    (cx, cy + 1),
                ] {
                    if nx < width && ny < height {
                        let ni = (ny * width + nx) as usize;
                        if visited[ni] {
                            continue;
                        }
                        if labels[ni] == label {
                            visited[ni] = true;
                            stack.push((nx, ny));
                        }
                    }
                }
            }

            let rid = region_sizes.len();
            for &pi in &pixels {
                region_id[pi] = rid;
            }
            region_sizes.push(pixels.len());
            regions.push(pixels);
            merge_map.push(label);
        }
    }

    let mut final_labels = labels.to_vec();
    let num_regions = region_sizes.len();

    for rid in 0..num_regions {
        if region_sizes[rid] >= min_region_size {
            continue;
        }

        let mut neighbor_votes: Vec<usize> = vec![0; num_regions];
        for &pi in &regions[rid] {
            let x = (pi as u32) % width;
            let y = (pi as u32) / width;
            for (nx, ny) in [
                (x.wrapping_sub(1), y),
                (x + 1, y),
                (x, y.wrapping_sub(1)),
                (x, y + 1),
            ] {
                if nx < width && ny < height {
                    let ni = (ny * width + nx) as usize;
                    let nr = region_id[ni];
                    if nr != usize::MAX && nr < num_regions && nr != rid {
                        neighbor_votes[nr] += 1;
                    }
                }
            }
        }

        let Some((best_neighbor, best_votes)) = neighbor_votes
            .iter()
            .copied()
            .enumerate()
            .filter(|(i, _)| *i != rid)
            .max_by_key(|(_, votes)| *votes)
        else {
            continue;
        };

        if best_votes == 0 {
            continue;
        }

        let merged_label = merge_map[best_neighbor];
        merge_map[rid] = merged_label;

        for &pi in &regions[rid] {
            final_labels[pi] = merged_label;
        }
    }

    Ok(final_labels)
}

// --- Render coloring-book outline: black lines on white ---

fn draw_region_boundaries<F>(
    width: u32,
    height: u32,
    labels: &[u8],
    line_thickness: u32,
    mut paint: F,
) where
    F: FnMut(u32, u32),
{
    for y in 0..height {
        for x in 0..width {
            let base = (y * width + x) as usize;
            let label = labels[base];

            // Check right neighbor
            if x + 1 < width && labels[base + 1] != label {
                for dx in 0..line_thickness {
                    let px = x + dx;
                    if px < width {
                        paint(px, y);
                    }
                }
            }
            // Check bottom neighbor
            if y + 1 < height && labels[base + width as usize] != label {
                for dy in 0..line_thickness {
                    let py = y + dy;
                    if py < height {
                        paint(x, py);
                    }
                }
            }
        }
    }
}

fn render_coloring_book(width: u32, height: u32, labels: &[u8], line_thickness: u32) -> GrayImage {
    let mut out = GrayImage::from_pixel(width, height, image::Luma([255u8]));

    draw_region_boundaries(width, height, labels, line_thickness, |x, y| {
        *out.get_pixel_mut(x, y) = image::Luma([0u8]);
    });

    out
}

fn render_thread_preview(
    width: u32,
    height: u32,
    labels: &[u8],
    palette: &[PaletteEntry],
    line_thickness: u32,
) -> RgbaImage {
    let palette_colors: Vec<(u8, u8, u8)> = palette
        .iter()
        .map(|entry| {
            parse_hex_rgb(&entry.dmc_hex).unwrap_or((
                entry.centroid_r,
                entry.centroid_g,
                entry.centroid_b,
            ))
        })
        .collect();

    let mut out = RgbaImage::from_fn(width, height, |x, y| {
        let idx = (y * width + x) as usize;
        let label = labels.get(idx).copied().unwrap_or_default() as usize;
        let (r, g, b) = palette_colors
            .get(label)
            .copied()
            .unwrap_or((255, 255, 255));
        Rgba([r, g, b, 255])
    });

    draw_region_boundaries(width, height, labels, line_thickness, |x, y| {
        *out.get_pixel_mut(x, y) = Rgba([0, 0, 0, 255]);
    });

    out
}

/// Tauri command: load image -> quantize -> outline -> return PNG + DMC palette
#[tauri::command]
pub fn process_image(
    window: Window,
    image_path: String,
    request_id: String,
    num_colors: u8,
    line_thickness: u32,
    downscale_max: u32,
    min_region_size: usize,
    preview: bool,
) -> Result<ColoringBookResult, String> {
    let total_start = Instant::now();

    emit_progress(
        &window,
        &request_id,
        ProgressStage::LoadingImage,
        1,
        0.05,
        "Loading image",
    )?;

    let load_start = Instant::now();
    let img = image::open(&image_path).map_err(|e| format!("Failed to load image: {}", e))?;
    let load_ms = load_start.elapsed().as_secs_f64() * 1000.0;
    let (source_width, source_height) = img.dimensions();
    emit_progress(
        &window,
        &request_id,
        ProgressStage::LoadingImage,
        1,
        1.0,
        "Loading image",
    )?;

    let resize_start = Instant::now();
    let preview_max_dim = ((downscale_max as f64) * PREVIEW_SCALE_FACTOR).round() as u32;
    let max_dim = if preview {
        preview_max_dim.max(200)
    } else {
        downscale_max.max(200)
    };
    let (working_width, working_height) = if source_width > max_dim || source_height > max_dim {
        let s = max_dim as f64 / (source_width.max(source_height) as f64);
        (
            (source_width as f64 * s).round().max(1.0) as u32,
            (source_height as f64 * s).round().max(1.0) as u32,
        )
    } else {
        (source_width, source_height)
    };
    let filter = if preview {
        FilterType::Triangle
    } else {
        FilterType::Lanczos3
    };
    let img = img.resize_exact(working_width, working_height, filter);
    let rgb = img.to_rgb8();
    let resize_ms = resize_start.elapsed().as_secs_f64() * 1000.0;

    let pixels: Vec<(u8, u8, u8)> = rgb.pixels().map(|p| (p[0], p[1], p[2])).collect();

    emit_progress(
        &window,
        &request_id,
        ProgressStage::ReducingColors,
        2,
        0.05,
        "Reducing colors",
    )?;
    let quantize_start = Instant::now();
    let k = num_colors as usize;
    let iterations = if preview {
        PREVIEW_ITERATIONS
    } else {
        FINAL_ITERATIONS
    };
    let (centroids, labels) = kmeans_quantize(&pixels, k, iterations, |iteration, total_iterations| {
        let stage_progress = iteration as f32 / total_iterations.max(1) as f32;
        let _ = emit_progress(
            &window,
            &request_id,
            ProgressStage::ReducingColors,
            2,
            stage_progress,
            "Reducing colors",
        );
    });

    if centroids.is_empty() {
        return Err("Quantization produced no centroids".to_string());
    }
    let quantize_ms = quantize_start.elapsed().as_secs_f64() * 1000.0;

    emit_progress(
        &window,
        &request_id,
        ProgressStage::CleaningRegions,
        3,
        0.1,
        "Cleaning regions",
    )?;
    let flood_fill_start = Instant::now();
    let effective_min_region_size = if preview {
        min_region_size.saturating_add(min_region_size / 2).max(8)
    } else {
        min_region_size
    };
    let merged_labels =
        flood_fill(working_width, working_height, &labels, effective_min_region_size)?;
    let flood_fill_ms = flood_fill_start.elapsed().as_secs_f64() * 1000.0;
    emit_progress(
        &window,
        &request_id,
        ProgressStage::CleaningRegions,
        3,
        1.0,
        "Cleaning regions",
    )?;

    emit_progress(
        &window,
        &request_id,
        ProgressStage::MatchingThreads,
        4,
        0.1,
        "Matching threads",
    )?;
    let mut palette = map_to_dmc(&centroids);
    let mut counts = vec![0usize; centroids.len()];
    for &lab in &merged_labels {
        if (lab as usize) < counts.len() {
            counts[lab as usize] += 1;
        }
    }
    for pe in &mut palette {
        pe.region_count = counts[pe.pal_id as usize];
    }
    emit_progress(
        &window,
        &request_id,
        ProgressStage::MatchingThreads,
        4,
        1.0,
        "Matching threads",
    )?;

    emit_progress(
        &window,
        &request_id,
        ProgressStage::BuildingOutlines,
        5,
        0.1,
        "Building outlines",
    )?;
    let render_start = Instant::now();
    let coloring_book =
        render_coloring_book(working_width, working_height, &merged_labels, line_thickness);
    let thread_preview = render_thread_preview(
        working_width,
        working_height,
        &merged_labels,
        &palette,
        line_thickness,
    );
    let render_ms = render_start.elapsed().as_secs_f64() * 1000.0;
    emit_progress(
        &window,
        &request_id,
        ProgressStage::BuildingOutlines,
        5,
        1.0,
        "Building outlines",
    )?;

    emit_progress(
        &window,
        &request_id,
        ProgressStage::PreparingPreview,
        6,
        0.15,
        "Preparing preview",
    )?;
    let png_encode_start = Instant::now();
    let mut png_bytes = Vec::new();
    coloring_book
        .write_to(
            &mut std::io::Cursor::new(&mut png_bytes),
            image::ImageFormat::Png,
        )
        .map_err(|e| format!("PNG encode failed: {}", e))?;

    let mut thread_preview_bytes = Vec::new();
    thread_preview
        .write_to(
            &mut std::io::Cursor::new(&mut thread_preview_bytes),
            image::ImageFormat::Png,
        )
        .map_err(|e| format!("Thread preview PNG encode failed: {}", e))?;
    let image_path = write_png_to_temp("outline", &request_id, &png_bytes)?;
    let thread_preview_path = write_png_to_temp("thread", &request_id, &thread_preview_bytes)?;
    let labels_path = write_labels_to_temp("labels", &request_id, &merged_labels)?;
    let png_encode_ms = png_encode_start.elapsed().as_secs_f64() * 1000.0;

    emit_progress(
        &window,
        &request_id,
        ProgressStage::PreparingPreview,
        6,
        1.0,
        "Preparing preview",
    )?;
    emit_progress(
        &window,
        &request_id,
        ProgressStage::Complete,
        6,
        1.0,
        "Pattern ready",
    )?;

    let timings = StageTimings {
        load_ms,
        resize_ms,
        quantize_ms,
        flood_fill_ms,
        render_ms,
        png_encode_ms,
        total_ms: total_start.elapsed().as_secs_f64() * 1000.0,
    };
    let metrics = RunMetrics {
        preview,
        source_width,
        source_height,
        working_width,
        working_height,
        num_colors,
        downscale_max,
        min_region_size,
        effective_min_region_size,
        line_thickness,
        timings,
    };

    eprintln!(
        "[magpie] run request_id={} mode={} source={}x{} working={}x{} colors={} downscale_max={} min_region_size={} effective_min_region_size={} line_thickness={} load={:.1}ms resize={:.1}ms quantize={:.1}ms flood_fill={:.1}ms render={:.1}ms png_encode={:.1}ms total={:.1}ms",
        request_id,
        if preview { "preview" } else { "final" },
        source_width,
        source_height,
        working_width,
        working_height,
        num_colors,
        downscale_max,
        min_region_size,
        effective_min_region_size,
        line_thickness,
        metrics.timings.load_ms,
        metrics.timings.resize_ms,
        metrics.timings.quantize_ms,
        metrics.timings.flood_fill_ms,
        metrics.timings.render_ms,
        metrics.timings.png_encode_ms,
        metrics.timings.total_ms,
    );

    Ok(ColoringBookResult {
        image_path: image_path.to_string_lossy().into_owned(),
        thread_preview_path: thread_preview_path.to_string_lossy().into_owned(),
        labels_path: labels_path.to_string_lossy().into_owned(),
        width: working_width,
        height: working_height,
        palette,
        metrics,
    })
}

#[cfg(test)]
mod tests {
    use super::{flood_fill, render_thread_preview, PaletteEntry};

    #[test]
    fn flood_fill_should_merge_small_region_into_neighbor() {
        let labels = vec![1, 1, 2];

        let merged = flood_fill(3, 1, &labels, 2).expect("flood fill should succeed");

        assert_eq!(merged, vec![1, 1, 1]);
    }

    #[test]
    fn flood_fill_should_accept_more_than_255_regions() {
        let width = 32;
        let height = 32;
        let labels: Vec<u8> = (0..(width * height))
            .map(|idx| if idx % 2 == 0 { 0 } else { 1 })
            .collect();

        let merged = flood_fill(width, height, &labels, 2).expect("flood fill should succeed");

        assert_eq!(merged.len(), labels.len());
    }

    #[test]
    fn flood_fill_should_return_error_for_mismatched_label_buffer() {
        let err = flood_fill(2, 2, &[0, 1, 2], 1).expect_err("buffer mismatch should fail");

        assert!(err.contains("Label buffer length"));
    }

    #[test]
    fn thread_preview_should_fill_regions_with_dmc_hex_color() {
        let palette = vec![PaletteEntry {
            pal_id: 0,
            dmc_number: "321".into(),
            dmc_name: "Red".into(),
            dmc_hex: "#C53333".into(),
            centroid_r: 0,
            centroid_g: 0,
            centroid_b: 0,
            region_count: 1,
        }];

        let preview = render_thread_preview(1, 1, &[0], &palette, 1);

        assert_eq!(preview.get_pixel(0, 0).0, [0xC5, 0x33, 0x33, 255]);
    }

    #[test]
    fn thread_preview_should_keep_outline_on_region_boundaries() {
        let palette = vec![
            PaletteEntry {
                pal_id: 0,
                dmc_number: "321".into(),
                dmc_name: "Red".into(),
                dmc_hex: "#C53333".into(),
                centroid_r: 0,
                centroid_g: 0,
                centroid_b: 0,
                region_count: 1,
            },
            PaletteEntry {
                pal_id: 1,
                dmc_number: "996".into(),
                dmc_name: "Blue".into(),
                dmc_hex: "#30D5FF".into(),
                centroid_r: 0,
                centroid_g: 0,
                centroid_b: 0,
                region_count: 1,
            },
        ];

        let preview = render_thread_preview(2, 1, &[0, 1], &palette, 1);

        assert_eq!(preview.get_pixel(0, 0).0, [0, 0, 0, 255]);
        assert_eq!(preview.get_pixel(1, 0).0, [0x30, 0xD5, 0xFF, 255]);
    }
}

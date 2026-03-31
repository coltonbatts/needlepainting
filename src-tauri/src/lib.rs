mod image_process;

#[tauri::command]
fn load_image_preview(image_path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&image_path)
        .map_err(|e| format!("Failed to read preview image '{}': {}", image_path, e))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            load_image_preview,
            image_process::process_image
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

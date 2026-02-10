use std::sync::Mutex;

mod s3;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(s3::AppState {
            client: Mutex::new(None),
            credentials: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            s3::init_r2,
            s3::list_buckets,
            s3::list_objects,
            s3::delete_objects,
            s3::create_folder,
            s3::upload_file,
            s3::download_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

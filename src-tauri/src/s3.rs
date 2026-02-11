use aws_config::meta::region::RegionProviderChain;
use aws_sdk_s3::{Client, config::Region};
use aws_sdk_s3::primitives::ByteStream;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::State;

pub struct AppState {
    pub client: Mutex<Option<Client>>,
    pub credentials: Mutex<Option<(String, String, String)>>, // account_id, access_key, secret_key
}

#[tauri::command]
pub async fn init_r2(
    account_id: String,
    access_key: String,
    secret_key: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let region_provider = RegionProviderChain::default_provider().or_else(Region::new("auto"));
    let creds = aws_credential_types::Credentials::new(
        access_key.clone(),
        secret_key.clone(),
        None,
        None,
        "Static",
    );

    let config = aws_config::from_env()
        .region(region_provider)
        .endpoint_url(format!("https://{}.r2.cloudflarestorage.com", account_id))
        .credentials_provider(creds)
        .load()
        .await;

    let client = Client::new(&config);

    *state.client.lock().unwrap() = Some(client);
    *state.credentials.lock().unwrap() = Some((account_id, access_key, secret_key));

    Ok("Initialized".to_string())
}

#[tauri::command]
pub async fn list_buckets(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let client = {
        let guard = state.client.lock().unwrap();
        guard.as_ref().ok_or("Client not initialized")?.clone()
    };

    let resp = client.list_buckets().send().await.map_err(|e| e.to_string())?;
    
    let buckets = resp
        .buckets()
        .iter()
        .map(|b| b.name().unwrap_or_default().to_string())
        .collect();
    
    Ok(buckets)
}

use aws_sdk_s3::types::{ObjectIdentifier, Delete};

#[tauri::command]
pub async fn list_objects(
    bucket: String, 
    prefix: Option<String>, 
    delimiter: Option<String>,
    state: State<'_, AppState>
) -> Result<HashMap<String, Vec<HashMap<String, String>>>, String> {
    let client = {
        let guard = state.client.lock().unwrap();
        guard.as_ref().ok_or("Client not initialized")?.clone()
    };

    let resp = client.list_objects_v2()
        .bucket(bucket)
        .set_prefix(prefix)
        .set_delimiter(delimiter)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let objects: Vec<HashMap<String, String>> = resp
        .contents()
        .iter()
        .map(|o| {
            let mut map = HashMap::new();
            map.insert("key".to_string(), o.key().unwrap_or_default().to_string());
            map.insert("size".to_string(), o.size().unwrap_or_default().to_string());
            map.insert("last_modified".to_string(), o.last_modified().unwrap().to_string());
            map.insert("type".to_string(), "file".to_string());
            map
        })
        .collect();
    
    let folders: Vec<HashMap<String, String>> = resp
        .common_prefixes()
        .iter()
        .map(|p| {
             let mut map = HashMap::new();
             map.insert("key".to_string(), p.prefix().unwrap_or_default().to_string());
             map.insert("type".to_string(), "folder".to_string());
             map
        })
        .collect();

    let mut result = HashMap::new();
    result.insert("files".to_string(), objects);
    result.insert("folders".to_string(), folders);

    Ok(result)
}

#[tauri::command]
pub async fn create_folder(bucket: String, key: String, state: State<'_, AppState>) -> Result<(), String> {
    let client = {
       let guard = state.client.lock().unwrap();
       guard.as_ref().ok_or("Client not initialized")?.clone()
    };
    
    // Ensure key ends with /
    let folder_key = if key.ends_with('/') { key } else { format!("{}/", key) };

    client.put_object()
        .bucket(bucket)
        .key(folder_key)
        .body(ByteStream::from_static(&[]))
        .send()
        .await
        .map_err(|e| e.to_string())?;
        
    Ok(())
}

#[tauri::command]
pub async fn delete_objects(bucket: String, keys: Vec<String>, state: State<'_, AppState>) -> Result<(), String> {
    let client = {
        let guard = state.client.lock().unwrap();
        guard.as_ref().ok_or("Client not initialized")?.clone()
    };

    let mut object_ids = Vec::new();
    for k in keys {
        object_ids.push(ObjectIdentifier::builder().key(k).build().unwrap());
    }

    /* 
       Note: delete_objects is limited to 1000 items per call by AWS. 
       For "military grade", we should chunk this.
    */
    for chunk in object_ids.chunks(1000) {
        let delete = Delete::builder().set_objects(Some(chunk.to_vec())).build().unwrap();
        client.delete_objects()
            .bucket(&bucket)
            .delete(delete)
            .send()
            .await
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub async fn delete_prefix(bucket: String, prefix: String, state: State<'_, AppState>) -> Result<(), String> {
    let client = {
        let guard = state.client.lock().unwrap();
        guard.as_ref().ok_or("Client not initialized")?.clone()
    };

    // List all objects with prefix
    let mut continuation_token = None;
    let mut all_keys = Vec::new();

    loop {
        let resp = client.list_objects_v2()
            .bucket(&bucket)
            .prefix(&prefix)
            .set_continuation_token(continuation_token)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        
        for obj in resp.contents() {
            if let Some(k) = obj.key() {
                all_keys.push(ObjectIdentifier::builder().key(k).build().unwrap());
            }
        }

        if resp.is_truncated().unwrap_or(false) {
            continuation_token = resp.next_continuation_token.clone();
        } else {
            break;
        }
    }

    if all_keys.is_empty() {
        return Ok(());
    }

    // Delete in chunks
    for chunk in all_keys.chunks(1000) {
         let delete = Delete::builder().set_objects(Some(chunk.to_vec())).build().unwrap();
         client.delete_objects()
             .bucket(&bucket)
             .delete(delete)
             .send()
             .await
             .map_err(|e| e.to_string())?;
    }

    Ok(())
}



#[tauri::command]
pub async fn upload_file(bucket: String, key: String, path: String, state: State<'_, AppState>) -> Result<(), String> {
    let client = {
        let guard = state.client.lock().unwrap();
        guard.as_ref().ok_or("Client not initialized")?.clone()
    };

    let body = ByteStream::from_path(std::path::Path::new(&path)).await.map_err(|e| e.to_string())?;

    client.put_object()
        .bucket(bucket)
        .key(key)
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]pub async fn get_bucket_stats(bucket: String, state: State<'_, AppState>) -> Result<HashMap<String, String>, String> {
    let client = {
        let guard = state.client.lock().unwrap();
        guard.as_ref().ok_or("Client not initialized")?.clone()
    };

    let mut total_size: i64 = 0;
    let mut object_count: i64 = 0;
    let mut continuation_token = None;

    loop {
        let resp = client.list_objects_v2()
            .bucket(&bucket)
            .set_continuation_token(continuation_token)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        for obj in resp.contents() {
            total_size += obj.size().unwrap_or(0);
            object_count += 1;
        }

        if resp.is_truncated().unwrap_or(false) {
            continuation_token = resp.next_continuation_token;
        } else {
            break;
        }
    }

    let mut result = HashMap::new();
    result.insert("size".to_string(), total_size.to_string());
    result.insert("count".to_string(), object_count.to_string());
    
    Ok(result)
}

#[tauri::command]pub async fn download_file(bucket: String, key: String, save_path: String, state: State<'_, AppState>) -> Result<(), String> {
    let client = {
        let guard = state.client.lock().unwrap();
        guard.as_ref().ok_or("Client not initialized")?.clone()
    };

    let resp = client.get_object()
        .bucket(bucket)
        .key(key)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let data = resp.body.collect().await.map_err(|e| e.to_string())?.into_bytes();
    
    std::fs::write(save_path, data).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn read_text_file(bucket: String, key: String, state: State<'_, AppState>) -> Result<String, String> {
    let client = {
        let guard = state.client.lock().unwrap();
        guard.as_ref().ok_or("Client not initialized")?.clone()
    };

    let resp = client.get_object()
        .bucket(bucket)
        .key(key)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    // Check size first to avoid crashing on huge files
    if resp.content_length() > Some(1024 * 1024 * 5) { // 5MB limit for preview
        return Err("File too large for preview".to_string());
    }

    let data = resp.body.collect().await.map_err(|e| e.to_string())?.into_bytes();
    let text = String::from_utf8(data.to_vec()).map_err(|_| "File is not valid text".to_string())?;

    Ok(text)
}

#[tauri::command]
pub async fn get_presigned_url(bucket: String, key: String, state: State<'_, AppState>) -> Result<String, String> {
    let client = {
        let guard = state.client.lock().unwrap();
        guard.as_ref().ok_or("Client not initialized")?.clone()
    };

    let presigning_config = aws_sdk_s3::presigning::PresigningConfig::expires_in(std::time::Duration::from_secs(3600))
        .map_err(|e| e.to_string())?;

    let presigned_req = client.get_object()
        .bucket(bucket)
        .key(key)
        .presigned(presigning_config)
        .await
        .map_err(|e| e.to_string())?;

    Ok(presigned_req.uri().to_string())
}

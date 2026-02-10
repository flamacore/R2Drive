import { invoke } from "@tauri-apps/api/core";

export const initR2Client = async (accountId: string, accessKey: string, secretKey: string) => {
  await invoke("init_r2", { accountId, accessKey, secretKey });
};

export const listBuckets = async () => {
  const buckets = await invoke<string[]>("list_buckets");
  return buckets;
};

export interface R2Object {
  key: string;
  size: string;
  last_modified: string;
  type: "file";
}

export interface R2Folder {
  key: string;
  type: "folder";
}

export interface ListObjectsResult {
  files: R2Object[];
  folders: R2Folder[];
}

export const listObjects = async (bucket: string, prefix = "", delimiter = "/") => {
  return await invoke<ListObjectsResult>("list_objects", { bucket, prefix, delimiter });
};

export const uploadObject = async (bucket: string, key: string, filePath: string) => {
  await invoke("upload_file", { bucket, key, path: filePath });
};

export const createFolder = async (bucket: string, key: string) => {
  await invoke("create_folder", { bucket, key });
};

export const downloadObject = async (bucket: string, key: string, savePath: string) => {
  await invoke("download_file", { bucket, key, savePath });
};

export const deleteObjects = async (bucket: String, keys: string[]) => {
  await invoke("delete_objects", { bucket, keys });
};

export const deletePrefix = async (bucket: String, prefix: string) => {
  await invoke("delete_prefix", { bucket, prefix });
};

export const getBucketStats = async (bucket: string) => {
  const res = await invoke<{size: string, count: string}>("get_bucket_stats", { bucket });
  return {
      size: parseInt(res.size),
      count: parseInt(res.count)
  };
};


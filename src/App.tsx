import { useState, useEffect } from "react";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./components/ui/table";
import { initR2Client, listBuckets, listObjects, uploadObject, downloadObject, createFolder, deleteObjects, deletePrefix, getBucketStats, readTextFile, getPresignedUrl, copyObject, renameFolder } from "./services/r2Service";
import { open, save, message } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window"; // Add this import
import { readDir, stat } from "@tauri-apps/plugin-fs"; // Add this import
import { Folder, File, Download, Trash2, Upload, ChevronRight, Home, ArrowUp, RefreshCw, FolderPlus, X, FileText, EyeOff, Move, Pencil } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox"
import { Progress } from "@/components/ui/progress"

interface FileItem {
  key: string;
  size?: number;
  lastModified?: Date;
  type: "file" | "folder";
}

function App() {
  // Config State
  const [buckets, setBuckets] = useState<string[]>([]);
  const [accessKey, setAccessKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [accountId, setAccountId] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [statsLoading, setStatsLoading] = useState(false);
  const [bucketStats, setBucketStats] = useState<{size: number, count: number, bucket: string} | null>(null);
  
  // Preview State
  const [preview, setPreview] = useState<{
      key: string;
      type: 'image' | 'text' | 'code' | 'none';
      content: string | null; // URL for image, Text for text
      loading: boolean;
      error?: string;
  } | null>(null);

  // Browser State
  const [currentBucket, setCurrentBucket] = useState<string>("");
  const [currentPath, setCurrentPath] = useState<string>("");
  const [files, setFiles] = useState<FileItem[]>([]);
  const [folders, setFolders] = useState<FileItem[]>([]);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [isDragging, setIsDragging] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<{
    total: number;
    current: number;
    filename: string;
    isActive: boolean;
  }>({ total: 0, current: 0, filename: "", isActive: false });

  useEffect(() => {
    const savedAccountId = localStorage.getItem("accountId");
    const savedAccessKey = localStorage.getItem("accessKey");
    const savedSecretKey = localStorage.getItem("secretKey");
    if (savedAccountId && savedAccessKey && savedSecretKey) {
      setAccountId(savedAccountId);
      setAccessKey(savedAccessKey);
      setSecretKey(savedSecretKey);
      
      const init = async () => {
          try {
            await initR2Client(savedAccountId, savedAccessKey, savedSecretKey);
            await loadBuckets();
            setAuthenticated(true);
          } catch(e) { console.error(e); }
      };
      init();
    }
  }, []);

  const [lastSelectedKey, setLastSelectedKey] = useState<string | null>(null);

  // Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
        // Ctrl+A: Select All
        if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
            e.preventDefault();
            toggleAll(true); // Force select all
        }
        // Escape: Deselect All
        if (e.key === 'Escape') {
            setSelection(new Set());
        }
        // Delete: Delete Selected
        if (e.key === 'Delete') {
            if (selection.size > 0) {
                handleDelete();
            }
        }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selection, files, folders]);

  useEffect(() => {
    let unlistenDrop: (() => void) | undefined;
    let unlistenHover: (() => void) | undefined;
    let unlistenCancel: (() => void) | undefined;

    const setupListener = async () => {
        const appWindow = getCurrentWindow();
        
        console.log("Setting up drag/drop listeners");

        unlistenHover = await appWindow.listen('tauri://drag-enter', (event) => {
            console.log('Drag Enter:', event);
            setIsDragging(true);
        });
        
        // Also listen for drag-leave to hide the overlay
        // Note: drag-leave can be flaky if it leaves to a child element, 
        // but the overlay covers everything and is pointer-events-none, 
        // which usually helps.
        unlistenCancel = await appWindow.listen('tauri://drag-leave', (event) => {
             console.log('Drag Leave:', event);
             setIsDragging(false);
        });

        unlistenDrop = await appWindow.listen('tauri://drag-drop', async (event) => {
           console.log('Drag Drop Event:', event);
           setIsDragging(false);
           
           if (authenticated && currentBucket) {
               // payload structure in v2: { paths: string[], position: { x, y } }
               const payload = event.payload as { paths: string[] };
               const droppedFiles = payload.paths;

               console.log("Files dropped:", droppedFiles);
               if (droppedFiles && droppedFiles.length > 0) {
                   await processUploads(droppedFiles);
               }
           } else {
               console.warn("Drop ignored: Not authenticated or no bucket selected");
           }
        });
    };
    
    setupListener();

    return () => {
        if (unlistenDrop) unlistenDrop();
        if (unlistenHover) unlistenHover();
        if (unlistenCancel) unlistenCancel();
    };
  }, [authenticated, currentBucket, currentPath]);

  const processUploads = async (filePaths: string[]) => {
      setUploadStatus({ total: 0, current: 0, filename: "Scanning...", isActive: true });
      
      const allFiles: { path: string, relativeKey: string }[] = [];

      // Recursive walker
      const walk = async (path: string, baseRelative: string) => {
          try {
             const stats = await stat(path);
             
             if (stats.isDirectory) {
                 const entries = await readDir(path);
                 for (const entry of entries) {
                     const separator = path.includes("\\") ? "\\" : "/";
                     const name = entry.name;
                     // Skip . and ..? plugin-fs doesn't return them usually
                     const fullPath = `${path}${separator}${name}`;
                     // If baseRelative is empty, we are at the root of the drop. 
                     // e.g. dropped "MyFolder", baseRelative is "MyFolder".
                     // entry "SubFile", newRelative "MyFolder/SubFile".
                     const nextRelative = baseRelative ? `${baseRelative}/${name}` : name;
                     
                     await walk(fullPath, nextRelative);
                 }
             } else {
                 allFiles.push({ path, relativeKey: baseRelative });
             }
          } catch(e) {
              console.error("Failed to stat " + path, e);
          }
      }

      // First pass: scan
      for(const p of filePaths) {
          const name = p.split(/[\\/]/).pop() || "unknown";
          await walk(p, name);
      }

      setUploadStatus(prev => ({ ...prev, total: allFiles.length, filename: "Starting upload..." }));

      let successCount = 0;
      let failCount = 0;
      
      for(let i = 0; i < allFiles.length; i++) {
        const item = allFiles[i];
        setUploadStatus(prev => ({ ...prev, current: i + 1, filename: item.relativeKey }));
        
        const fullKey = (currentPath || "") + item.relativeKey;
        try {
            await uploadObject(currentBucket, fullKey, item.path);
            successCount++;
        } catch (e) {
            failCount++;
            console.error("Failed to upload " + item.relativeKey + ": " + e);
        }
      }
      
      await loadFiles(currentBucket, currentPath);
      setUploadStatus(prev => ({ ...prev, isActive: false }));

      if (failCount > 0) {
          await message(`Uploaded ${successCount} files. Failed: ${failCount}`, { kind: 'warning' });
      }
  }

  const authenticate = async () => {
    setLoading(true);
    try {
      await initR2Client(accountId, accessKey, secretKey);
      localStorage.setItem("accountId", accountId);
      localStorage.setItem("accessKey", accessKey);
      localStorage.setItem("secretKey", secretKey);
      await loadBuckets();
      setAuthenticated(true);
    } catch (error) {
       await message("Authentication failed: " + (error as Error).message, { kind: 'error' });
    } finally {
        setLoading(false);
    }
  };

  const loadBuckets = async () => {
    setLoading(true);
    try {
      const bucketList = await listBuckets();
      setBuckets(bucketList);
    } catch (error) {
       console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  const loadFiles = async (bucket: string, prefix: string) => {
    if(!bucket) return;
    setLoading(true);
    try {
      const result = await listObjects(bucket, prefix, "/");
      
      const fileItems: FileItem[] = result.files.map(obj => ({
        key: obj.key,
        size: parseInt(obj.size) || 0,
        lastModified: new Date(obj.last_modified),
        type: "file" as const
      })).filter(f => f.key !== prefix); // Filter out the folder placeholder itself

      const folderItems: FileItem[] = result.folders.map(obj => ({
        key: obj.key,
        type: "folder" as const
      }));

      setFiles(fileItems);
      setFolders(folderItems);
      setSelection(new Set());
    } catch (error) {
      await message("Failed to load files: " + (error as Error).message, { kind: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const loadStats = async (bucket: string) => {
      setStatsLoading(true);
      try {
          const stats = await getBucketStats(bucket);
          setBucketStats({ ...stats, bucket });
      } catch (e) {
          console.error("Failed to load stats", e);
      } finally {
          setStatsLoading(false);
      }
  }

  const handleBucketSelect = (bucket: string) => {
      setCurrentBucket(bucket);
      setCurrentPath("");
      loadFiles(bucket, "");
      loadStats(bucket);
  }

  const handleNavigate = (folderKey: string) => {
      setCurrentPath(folderKey);
      loadFiles(currentBucket, folderKey);
  }

  const handleNavigateUp = () => {
      if (currentPath === "") return;
      const parts = currentPath.split("/").filter(p => p);
      parts.pop();
      const newPath = parts.length > 0 ? parts.join("/") + "/" : "";
      handleNavigate(newPath);
  }

  const handleRefresh = () => {
      loadFiles(currentBucket, currentPath);
  }

  const handleCreateFolder = async () => {
      const folderName = prompt("Enter folder name:");
      if (!folderName) return;
      
      // Sanitization
      const safeName = folderName.replace(/[\/\\]/g, ""); 
      const newKey = currentPath + safeName + "/";
      
      try {
          await createFolder(currentBucket, newKey);
          loadFiles(currentBucket, currentPath);
      } catch (e) {
          await message("Failed to create folder: " + e, { kind: 'error' });
      }
  }

  const handleDownload = async (key: string) => {
    try {
      const fileName = key.split("/").pop() || "download";
      const savePath = await save({
        defaultPath: fileName,
      });
      if (!savePath) return;

      await downloadObject(currentBucket, key, savePath);
      // await message("Download successful", { kind: 'info' });
    } catch (error) {
      await message("Download failed: " + (error as Error).message, { kind: 'error' });
    }
  };

  const handleMove = async (destinationPath?: string, keysToMove?: Set<string>) => {
       const targetKeys = keysToMove || selection;
       if (targetKeys.size === 0) return;
       
       let targetPath = destinationPath;
       
       // If not provided (context menu/button), ask user
       if (targetPath === undefined) {
           targetPath = prompt("Enter destination folder path (relative to bucket root):", currentPath) || undefined;
           if (targetPath === undefined) return; // Cancelled
       }
       
       // Normalize target
       if (targetPath && !targetPath.endsWith("/")) targetPath += "/";
       if (targetPath === currentPath) return; // No op

       setLoading(true);
       try {
           const items = Array.from(targetKeys);
           for (const key of items) {
               const fileName = key.split('/').pop();
               if (!fileName) continue;
               
               const isFolder = folders.some(f => f.key === key);
               if (isFolder) {
                   // Simple folder move not supported yet without recursive list
                   console.log("Folder move skipped: " + key);
                   continue;
               }

               const newKey = (targetPath || "") + fileName;
               
               // Copy
               await copyObject(currentBucket, key, newKey);
               // Delete
               await deleteObjects(currentBucket, [key]);
           }
           
           loadFiles(currentBucket, currentPath);
           setSelection(new Set());
       } catch (e) {
           await message("Move failed: " + e, { kind: 'error' });
       } finally {
           setLoading(false);
       }
  }

  const handleDragStart = (e: React.DragEvent, key: string) => {
      const draggingKeys = selection.has(key) ? Array.from(selection) : [key];
      e.dataTransfer.setData("application/r2-keys", JSON.stringify(draggingKeys));
      e.dataTransfer.effectAllowed = "move";
  }

  const handleDragOver = (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes("application/r2-keys")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
      }
  }

  const handleDropInternal = async (e: React.DragEvent, targetFolderKey: string) => {
      e.preventDefault();
      e.stopPropagation(); // Prevent global drop
      const data = e.dataTransfer.getData("application/r2-keys");
      if (!data) return;
      
      try {
          const sourceKeys = JSON.parse(data) as string[];
          // Prevent moving into self? S3 paths don't care, but logic might.
          // Since we move FILES, dragging file into folder is fine.
          
          if (confirm(`Move ${sourceKeys.length} items to ${targetFolderKey}?`)) {
               await handleMove(targetFolderKey, new Set(sourceKeys));
          }
      } catch(ex) {}
  }

  const handleRename = async (key: string) => {
      // Get old name, handling trailing slashes for folders
      const pathParts = key.split('/');
      let oldName = pathParts.pop();
      if (oldName === "" && pathParts.length > 0) {
          oldName = pathParts.pop();
      }
      
      if (!oldName) return;

      const newName = prompt("Enter new name:", oldName);
      if (!newName || newName === oldName) return;

      const isFolder = folders.some(f => f.key === key);
      
      setLoading(true);
      try {
          if (isFolder) {
              const oldPrefix = key; // Should end in /
              // Construct new prefix
              // If key is "photos/2023/" and we rename "2023" to "2024"
              // key="photos/2023/", oldName="2023" (actually split might be empty if trailing slashes)
              
              const parts = key.split('/');
              // if ends with /, last part is empty
              if (parts[parts.length - 1] === "") parts.pop(); 
              parts.pop(); // remove old folder name
              parts.push(newName);
              const newPrefix = parts.join('/') + "/";
              
              await renameFolder(currentBucket, oldPrefix, newPrefix);
          } else {
              // Rename File Logic
              const parts = key.split('/');
              parts.pop(); // Remove old name
              parts.push(newName);
              const newKey = parts.join('/');

              // Copy
              await copyObject(currentBucket, key, newKey);
              // Delete
              await deleteObjects(currentBucket, [key]);
          }

          loadFiles(currentBucket, currentPath);
          setSelection(new Set());
      } catch (e) {
          await message("Rename failed: " + e, { kind: 'error' });
      } finally {
          setLoading(false);
      }
  }

  const handleDelete = async () => {
    if (selection.size === 0) return;
    if (!confirm(`Delete ${selection.size} items?`)) return;
    
    setLoading(true);
    try {
        const selectedFiles = files.filter(f => selection.has(f.key)).map(f => f.key);
        const selectedFolders = folders.filter(f => selection.has(f.key)).map(f => f.key);

        if (selectedFiles.length > 0) {
            await deleteObjects(currentBucket, selectedFiles);
        }

        if (selectedFolders.length > 0) {
            for (const folderKey of selectedFolders) {
                await deletePrefix(currentBucket, folderKey);
            }
        }

        loadFiles(currentBucket, currentPath);
        // await message("Deleted " + selection.size + " items.", { kind: 'info' });
        setSelection(new Set());
    } catch (error) {
        await message("Delete failed: " + (error as Error).message, { kind: 'error' });
    } finally {
        setLoading(false);
    }
  };

  // Context Menu
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; itemKey: string; type: "file" | "folder" } | null>(null);

  const handleContextMenu = (e: React.MouseEvent, key: string, type: "file" | "folder") => {
      e.preventDefault();
      // If the item is not selected, select it (exclusive)
      if (!selection.has(key)) {
          setSelection(new Set([key]));
          setLastSelectedKey(key);
      }
      setContextMenu({ x: e.clientX, y: e.clientY, itemKey: key, type });
  };

  useEffect(() => {
      const handleClick = () => setContextMenu(null);
      window.addEventListener("click", handleClick);
      return () => window.removeEventListener("click", handleClick);
  }, []);

  const handleUpload = async () => {
    if (!currentBucket) {
        await message("Please select a bucket first.", { kind: 'warning' });
        return;
    }
    try {
      const filePaths = await open({
        multiple: true,
        directory: false,
      });
      
      if (filePaths) {
         const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
         await processUploads(paths);
      }
    } catch (error) {
      await message("Upload failed: " + (error as Error).message, { kind: 'error' });
    }
  };

  const toggleSelection = (key: string) => {
      const newSet = new Set(selection);
      if (newSet.has(key)) {
          newSet.delete(key);
      } else {
          newSet.add(key);
      }
      setSelection(newSet);
      setLastSelectedKey(key);
  }

  const getFileType = (fileName: string): 'image' | 'text' | 'code' | 'none' => {
      const ext = fileName.split('.').pop()?.toLowerCase() || '';
      const images = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'];
      const text = ['txt', 'md', 'log', 'csv', 'ini', 'cfg', 'conf', 'env'];
      const code = ['json', 'js', 'ts', 'jsx', 'tsx', 'rs', 'html', 'css', 'xml', 'yml', 'yaml', 'py', 'go', 'java', 'c', 'cpp', 'h'];

      if (images.includes(ext)) return 'image';
      if (text.includes(ext)) return 'text';
      if (code.includes(ext)) return 'code';
      return 'none';
  }

  const loadPreview = async (bucket: string, key: string) => {
      const type = getFileType(key); // We pass the full key, but usually extension is at end
      
      setPreview({ key, type, content: null, loading: true });

      try {
          if (type === 'image') {
              const url = await getPresignedUrl(bucket, key);
              setPreview({ key, type, content: url, loading: false });
          } else if (type === 'text' || type === 'code') {
              const text = await readTextFile(bucket, key);
              setPreview({ key, type, content: text, loading: false });
          } else {
              setPreview({ key, type: 'none', content: null, loading: false });
          }
      } catch (error) {
          setPreview({ key, type, content: null, loading: false, error: (error as Error).toString() });
      }
  }

  const handleRowClick = (key: string, e: React.MouseEvent) => {
      // Prevent selection when clicking directly on interactive elements handled elsewhere
      // (Though usually we handle this by e.stopPropagation on the child)
      
      const allItems = [...folders.map(f => f.key), ...files.map(f => f.key)];
      let newSelection = new Set<string>();

      if (e.ctrlKey || e.metaKey) {
          // Ctrl+Click: Toggle
          newSelection = new Set(selection);
          if (newSelection.has(key)) {
              newSelection.delete(key);
          } else {
              newSelection.add(key);
          }
          setLastSelectedKey(key);
      } else if (e.shiftKey && lastSelectedKey) {
          // Shift+Click: Range
          const lastIdx = allItems.indexOf(lastSelectedKey);
          const currentIdx = allItems.indexOf(key);
          
          if (lastIdx !== -1 && currentIdx !== -1) {
              const start = Math.min(lastIdx, currentIdx);
              const end = Math.max(lastIdx, currentIdx);
              
              newSelection = new Set();
              for(let i = start; i <= end; i++) {
                  newSelection.add(allItems[i]);
              }
          } else {
              newSelection.add(key);
              setLastSelectedKey(key);
          }
      } else {
          // Single Click: Select Only this
          newSelection.add(key);
          setLastSelectedKey(key);
      }

      setSelection(newSelection);

      // Trigger Preview if single file selected
      if (newSelection.size === 1) {
          const selectedKey = Array.from(newSelection)[0];
          // Check if it's a file (not in folders list)
          const isFile = files.some(f => f.key === selectedKey);
          if (isFile) {
             // Avoid reloading if already showing
             if (preview?.key !== selectedKey) {
                 loadPreview(currentBucket, selectedKey);
             }
          } else {
              setPreview(null);
          }
      } else {
          setPreview(null);
      }
  }

  const toggleAll = (forceSelect = false) => {
      if (!forceSelect && selection.size === files.length + folders.length) {
          setSelection(new Set());
      } else {
          const allKeys = [...folders.map(f => f.key), ...files.map(f => f.key)];
          setSelection(new Set(allKeys));
      }
  }

  // Render Login
  if (!authenticated) {
    return (
      <div className="flex items-center justify-center h-screen bg-background text-foreground">
        <div className="w-96 space-y-6 p-8 bg-card rounded-xl border border-border shadow-lg">
          <div className="space-y-2 text-center">
             <h1 className="text-3xl font-bold tracking-tight">R2 Drive</h1>
             <p className="text-muted-foreground">Enterprise Storage Browser</p>
          </div>
          <div className="space-y-4">
            <div className="space-y-2">
                <Input placeholder="Account ID" value={accountId} onChange={(e) => setAccountId(e.target.value)} />
            </div>
            <div className="space-y-2">
                <Input placeholder="Access Key ID" value={accessKey} onChange={(e) => setAccessKey(e.target.value)} />
            </div>
            <div className="space-y-2">
                <Input placeholder="Secret Key" type="password" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} />
            </div>
            <Button onClick={authenticate} className="w-full" disabled={loading}>
                {loading ? "Authenticating..." : "Connect to R2"}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Render App
  return (
    <div className="relative flex h-screen bg-background text-foreground overflow-hidden">
      {/* Sidebar */}
      <div className="w-64 bg-card border-r border-border flex flex-col">
          <div className="p-4 border-b border-border flex items-center gap-2">
              <div className="h-8 w-8 bg-primary rounded-md flex items-center justify-center">
                  <span className="text-primary-foreground font-bold text-lg">R2</span>
              </div>
              <span className="font-semibold text-lg">Drive</span>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Buckets</h3>
            <ul className="space-y-1">
            {buckets.map((bucket) => (
                <li 
                    key={bucket} 
                    className={`cursor-pointer px-3 py-2 rounded-md text-sm font-medium transition-colors flex items-center gap-2 ${currentBucket === bucket ? 'bg-primary/10 text-primary' : 'hover:bg-accent/50 text-muted-foreground hover:text-foreground'}`} 
                    onClick={() => handleBucketSelect(bucket)}
                >
                <div className="w-2 h-2 rounded-full bg-current"></div>
                {bucket}
                </li>
            ))}
            </ul>
          </div>
          <div className="p-4 border-t border-border">
              <div className="text-xs text-muted-foreground">Logged in as {accountId.substring(0, 8)}...</div>
          </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
         {/* Top Bar */}
         <div className="h-16 border-b border-border px-6 flex items-center justify-between bg-card/50 backdrop-blur-sm">
             <div className="flex items-center gap-4 flex-1 min-w-0">
                 <div className="flex items-center gap-1 text-muted-foreground hover:text-foreground cursor-pointer" onClick={() => handleBucketSelect(currentBucket)}>
                    <Home size={18} /> 
                 </div>
                 {currentPath && (
                     <>
                        <ChevronRight size={16} className="text-muted-foreground" />
                        <div className="text-sm font-medium truncate">{currentPath}</div>
                     </>
                 )}
             </div>
             
             <div className="flex items-center gap-2">
                 {statsLoading ? (
                    <div className="hidden md:flex items-center gap-2 text-xs text-muted-foreground mr-4 border-r border-border pr-4 h-8">
                        <RefreshCw size={14} className="animate-spin" />
                        <span>Calculating stats...</span>
                    </div>
                 ) : (
                    bucketStats && bucketStats.bucket === currentBucket && (
                     <div className="hidden md:flex items-center gap-4 text-xs text-muted-foreground mr-4 border-r border-border pr-4 h-8 animate-in fade-in">
                         <div className="flex flex-col items-end leading-none gap-1">
                             <span className="font-medium text-foreground">{formatBytes(bucketStats.size)}</span>
                             <span>Total Size</span>
                         </div>
                         <div className="flex flex-col items-end leading-none gap-1">
                             <span className="font-medium text-foreground">{bucketStats.count.toLocaleString()}</span>
                             <span>Objects</span>
                         </div>
                     </div>
                    )
                 )}
                 <Button variant="outline" size="sm" onClick={handleRefresh} disabled={!currentBucket}>
                     <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
                 </Button>
             </div>
         </div>

         {/* Action Bar */}
         {currentBucket && (
            <div className="h-12 border-b border-border px-6 flex items-center justify-between bg-background">
                 <div className="flex items-center gap-2">
                     <Button size="sm" onClick={handleUpload} className="gap-2">
                         <Upload size={16} /> Upload
                     </Button>
                     <Button size="sm" variant="outline" onClick={handleCreateFolder} className="gap-2">
                         <FolderPlus size={16} /> New Folder
                     </Button>
                     <Button size="sm" variant="outline" onClick={() => handleMove()} disabled={selection.size === 0} className="gap-2">
                         <Move size={16} /> Move
                     </Button>
                 </div>
                 
                 <div className="flex items-center gap-2">
                     {selection.size > 0 && (
                         <div className="flex items-center gap-2 bg-destructive/10 text-destructive px-3 py-1 rounded-md text-sm">
                             <span className="font-medium">{selection.size} selected</span>
                             <div className="h-4 w-px bg-destructive/20 mx-1"></div>
                             <button className="hover:underline flex items-center gap-1" onClick={handleDelete}>
                                 <Trash2 size={14} /> Delete
                             </button>
                         </div>
                     )}
                 </div>
            </div>
         )}

         {/* File List & Preview Split */}
         <div className="flex-1 overflow-hidden flex flex-row">
             {/* Main Table Area */}
             <div className="flex-1 flex flex-col min-w-0 overflow-hidden border-r border-border"> 
                 {!currentBucket ? (
                     <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground animate-in fade-in duration-500">
                         <div className="w-16 h-16 bg-accent rounded-full flex items-center justify-center mb-4">
                             <ArrowUp size={32} className="opacity-50" />
                         </div>
                         <p>Select a bucket to start browsing</p>
                     </div>
                 ) : (
                    <div className="flex-1 overflow-auto">
                        <Table>
                            <TableHeader className="sticky top-0 bg-background z-10 shadow-sm">
                            <TableRow className="hover:bg-transparent">
                                <TableHead className="w-[40px]">
                                    <Checkbox 
                                        checked={files.length + folders.length > 0 && selection.size === files.length + folders.length}
                                        onCheckedChange={toggleAll}
                                    />
                                </TableHead>
                                <TableHead className="w-[40px]"></TableHead>
                                <TableHead>Name</TableHead>
                                <TableHead className="w-[120px]">Size</TableHead>
                                <TableHead className="w-[180px]">Last Modified</TableHead>
                                <TableHead className="w-[80px]"></TableHead>
                            </TableRow>
                            </TableHeader>
                            <TableBody>
                            {/* Parent Folder Link */}
                            {currentPath && (
                                <TableRow 
                                    className="cursor-pointer hover:bg-muted/50"
                                    onClick={handleNavigateUp}
                                >
                                    <TableCell></TableCell>
                                    <TableCell><Folder size={18} className="text-muted-foreground" /></TableCell>
                                    <TableCell className="font-medium text-muted-foreground">..</TableCell>
                                    <TableCell></TableCell>
                                    <TableCell></TableCell>
                                    <TableCell></TableCell>
                                </TableRow>
                            )}
                            
                            {/* Folder List */}
                            {folders.map((folder) => {
                                const displayName = folder.key.replace(currentPath, "").replace("/", "");
                                const isSelected = selection.has(folder.key);
                                return (
                                    <TableRow 
                                        key={folder.key} 
                                        draggable
                                        onDragStart={(e) => handleDragStart(e, folder.key)}
                                        onDragOver={handleDragOver}
                                        onDrop={(e) => handleDropInternal(e, folder.key)}
                                        className={`group cursor-pointer ${isSelected ? "bg-accent/50 selected" : ""}`}
                                        onClick={(e) => handleRowClick(folder.key, e)}
                                        onContextMenu={(e) => handleContextMenu(e, folder.key, "folder")}
                                        // Double click to navigate
                                        onDoubleClick={(e) => {
                                            e.preventDefault();
                                            handleNavigate(folder.key);
                                        }}
                                    >
                                        <TableCell onClick={(e) => { e.stopPropagation(); toggleSelection(folder.key); }}>
                                            <Checkbox 
                                                checked={isSelected}
                                                // onCheckedChange handles click automatically
                                            />
                                        </TableCell>
                                        <TableCell>
                                            <Folder size={18} className="text-blue-500 fill-blue-500/20" />
                                        </TableCell>
                                        <TableCell className="font-medium">
                                            {displayName}
                                        </TableCell>
                                        <TableCell className="text-muted-foreground">-</TableCell>
                                        <TableCell className="text-muted-foreground">-</TableCell>
                                        <TableCell>
                                            <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100" onClick={(e) => { e.stopPropagation(); handleDelete(); }}>
                                                {/* <Trash2 size={14} className="text-muted-foreground hover:text-destructive" /> */}
                                            </Button>
                                        </TableCell>
                                    </TableRow>
                                )
                            })}

                            {/* File List */}
                            {files.map((file) => {
                                const displayName = file.key.replace(currentPath, "");
                                const isSelected = selection.has(file.key);
                                return (
                                    <TableRow 
                                        key={file.key} 
                                        draggable
                                        onDragStart={(e) => handleDragStart(e, file.key)}
                                        className={`group cursor-pointer ${isSelected ? "bg-accent/50 selected" : ""}`}
                                        onClick={(e) => handleRowClick(file.key, e)}
                                        onContextMenu={(e) => handleContextMenu(e, file.key, "file")}
                                    >
                                        <TableCell onClick={(e) => { e.stopPropagation(); toggleSelection(file.key); }}>
                                            <Checkbox 
                                                checked={isSelected}
                                                // onCheckedChange handled by parent click or explicit logic if needed, but simple checkbox click propagation works for toggle
                                            />
                                        </TableCell>
                                        <TableCell>
                                            <File size={18} className="text-muted-foreground" />
                                        </TableCell>
                                        <TableCell className="font-medium">{displayName}</TableCell>
                                        <TableCell className="text-muted-foreground text-xs">
                                            {formatBytes(file.size || 0)}
                                        </TableCell>
                                        <TableCell className="text-muted-foreground text-xs">
                                            {file.lastModified?.toLocaleDateString()}
                                        </TableCell>
                                        <TableCell>
                                            <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
                                                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleDownload(file.key)}>
                                                    <Download size={14} />
                                                </Button>
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                )
                            })}
                            
                            {files.length === 0 && folders.length === 0 && (
                                <TableRow>
                                    <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                                        Empty folder
                                    </TableCell>
                                </TableRow>
                            )}
                            </TableBody>
                        </Table>
                    </div>
                 )}
             </div>

             {/* Preview Pane */}
             {preview && (
                 <div className="w-80 bg-background border-l border-border flex flex-col animate-in slide-in-from-right-10 duration-200 shadow-xl z-20">
                     <div className="h-12 border-b border-border flex items-center justify-between px-4 bg-muted/20">
                         <span className="font-semibold text-sm truncate max-w-[200px]">{preview.key.split('/').pop()}</span>
                         <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setPreview(null)}>
                             <X size={16} />
                         </Button>
                     </div>
                     <div className="flex-1 overflow-auto p-4 flex flex-col items-center">
                         {preview.loading ? (
                             <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-2">
                                 <RefreshCw size={24} className="animate-spin" />
                                 <span className="text-xs">Loading preview...</span>
                             </div>
                         ) : preview.error ? (
                             <div className="flex-1 flex flex-col items-center justify-center text-destructive gap-2 text-center">
                                 <EyeOff size={32} />
                                 <span className="text-sm px-4">{preview.error}</span>
                             </div>
                         ) : (
                             <>
                                {preview.type === 'image' && preview.content && (
                                    <div className="w-full h-full flex items-center justify-center bg-accent/20 rounded-lg overflow-hidden border border-border">
                                        <img src={preview.content} alt="Preview" className="max-w-full max-h-full object-contain" />
                                    </div>
                                )}
                                {(preview.type === 'text' || preview.type === 'code') && preview.content && (
                                    <div className="w-full h-full bg-card border border-border rounded-md p-3 overflow-auto text-xs font-mono whitespace-pre-wrap">
                                        {preview.content}
                                    </div>
                                )}
                                {preview.type === 'none' && (
                                     <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-2">
                                        <FileText size={48} className="opacity-20" />
                                        <span className="text-sm">No preview available</span>
                                        <span className="text-xs text-muted-foreground">Type: {preview.key.split('.').pop()}</span>
                                     </div>
                                )}
                             </>
                         )}
                     </div>
                     <div className="p-4 border-t border-border bg-muted/10">
                        <Button className="w-full gap-2" variant="secondary" onClick={() => handleDownload(preview.key)}>
                            <Download size={16} /> Download File
                        </Button>
                     </div>
                 </div>
             )}
         </div>

         {/* Footer Status */}
         <div className="h-8 border-t border-border bg-card px-4 flex items-center justify-between text-xs text-muted-foreground">
             <div>{files.length} files, {folders.length} folders</div>
             <div>{loading ? "Syncing..." : "Up to date"}</div>
         </div>
      </div>

      {/* Blocking Loading Overlay */}
      {loading && (
        <div className="absolute inset-0 bg-background/60 backdrop-blur-sm z-[60] flex items-center justify-center animate-in fade-in duration-200 cursor-wait">
            <div className="bg-card px-8 py-6 rounded-xl shadow-2xl border border-border flex flex-col items-center gap-4">
                 <RefreshCw size={40} className="animate-spin text-primary" />
                 <div className="flex flex-col items-center gap-1">
                    <h3 className="font-semibold text-lg">Processing</h3>
                    <p className="text-xs text-muted-foreground">Please wait...</p>
                 </div>
            </div>
        </div>
      )}

      {/* Drag Overlay */}
      {isDragging && (
        <div className="absolute inset-0 bg-primary/20 backdrop-blur-sm z-50 flex items-center justify-center border-4 border-primary border-dashed m-4 rounded-xl animate-in fade-in duration-200 pointer-events-none">
            <div className="bg-background/90 p-8 rounded-xl shadow-xl flex flex-col items-center gap-4">
                <div className="h-16 w-16 bg-primary/20 rounded-full flex items-center justify-center">
                    <Upload size={32} className="text-primary" />
                </div>
                <h3 className="text-2xl font-bold">Drop files to upload</h3>
                <p className="text-muted-foreground">Upload to {currentBucket}/{currentPath}</p>
            </div>
        </div>
      )}

      {/* Progress Overlay */}
      {uploadStatus.isActive && (
          <div className="absolute bottom-10 right-10 w-80 bg-card border border-border shadow-2xl rounded-xl overflow-hidden z-50 animate-in slide-in-from-bottom-5 duration-300">
              <div className="p-4 bg-muted/30 border-b border-border flex items-center justify-between">
                  <span className="font-semibold text-sm">Uploading...</span>
                  <div className="text-xs text-muted-foreground font-mono">{uploadStatus.current} / {uploadStatus.total}</div>
              </div>
              <div className="p-5 space-y-4">
                  <div className="space-y-1">
                      <div className="flex justify-between text-xs">
                          <span className="truncate max-w-[180px] font-medium">{uploadStatus.filename}</span>
                          <span className="text-muted-foreground">{Math.round((uploadStatus.current / uploadStatus.total) * 100)}%</span>
                      </div>
                      <Progress value={(uploadStatus.current / uploadStatus.total) * 100} className="h-2" />
                  </div>
              </div>
          </div>
      )}

      {/* Context Menu */}
      {contextMenu && (
          <div 
            className="fixed z-50 min-w-[160px] bg-popover text-popover-foreground rounded-md border border-border shadow-md animate-in fade-in duration-200"
            style={{ top: contextMenu.y, left: contextMenu.x }}
            onClick={(e) => e.stopPropagation()} // Prevent closing when clicking inside
          >
              <div className="p-1">
                  {contextMenu.type === "folder" ? (
                       <div 
                         className="flex items-center gap-2 px-2 py-1.5 text-sm rounded-sm hover:bg-accent hover:text-accent-foreground cursor-pointer"
                         onClick={() => {
                             handleNavigate(contextMenu.itemKey);
                             setContextMenu(null);
                         }}
                       >
                           <Folder size={14} /> Open
                       </div>
                  ) : (
                       <div 
                         className="flex items-center gap-2 px-2 py-1.5 text-sm rounded-sm hover:bg-accent hover:text-accent-foreground cursor-pointer"
                         onClick={() => {
                             handleDownload(contextMenu.itemKey);
                             setContextMenu(null);
                         }}
                       >
                           <Download size={14} /> Download
                       </div>
                  )}
                  
                  <div 
                     className="flex items-center gap-2 px-2 py-1.5 text-sm rounded-sm hover:bg-accent hover:text-accent-foreground cursor-pointer"
                     onClick={() => {
                         handleMove(undefined, new Set([contextMenu.itemKey]));
                         setContextMenu(null);
                     }}
                  >
                        <Move size={14} /> Move
                  </div>

                  {/* Always show rename for both files and folders now */}
                  <div 
                    className="flex items-center gap-2 px-2 py-1.5 text-sm rounded-sm hover:bg-accent hover:text-accent-foreground cursor-pointer"
                    onClick={() => {
                        handleRename(contextMenu.itemKey);
                        setContextMenu(null);
                    }}
                    >
                        <Pencil size={14} /> Rename
                    </div>

                  <div className="h-px bg-border my-1" />
                  
                  <div 
                     className="flex items-center gap-2 px-2 py-1.5 text-sm rounded-sm hover:bg-destructive hover:text-white text-destructive cursor-pointer"
                     onClick={() => {
                         handleDelete();
                         setContextMenu(null);
                     }}
                  >
                        <Trash2 size={14} /> Delete
                  </div>
              </div>
          </div>
      )}
    </div>
  );
}

export default App;

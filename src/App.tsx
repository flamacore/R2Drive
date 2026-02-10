import { useState, useEffect } from "react";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./components/ui/table";
import { initR2Client, listBuckets, listObjects, uploadObject, downloadObject, createFolder, deleteObjects, deletePrefix, getBucketStats } from "./services/r2Service";
import { open, save, message } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window"; // Add this import
import { Folder, File, Download, Trash2, Upload, ChevronRight, Home, ArrowUp, RefreshCw, FolderPlus } from "lucide-react";
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
      setUploadStatus({ total: filePaths.length, current: 0, filename: "", isActive: true });
      let successCount = 0;
      let failCount = 0;
      
      for(let i = 0; i < filePaths.length; i++) {
        const filePath = filePaths[i];
        const fileName = filePath.split(/[\\/]/).pop() || "unknown";
        setUploadStatus(prev => ({ ...prev, current: i + 1, filename: fileName }));
        
        const fullKey = currentPath + fileName;
        try {
            await uploadObject(currentBucket, fullKey, filePath);
            successCount++;
        } catch (e) {
            failCount++;
            console.error("Failed to upload " + fileName + ": " + e);
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
              
              // If we want to ADD to selection or REPLACE?
              // Windows Explorer usually replaces the selection with the range,
              // unless Ctrl is also held (but Ctrl+Shift is rare).
              // Let's assume standard Shift click replaces selection with range
              // BUT keeps the anchor? No, standard is range replaces.
              
              // Actually, standard behavior often keeps previous "others" if you used ctrl before?
              // Let's do simple: Shift click sets selection to the range.
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
                 {bucketStats && bucketStats.bucket === currentBucket && (
                     <div className="hidden md:flex items-center gap-4 text-xs text-muted-foreground mr-4 border-r border-border pr-4 h-8">
                         <div className="flex flex-col items-end leading-none gap-1">
                             <span className="font-medium text-foreground">{formatBytes(bucketStats.size)}</span>
                             <span>Total Size</span>
                         </div>
                         <div className="flex flex-col items-end leading-none gap-1">
                             <span className="font-medium text-foreground">{bucketStats.count.toLocaleString()}</span>
                             <span>Objects</span>
                         </div>
                     </div>
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

         {/* File List */}
         <div className="flex-1 overflow-hidden flex flex-col">
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
         {/* Footer Status */}
         <div className="h-8 border-t border-border bg-card px-4 flex items-center justify-between text-xs text-muted-foreground">
             <div>{files.length} files, {folders.length} folders</div>
             <div>{loading ? "Syncing..." : "Up to date"}</div>
         </div>
      </div>

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

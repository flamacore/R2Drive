import { useState, useEffect } from "react";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./components/ui/table";
import { initR2Client, listBuckets, listObjects, uploadObject, downloadObject, createFolder, deleteObjects } from "./services/r2Service";
import { open, save, message } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { Folder, File, Download, Trash2, Upload, Plus, ChevronRight, Home, ArrowUp, RefreshCw, FolderPlus } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox"

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

  // Browser State
  const [currentBucket, setCurrentBucket] = useState<string>("");
  const [currentPath, setCurrentPath] = useState<string>("");
  const [files, setFiles] = useState<FileItem[]>([]);
  const [folders, setFolders] = useState<FileItem[]>([]);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [isDragging, setIsDragging] = useState(false);

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

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    async function setupListener() {
        unlisten = await listen('tauri://file-drop', async (event) => {
           setIsDragging(false);
           if (authenticated && currentBucket) {
               const droppedFiles = event.payload as string[];
               if (droppedFiles && droppedFiles.length > 0) {
                   setLoading(true);
                   let successCount = 0;
                   let failCount = 0;
                   
                   for(const filePath of droppedFiles) {
                      const fileName = filePath.split(/[\\/]/).pop() || "unknown";
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
                   if (failCount > 0) {
                       await message(`Uploaded ${successCount} files. Failed: ${failCount}`, { kind: 'warning' });
                   } else {
                       // await message(`Uploaded ${successCount} files.`, { kind: 'info' });
                   }
                   setLoading(false);
               }
           }
        });
        
        // Listen for drag enter to show overlay
         /*  Note: Tauri v2 doesn't expose easy drag-enter js events for the whole window easily without custom rust logic or webview logic.
             We will just rely on the OS drop. 
         */
    }
    setupListener();
    return () => {
        if (unlisten) unlisten();
    };
  }, [authenticated, currentBucket, currentPath]);

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

  const loadFiles = async (bucket: string, prefix: string) => {
    if(!bucket) return;
    setLoading(true);
    try {
      const result = await listObjects(bucket, prefix, "/");
      
      const fileItems: FileItem[] = result.files.map(obj => ({
        key: obj.key,
        size: parseInt(obj.size) || 0,
        lastModified: new Date(obj.last_modified),
        type: "file"
      })).filter(f => f.key !== prefix); // Filter out the folder placeholder itself

      const folderItems: FileItem[] = result.folders.map(obj => ({
        key: obj.key,
        type: "folder"
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

  const handleBucketSelect = (bucket: string) => {
      setCurrentBucket(bucket);
      setCurrentPath("");
      loadFiles(bucket, "");
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

    try {
        await deleteObjects(currentBucket, Array.from(selection));
        loadFiles(currentBucket, currentPath);
        // await message("Deleted " + selection.size + " items.", { kind: 'info' });
    } catch (error) {
        await message("Delete failed: " + (error as Error).message, { kind: 'error' });
    }
  };

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
          /* 
             open() returns explicit string in single mode, 
             or string[] in multiple mode? 
             Wait, Tauri v2 documentation says: 
             `open` returns null | string | string[] depending on options.
          */
         const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
         setLoading(true);
         for(const path of paths) {
            const fileName = path.split(/[\\/]/).pop() || "unknown";
            const fullKey = currentPath + fileName;
            await uploadObject(currentBucket, fullKey, path);
         }
         loadFiles(currentBucket, currentPath);
         setLoading(false);
        //  await message("Upload successful", { kind: 'info' });
      }
    } catch (error) {
      await message("Upload failed: " + (error as Error).message, { kind: 'error' });
      setLoading(false);
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
  }

  const toggleAll = () => {
      if (selection.size === files.length + folders.length) {
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
    <div className="flex h-screen bg-background text-foreground overflow-hidden">
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
                            return (
                                <TableRow key={folder.key} className="group">
                                    <TableCell onClick={(e) => e.stopPropagation()}>
                                        <Checkbox 
                                            checked={selection.has(folder.key)}
                                            onCheckedChange={() => toggleSelection(folder.key)}
                                        />
                                    </TableCell>
                                    <TableCell className="cursor-pointer" onClick={() => handleNavigate(folder.key)}>
                                        <Folder size={18} className="text-blue-500 fill-blue-500/20" />
                                    </TableCell>
                                    <TableCell className="font-medium cursor-pointer" onClick={() => handleNavigate(folder.key)}>
                                        {displayName}
                                    </TableCell>
                                    <TableCell className="text-muted-foreground">-</TableCell>
                                    <TableCell className="text-muted-foreground">-</TableCell>
                                    <TableCell>
                                        <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100" onClick={() => handleDelete()}>
                                             {/* <Trash2 size={14} className="text-muted-foreground hover:text-destructive" /> */}
                                        </Button>
                                    </TableCell>
                                </TableRow>
                            )
                        })}

                        {/* File List */}
                        {files.map((file) => {
                             const displayName = file.key.replace(currentPath, "");
                             return (
                                <TableRow key={file.key} className="group">
                                    <TableCell onClick={(e) => e.stopPropagation()}>
                                        <Checkbox 
                                            checked={selection.has(file.key)}
                                            onCheckedChange={() => toggleSelection(file.key)}
                                        />
                                    </TableCell>
                                    <TableCell>
                                        <File size={18} className="text-muted-foreground" />
                                    </TableCell>
                                    <TableCell className="font-medium">{displayName}</TableCell>
                                    <TableCell className="text-muted-foreground text-xs">
                                        {(file.size || 0 / 1024).toFixed(1)} KB
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
    </div>
  );
}

export default App;

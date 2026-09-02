"use client";

/**
 * "Creatives" tab of the Creative section.
 *
 * Personal library where the user saves generated creatives — images, videos
 * and ad copy (text) — organised into folders, like the Ads Library.
 * Backed by the legacy `creative_templates` table:
 *   - folder  → row with media_type='folder' (name = folder name)
 *   - item in a folder → `category` = folder name
 *   - text creative → media_type='text', copy stored in `tags`
 *   - files upload via signed URL directly to storage (no 6MB limit)
 */

import { useState, useRef, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  Upload, Trash2, RefreshCw, CheckCircle, Play, Search, ArrowUpDown,
  ChevronDown, SlidersHorizontal, Folder, FolderPlus, FolderInput,
  FileText, Download, Pencil, Sparkles, ChevronLeft, Copy,
} from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { getUploadUrl } from "@/lib/projecthub-storage";
import { getSupabaseBrowser } from "@/lib/supabase-browser";

type CreativeRow = {
  id: number; project_id: string; name: string; source_brand: string;
  category: string; file_path: string; media_type: string; tags: string; created_at: string;
};

function formatDate(d: string) {
  return new Date(d).toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "numeric" });
}

export function CreativesTab({ projectId }: { projectId: string }) {
  const { toast } = useToast();
  const api = `/api/projecthub/projects/${projectId}/creative/templates`;

  const [rows, setRows] = useState<CreativeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentFolder, setCurrentFolder] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "image" | "video" | "text">("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"newest" | "oldest">("newest");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Dialogs
  const [folderDialog, setFolderDialog] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [textDialog, setTextDialog] = useState<{ id?: number; name: string; content: string } | null>(null);
  const [preview, setPreview] = useState<CreativeRow | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch(api);
      if (r.ok) setRows(await r.json());
    } finally { setLoading(false); }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [projectId]);

  const folders = useMemo(() => {
    const explicit = rows.filter(r => r.media_type === "folder").map(r => r.name);
    // Folders can also exist implicitly via items imported with a category.
    const implicit = rows.filter(r => r.media_type !== "folder" && r.category).map(r => r.category);
    return Array.from(new Set([...explicit, ...implicit])).sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const items = useMemo(() => rows.filter(r => r.media_type !== "folder"), [rows]);

  const visible = items
    .filter(i => currentFolder === null ? true : i.category === currentFolder)
    .filter(i => filter === "all" || i.media_type === filter)
    .filter(i => !search
      || i.name.toLowerCase().includes(search.toLowerCase())
      || (i.media_type === "text" && i.tags.toLowerCase().includes(search.toLowerCase())))
    .sort((a, b) => sort === "newest"
      ? new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      : new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  const folderCount = (name: string) => items.filter(i => i.category === name).length;
  const allSelected = visible.length > 0 && visible.every(i => selected.has(i.id));

  // ── actions ──
  const createFolder = async () => {
    const name = folderName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const r = await fetch(api, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "folder", name }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "error");
      setRows(prev => [j, ...prev]);
      setFolderDialog(false); setFolderName("");
      toast({ title: `Folder "${name}" created` });
    } catch (e) {
      toast({ title: "Could not create folder", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally { setBusy(false); }
  };

  const saveText = async () => {
    if (!textDialog) return;
    const { id, name, content } = textDialog;
    if (!content.trim()) { toast({ title: "Write some text first", variant: "destructive" }); return; }
    setBusy(true);
    try {
      const r = id
        ? await fetch(`${api}/${id}`, {
            method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: name.trim() || undefined, content }),
          })
        : await fetch(api, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind: "text", name: name.trim(), content, category: currentFolder || "" }),
          });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "error");
      setRows(prev => id ? prev.map(x => x.id === id ? j : x) : [j, ...prev]);
      setTextDialog(null);
      toast({ title: id ? "Text updated" : "Text saved" });
    } catch (e) {
      toast({ title: "Could not save text", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally { setBusy(false); }
  };

  const uploadFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const sb = getSupabaseBrowser();
    if (!sb) { toast({ title: "Storage unavailable", variant: "destructive" }); return; }
    setUploading(true);
    let ok = 0, ko = 0;
    for (const file of Array.from(files)) {
      try {
        const sr = await fetch(`${api}/sign-upload`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: file.name, contentType: file.type || "application/octet-stream" }),
        });
        const sj = await sr.json().catch(() => ({}));
        if (!sr.ok || !sj.path || !sj.token) throw new Error(sj.error || "sign failed");
        const up = await sb.storage.from("project-files").uploadToSignedUrl(sj.path, sj.token, file);
        if (up.error) throw new Error(up.error.message);
        const rr = await fetch(api, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "file",
            name: file.name.replace(/\.[^.]+$/, ""),
            file_path: sj.path,
            media_type: sj.media_type,
            category: currentFolder || "",
          }),
        });
        const rj = await rr.json().catch(() => ({}));
        if (!rr.ok) throw new Error(rj.error || "register failed");
        setRows(prev => [rj, ...prev]);
        ok++;
      } catch (e) {
        ko++;
        console.warn("[creatives] upload failed:", e);
      }
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
    toast(ko === 0
      ? { title: `${ok} creative${ok === 1 ? "" : "s"} uploaded` }
      : { title: `${ok} uploaded, ${ko} failed`, variant: "destructive" });
  };

  const moveTo = async (ids: number[], folder: string) => {
    setRows(prev => prev.map(x => ids.includes(x.id) ? { ...x, category: folder } : x));
    setSelected(new Set()); setSelectionMode(false);
    await Promise.all(ids.map(id => fetch(`${api}/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: folder }),
    })));
    toast({ title: folder ? `Moved to "${folder}"` : "Moved out of folder" });
  };

  const del = async (ids: number[]) => {
    setRows(prev => prev.filter(x => !ids.includes(x.id)));
    setSelected(new Set()); setSelectionMode(false);
    await Promise.all(ids.map(id => fetch(`${api}/${id}`, { method: "DELETE" })));
    toast({ title: ids.length === 1 ? "Creative deleted" : `${ids.length} creatives deleted` });
  };

  const deleteFolder = async (name: string) => {
    const row = rows.find(r => r.media_type === "folder" && r.name === name);
    setRows(prev => prev
      .filter(x => !(x.media_type === "folder" && x.name === name))
      .map(x => x.category === name ? { ...x, category: "" } : x));
    if (currentFolder === name) setCurrentFolder(null);
    if (row) {
      await fetch(`${api}/${row.id}`, { method: "DELETE" });
    } else {
      // Implicit folder (imported categories): clear the category on items.
      const ids = items.filter(i => i.category === name).map(i => i.id);
      await Promise.all(ids.map(id => fetch(`${api}/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: "" }),
      })));
    }
    toast({ title: `Folder "${name}" deleted`, description: "Its creatives were moved to the root." });
  };

  const downloadOne = (item: CreativeRow) => {
    if (item.media_type === "text") {
      const blob = new Blob([item.tags], { type: "text/plain;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${item.name || "creative"}.txt`;
      a.click();
      URL.revokeObjectURL(a.href);
    } else if (item.file_path) {
      window.open(getUploadUrl(item.file_path), "_blank");
    }
  };

  const downloadSelected = () => {
    const list = visible.filter(i => selected.has(i.id));
    list.forEach((i, idx) => setTimeout(() => downloadOne(i), idx * 400));
  };

  const toggleSelect = (id: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // ── render ──
  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="text-base font-bold text-foreground flex items-center gap-1.5">
            {currentFolder !== null && (
              <button onClick={() => setCurrentFolder(null)} className="text-muted-foreground hover:text-foreground">
                <ChevronLeft className="w-4 h-4" />
              </button>
            )}
            {currentFolder !== null ? (
              <span className="flex items-center gap-1.5"><Folder className="w-4 h-4 text-amber-500" /> {currentFolder}</span>
            ) : "My creatives"}
          </h3>
          <p className="text-xs text-muted-foreground">
            {currentFolder !== null
              ? `${visible.length} creatives in this folder`
              : `${items.length} creatives · ${folders.length} folders`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => { setFolderName(""); setFolderDialog(true); }} className="gap-1.5 text-sm">
            <FolderPlus className="w-4 h-4" /> New folder
          </Button>
          <Button variant="outline" size="sm" onClick={() => setTextDialog({ name: "", content: "" })} className="gap-1.5 text-sm">
            <FileText className="w-4 h-4" /> New text
          </Button>
          <Button size="sm" onClick={() => fileRef.current?.click()} disabled={uploading} className="bg-primary text-white gap-1.5 text-sm">
            {uploading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {uploading ? "Uploading..." : "Upload"}
          </Button>
          <input ref={fileRef} type="file" accept="image/*,video/*" multiple className="hidden"
            onChange={e => uploadFiles(e.target.files)} />
        </div>
      </div>

      {/* Folders (root view only) */}
      {currentFolder === null && folders.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6 gap-2">
          {folders.map(name => (
            <div key={name} onClick={() => { setCurrentFolder(name); setSelected(new Set()); setSelectionMode(false); }}
              className="group flex items-center gap-2 border border-border rounded-xl px-3 py-2.5 bg-card hover:border-amber-400/60 hover:shadow-sm cursor-pointer transition-all">
              <Folder className="w-5 h-5 text-amber-500 flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-foreground truncate">{name}</p>
                <p className="text-[10px] text-muted-foreground">{folderCount(name)} items</p>
              </div>
              <button onClick={e => { e.stopPropagation(); deleteFolder(name); }}
                className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all flex-shrink-0"
                title="Delete folder (creatives are kept)">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search creatives..." className="pl-8 h-8 text-sm" />
        </div>
        <div className="flex items-center gap-1 border border-border rounded-lg p-0.5 bg-muted/30">
          {(["all", "image", "video", "text"] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-3 py-1 text-xs rounded-md font-medium transition-colors ${f === filter ? "bg-white shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              {f === "all" ? "All" : f === "image" ? "Images" : f === "video" ? "Video" : "Texts"}
            </button>
          ))}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-border rounded-lg bg-background hover:bg-muted transition-colors font-medium">
              <ArrowUpDown className="w-3 h-3" />
              {sort === "newest" ? "Newest" : "Oldest"}
              <ChevronDown className="w-3 h-3 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="text-sm">
            <DropdownMenuItem onClick={() => setSort("newest")}>Newest</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setSort("oldest")}>Oldest</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button onClick={() => { setSelectionMode(v => !v); setSelected(new Set()); }}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs border rounded-lg font-medium transition-colors ${selectionMode ? "border-primary text-primary bg-primary/5" : "border-border bg-background hover:bg-muted"}`}>
          <SlidersHorizontal className="w-3 h-3" /> Select
        </button>
      </div>

      {/* Selection bar */}
      {selectionMode && (
        <div className="flex items-center gap-3 bg-muted/40 border border-border rounded-lg px-4 py-2 flex-wrap">
          <label className="flex items-center gap-2 cursor-pointer text-sm font-medium text-foreground">
            <input type="checkbox" checked={allSelected}
              onChange={() => setSelected(allSelected ? new Set() : new Set(visible.map(i => i.id)))}
              className="w-4 h-4 rounded accent-primary" />
            {allSelected ? "Deselect all" : "Select all"}
          </label>
          {selected.size > 0 && (
            <>
              <span className="text-xs text-muted-foreground">{selected.size} selected</span>
              <div className="ml-auto flex items-center gap-2">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-border bg-background hover:bg-muted transition-colors font-medium">
                      <FolderInput className="w-3 h-3" /> Move to
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="text-sm">
                    {currentFolder !== null && (
                      <DropdownMenuItem onClick={() => moveTo(Array.from(selected), "")}>Root (no folder)</DropdownMenuItem>
                    )}
                    {folders.filter(f => f !== currentFolder).map(f => (
                      <DropdownMenuItem key={f} onClick={() => moveTo(Array.from(selected), f)}>
                        <Folder className="w-3.5 h-3.5 mr-1.5 text-amber-500" /> {f}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <button onClick={downloadSelected}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-border bg-background hover:bg-muted transition-colors font-medium">
                  <Download className="w-3 h-3" /> Download
                </button>
                <button onClick={() => del(Array.from(selected))}
                  className="flex items-center gap-1.5 text-xs text-destructive hover:bg-destructive/10 px-3 py-1.5 rounded-lg transition-colors font-medium border border-destructive/30">
                  <Trash2 className="w-3 h-3" /> Delete
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Grid */}
      {loading ? (
        <div className="py-16 text-center text-sm text-muted-foreground">Loading...</div>
      ) : visible.length === 0 ? (
        <div className="py-20 text-center border-2 border-dashed border-border rounded-2xl">
          <Sparkles className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-sm font-semibold text-foreground mb-1">
            {search ? "No results" : currentFolder ? "This folder is empty" : "No creatives yet"}
          </p>
          <p className="text-xs text-muted-foreground mb-4">
            {search ? "Try a different search." : "Upload images and videos or save your ad copy as text."}
          </p>
          {!search && (
            <div className="flex items-center justify-center gap-2">
              <Button size="sm" variant="outline" onClick={() => setTextDialog({ name: "", content: "" })} className="gap-1.5">
                <FileText className="w-3.5 h-3.5" /> New text
              </Button>
              <Button size="sm" onClick={() => fileRef.current?.click()} className="bg-primary text-white gap-1.5">
                <Upload className="w-3.5 h-3.5" /> Upload
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-3">
          {visible.map(item => {
            const isSelected = selected.has(item.id);
            return (
              <div key={item.id}
                onClick={() => selectionMode ? toggleSelect(item.id) : setPreview(item)}
                className={`group relative rounded-xl overflow-hidden bg-card border transition-all duration-200 cursor-pointer
                  ${isSelected ? "border-primary ring-2 ring-primary/30 shadow-md" : "border-border hover:border-primary/40 hover:shadow-lg"}`}>

                {/* Thumbnail */}
                <div className="aspect-[4/5] bg-muted relative overflow-hidden">
                  {item.media_type === "image" && item.file_path ? (
                    <img src={getUploadUrl(item.file_path)} alt={item.name} loading="lazy"
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                  ) : item.media_type === "video" && item.file_path ? (
                    <>
                      {/* #t=0.1 forces the browser to decode and paint the first
                          frame — without it many browsers leave the box black. */}
                      <video src={`${getUploadUrl(item.file_path)}#t=0.1`} preload="metadata" muted playsInline
                        className="w-full h-full object-cover" />
                      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                        <div className="w-10 h-10 rounded-full bg-black/50 flex items-center justify-center">
                          <Play className="w-5 h-5 text-white fill-white ml-0.5" />
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="w-full h-full bg-gradient-to-br from-slate-50 to-slate-100 p-3 overflow-hidden">
                      <FileText className="w-4 h-4 text-primary/60 mb-1.5" />
                      <p className="text-[10px] text-slate-600 leading-snug whitespace-pre-wrap break-words">
                        {item.tags.slice(0, 420)}
                      </p>
                      <div className="absolute bottom-0 inset-x-0 h-10 bg-gradient-to-t from-slate-100 to-transparent" />
                    </div>
                  )}

                  {/* Selection checkbox */}
                  {(selectionMode || isSelected) && (
                    <div className="absolute top-2 right-2">
                      <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${isSelected ? "bg-primary border-primary" : "bg-white/80 border-white"}`}>
                        {isSelected && <CheckCircle className="w-3.5 h-3.5 text-white fill-white" />}
                      </div>
                    </div>
                  )}

                  {/* Hover actions */}
                  {!selectionMode && (
                    <div className="absolute top-2 right-2 flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={e => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button className="w-7 h-7 rounded-full bg-black/55 hover:bg-black/75 flex items-center justify-center text-white" title="Move to folder">
                            <FolderInput className="w-3.5 h-3.5" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="text-sm">
                          {item.category && (
                            <DropdownMenuItem onClick={() => moveTo([item.id], "")}>Root (no folder)</DropdownMenuItem>
                          )}
                          {folders.filter(f => f !== item.category).map(f => (
                            <DropdownMenuItem key={f} onClick={() => moveTo([item.id], f)}>
                              <Folder className="w-3.5 h-3.5 mr-1.5 text-amber-500" /> {f}
                            </DropdownMenuItem>
                          ))}
                          {folders.filter(f => f !== item.category).length === 0 && !item.category && (
                            <DropdownMenuItem disabled>No folders yet</DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                      {item.media_type === "text" && (
                        <button onClick={() => setTextDialog({ id: item.id, name: item.name, content: item.tags })}
                          className="w-7 h-7 rounded-full bg-black/55 hover:bg-black/75 flex items-center justify-center text-white" title="Edit text">
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button onClick={() => downloadOne(item)}
                        className="w-7 h-7 rounded-full bg-black/55 hover:bg-black/75 flex items-center justify-center text-white" title="Download">
                        <Download className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => del([item.id])}
                        className="w-7 h-7 rounded-full bg-black/55 hover:bg-red-600 flex items-center justify-center text-white" title="Delete">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>

                {/* Footer */}
                <div className="p-2.5 space-y-0.5">
                  <p className="text-xs font-semibold text-foreground truncate leading-tight">{item.name}</p>
                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span className="uppercase tracking-wide">{item.media_type}</span>
                    <span>{formatDate(item.created_at)}</span>
                    {currentFolder === null && item.category && (
                      <span className="flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 bg-amber-50 text-amber-700 rounded-full truncate">
                        <Folder className="w-2.5 h-2.5" /> {item.category}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* New folder dialog */}
      <Dialog open={folderDialog} onOpenChange={setFolderDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>New folder</DialogTitle></DialogHeader>
          <div className="space-y-4 mt-2">
            <Input value={folderName} onChange={e => setFolderName(e.target.value)} placeholder="E.g. UGC, Hooks, Static ads..."
              autoFocus onKeyDown={e => { if (e.key === "Enter") createFolder(); }} />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setFolderDialog(false)}>Cancel</Button>
              <Button onClick={createFolder} disabled={busy || !folderName.trim()} className="bg-primary text-white gap-1.5">
                <FolderPlus className="w-3.5 h-3.5" /> Create
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* New / edit text dialog */}
      <Dialog open={!!textDialog} onOpenChange={v => { if (!v) setTextDialog(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>{textDialog?.id ? "Edit text" : "Save a text creative"}</DialogTitle></DialogHeader>
          {textDialog && (
            <div className="space-y-3 mt-2">
              <Input value={textDialog.name} onChange={e => setTextDialog({ ...textDialog, name: e.target.value })}
                placeholder="Title (e.g. Hook v3 - urgency)" className="text-sm" />
              <Textarea value={textDialog.content} onChange={e => setTextDialog({ ...textDialog, content: e.target.value })}
                placeholder="Paste your ad copy, hooks, scripts..." rows={10} className="text-sm" />
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setTextDialog(null)}>Cancel</Button>
                <Button onClick={saveText} disabled={busy} className="bg-primary text-white gap-1.5">
                  {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5" />}
                  Save
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Preview dialog */}
      <Dialog open={!!preview} onOpenChange={v => { if (!v) setPreview(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle className="truncate pr-8">{preview?.name}</DialogTitle></DialogHeader>
          {preview && (
            <div className="mt-1 space-y-3">
              {preview.media_type === "image" && preview.file_path && (
                <img src={getUploadUrl(preview.file_path)} alt={preview.name} className="w-full max-h-[65vh] object-contain rounded-lg bg-muted" />
              )}
              {preview.media_type === "video" && preview.file_path && (
                <video src={getUploadUrl(preview.file_path)} controls autoPlay className="w-full max-h-[65vh] rounded-lg bg-black" />
              )}
              {preview.media_type === "text" && (
                <div className="max-h-[60vh] overflow-y-auto border border-border rounded-lg p-4 bg-muted/30">
                  <p className="text-sm text-foreground whitespace-pre-wrap break-words">{preview.tags}</p>
                </div>
              )}
              <div className="flex items-center justify-end gap-2">
                {preview.media_type === "text" && (
                  <Button variant="outline" size="sm" className="gap-1.5"
                    onClick={() => { navigator.clipboard.writeText(preview.tags); toast({ title: "Copied to clipboard" }); }}>
                    <Copy className="w-3.5 h-3.5" /> Copy
                  </Button>
                )}
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => downloadOne(preview)}>
                  <Download className="w-3.5 h-3.5" /> Download
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

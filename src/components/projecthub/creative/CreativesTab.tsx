"use client";

/**
 * "Creatives" tab of the Creative section.
 *
 * Folder-first library for the user's generated creatives:
 *  - Root view shows ONLY folders (like a file manager).
 *  - Opening a folder shows its creative cards (images / videos).
 *  - Opening a card shows the media plus its text/copy (editable).
 *
 * Backed by the legacy `creative_templates` table:
 *  - folder → row with media_type='folder' (name = folder name)
 *  - item in a folder → `category` = folder name ('' = Uncategorized)
 *  - the creative's text lives in `tags`
 *  - files upload via signed URL directly to storage (no 6MB limit)
 */

import { useState, useRef, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  Upload, Trash2, RefreshCw, CheckCircle, Play, Search, ArrowUpDown,
  ChevronDown, SlidersHorizontal, Folder, FolderPlus, FolderInput,
  FileText, Download, Sparkles, ChevronLeft, Copy, Inbox,
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

const UNFILED = "__unfiled__";

function formatDate(d: string) {
  return new Date(d).toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "numeric" });
}

export function CreativesTab({ projectId }: { projectId: string }) {
  const { toast } = useToast();
  const api = `/api/projecthub/projects/${projectId}/creative/templates`;

  const [rows, setRows] = useState<CreativeRow[]>([]);
  const [loading, setLoading] = useState(true);
  /** null = root (folders only); folder name; UNFILED = items without folder */
  const [currentFolder, setCurrentFolder] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "image" | "video">("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"newest" | "oldest">("newest");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [folderDialog, setFolderDialog] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [detail, setDetail] = useState<CreativeRow | null>(null);
  const [detailText, setDetailText] = useState("");
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

  const items = useMemo(() => rows.filter(r => r.media_type !== "folder"), [rows]);

  const folders = useMemo(() => {
    const explicit = rows.filter(r => r.media_type === "folder").map(r => r.name);
    const implicit = items.filter(r => r.category).map(r => r.category);
    return Array.from(new Set([...explicit, ...implicit])).sort((a, b) => a.localeCompare(b));
  }, [rows, items]);

  const unfiledCount = items.filter(i => !i.category).length;
  const folderCount = (name: string) => items.filter(i => i.category === name).length;

  const inFolder = currentFolder === null ? [] : items.filter(i =>
    currentFolder === UNFILED ? !i.category : i.category === currentFolder);

  const visible = inFolder
    .filter(i => filter === "all" || i.media_type === filter)
    .filter(i => !search
      || i.name.toLowerCase().includes(search.toLowerCase())
      || i.tags.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => sort === "newest"
      ? new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      : new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

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

  const uploadFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const sb = getSupabaseBrowser();
    if (!sb) { toast({ title: "Storage unavailable", variant: "destructive" }); return; }
    const targetFolder = currentFolder && currentFolder !== UNFILED ? currentFolder : "";
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
            category: targetFolder,
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
    if (ok > 0 && currentFolder === null) setCurrentFolder(targetFolder || UNFILED);
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
    toast({ title: folder ? `Moved to "${folder}"` : "Moved to Uncategorized" });
  };

  const del = async (ids: number[]) => {
    setRows(prev => prev.filter(x => !ids.includes(x.id)));
    setSelected(new Set()); setSelectionMode(false);
    if (detail && ids.includes(detail.id)) setDetail(null);
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
      const ids = items.filter(i => i.category === name).map(i => i.id);
      await Promise.all(ids.map(id => fetch(`${api}/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: "" }),
      })));
    }
    toast({ title: `Folder "${name}" deleted`, description: "Its creatives were moved to Uncategorized." });
  };

  const saveDetailText = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      const r = await fetch(`${api}/${detail.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: detailText }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "error");
      setRows(prev => prev.map(x => x.id === detail.id ? { ...x, tags: detailText } : x));
      setDetail(prev => prev ? { ...prev, tags: detailText } : prev);
      toast({ title: "Text saved" });
    } catch (e) {
      toast({ title: "Could not save text", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally { setBusy(false); }
  };

  const downloadOne = (item: CreativeRow) => {
    if (item.file_path) {
      window.open(getUploadUrl(item.file_path), "_blank");
    } else if (item.tags) {
      const blob = new Blob([item.tags], { type: "text/plain;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${item.name || "creative"}.txt`;
      a.click();
      URL.revokeObjectURL(a.href);
    }
  };

  const toggleSelect = (id: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const openDetail = (item: CreativeRow) => { setDetail(item); setDetailText(item.tags || ""); };

  const folderLabel = currentFolder === UNFILED ? "Uncategorized" : currentFolder;

  // ═══ ROOT VIEW — folders only ═══
  if (currentFolder === null) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h3 className="text-base font-bold text-foreground">My creatives</h3>
            <p className="text-xs text-muted-foreground">{folders.length + (unfiledCount > 0 ? 1 : 0)} folders · {items.length} creatives</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => { setFolderName(""); setFolderDialog(true); }} className="gap-1.5 text-sm">
              <FolderPlus className="w-4 h-4" /> New folder
            </Button>
            <Button size="sm" onClick={() => fileRef.current?.click()} disabled={uploading} className="bg-primary text-white gap-1.5 text-sm">
              {uploading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              {uploading ? "Uploading..." : "Upload"}
            </Button>
            <input ref={fileRef} type="file" accept="image/*,video/*" multiple className="hidden"
              onChange={e => uploadFiles(e.target.files)} />
          </div>
        </div>

        {loading ? (
          <div className="py-16 text-center text-sm text-muted-foreground">Loading...</div>
        ) : folders.length === 0 && unfiledCount === 0 ? (
          <div className="py-20 text-center border-2 border-dashed border-border rounded-2xl">
            <Sparkles className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm font-semibold text-foreground mb-1">No creatives yet</p>
            <p className="text-xs text-muted-foreground mb-4">Create a folder, then upload your images and videos inside it.</p>
            <div className="flex items-center justify-center gap-2">
              <Button size="sm" variant="outline" onClick={() => { setFolderName(""); setFolderDialog(true); }} className="gap-1.5">
                <FolderPlus className="w-3.5 h-3.5" /> New folder
              </Button>
              <Button size="sm" onClick={() => fileRef.current?.click()} className="bg-primary text-white gap-1.5">
                <Upload className="w-3.5 h-3.5" /> Upload
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-3">
            {folders.map(name => {
              const count = folderCount(name);
              const covers = items.filter(i => i.category === name && i.media_type === "image" && i.file_path).slice(0, 4);
              return (
                <div key={name} onClick={() => { setCurrentFolder(name); setSelected(new Set()); setSelectionMode(false); }}
                  className="group relative rounded-xl border border-border bg-card hover:border-amber-400/60 hover:shadow-lg cursor-pointer transition-all overflow-hidden">
                  <div className="aspect-[4/3] bg-gradient-to-br from-amber-50 to-orange-50 relative overflow-hidden">
                    {covers.length > 0 ? (
                      <div className={`grid ${covers.length > 1 ? "grid-cols-2" : "grid-cols-1"} gap-0.5 w-full h-full`}>
                        {covers.map(c => (
                          <img key={c.id} src={getUploadUrl(c.file_path)} alt="" loading="lazy" className="w-full h-full object-cover" />
                        ))}
                      </div>
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <Folder className="w-12 h-12 text-amber-400" />
                      </div>
                    )}
                    <button onClick={e => { e.stopPropagation(); deleteFolder(name); }}
                      className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/50 hover:bg-red-600 text-white items-center justify-center hidden group-hover:flex transition-all"
                      title="Delete folder (creatives are kept)">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="p-2.5 flex items-center gap-2">
                    <Folder className="w-4 h-4 text-amber-500 flex-shrink-0" />
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-foreground truncate">{name}</p>
                      <p className="text-[10px] text-muted-foreground">{count} creative{count === 1 ? "" : "s"}</p>
                    </div>
                  </div>
                </div>
              );
            })}

            {unfiledCount > 0 && (
              <div onClick={() => { setCurrentFolder(UNFILED); setSelected(new Set()); setSelectionMode(false); }}
                className="group relative rounded-xl border border-dashed border-border bg-card hover:border-primary/50 hover:shadow-lg cursor-pointer transition-all overflow-hidden">
                <div className="aspect-[4/3] bg-muted/40 flex items-center justify-center">
                  <Inbox className="w-12 h-12 text-muted-foreground/40" />
                </div>
                <div className="p-2.5 flex items-center gap-2">
                  <Inbox className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-foreground truncate">Uncategorized</p>
                    <p className="text-[10px] text-muted-foreground">{unfiledCount} creative{unfiledCount === 1 ? "" : "s"}</p>
                  </div>
                </div>
              </div>
            )}
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
      </div>
    );
  }

  // ═══ FOLDER VIEW — creative cards ═══
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="text-base font-bold text-foreground flex items-center gap-1.5">
            <button onClick={() => setCurrentFolder(null)} className="text-muted-foreground hover:text-foreground">
              <ChevronLeft className="w-4 h-4" />
            </button>
            {currentFolder === UNFILED
              ? <span className="flex items-center gap-1.5"><Inbox className="w-4 h-4 text-muted-foreground" /> Uncategorized</span>
              : <span className="flex items-center gap-1.5"><Folder className="w-4 h-4 text-amber-500" /> {folderLabel}</span>}
          </h3>
          <p className="text-xs text-muted-foreground">{inFolder.length} creative{inFolder.length === 1 ? "" : "s"}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => fileRef.current?.click()} disabled={uploading} className="bg-primary text-white gap-1.5 text-sm">
            {uploading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {uploading ? "Uploading..." : "Upload here"}
          </Button>
          <input ref={fileRef} type="file" accept="image/*,video/*" multiple className="hidden"
            onChange={e => uploadFiles(e.target.files)} />
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search creatives..." className="pl-8 h-8 text-sm" />
        </div>
        <div className="flex items-center gap-1 border border-border rounded-lg p-0.5 bg-muted/30">
          {(["all", "image", "video"] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-3 py-1 text-xs rounded-md font-medium transition-colors ${f === filter ? "bg-white shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              {f === "all" ? "All" : f === "image" ? "Images" : "Video"}
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
                    {currentFolder !== UNFILED && (
                      <DropdownMenuItem onClick={() => moveTo(Array.from(selected), "")}>
                        <Inbox className="w-3.5 h-3.5 mr-1.5" /> Uncategorized
                      </DropdownMenuItem>
                    )}
                    {folders.filter(f => f !== currentFolder).map(f => (
                      <DropdownMenuItem key={f} onClick={() => moveTo(Array.from(selected), f)}>
                        <Folder className="w-3.5 h-3.5 mr-1.5 text-amber-500" /> {f}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <button onClick={() => visible.filter(i => selected.has(i.id)).forEach((i, idx) => setTimeout(() => downloadOne(i), idx * 400))}
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
      {visible.length === 0 ? (
        <div className="py-20 text-center border-2 border-dashed border-border rounded-2xl">
          <Sparkles className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-sm font-semibold text-foreground mb-1">{search ? "No results" : "This folder is empty"}</p>
          <p className="text-xs text-muted-foreground mb-4">{search ? "Try a different search." : "Upload images and videos here."}</p>
          {!search && (
            <Button size="sm" onClick={() => fileRef.current?.click()} className="bg-primary text-white gap-1.5">
              <Upload className="w-3.5 h-3.5" /> Upload
            </Button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-3">
          {visible.map(item => {
            const isSelected = selected.has(item.id);
            return (
              <div key={item.id}
                onClick={() => selectionMode ? toggleSelect(item.id) : openDetail(item)}
                className={`group relative rounded-xl overflow-hidden bg-card border transition-all duration-200 cursor-pointer
                  ${isSelected ? "border-primary ring-2 ring-primary/30 shadow-md" : "border-border hover:border-primary/40 hover:shadow-lg"}`}>

                <div className="aspect-[4/5] bg-muted relative overflow-hidden">
                  {item.media_type === "image" && item.file_path ? (
                    <img src={getUploadUrl(item.file_path)} alt={item.name} loading="lazy"
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                  ) : item.media_type === "video" && item.file_path ? (
                    <>
                      {/* #t=0.1 forces the browser to paint the first frame */}
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
                    </div>
                  )}

                  {(selectionMode || isSelected) && (
                    <div className="absolute top-2 right-2">
                      <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${isSelected ? "bg-primary border-primary" : "bg-white/80 border-white"}`}>
                        {isSelected && <CheckCircle className="w-3.5 h-3.5 text-white fill-white" />}
                      </div>
                    </div>
                  )}

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
                            <DropdownMenuItem onClick={() => moveTo([item.id], "")}>
                              <Inbox className="w-3.5 h-3.5 mr-1.5" /> Uncategorized
                            </DropdownMenuItem>
                          )}
                          {folders.filter(f => f !== item.category).map(f => (
                            <DropdownMenuItem key={f} onClick={() => moveTo([item.id], f)}>
                              <Folder className="w-3.5 h-3.5 mr-1.5 text-amber-500" /> {f}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
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

                <div className="p-2.5 space-y-0.5">
                  <p className="text-xs font-semibold text-foreground truncate leading-tight">{item.name}</p>
                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span className="uppercase tracking-wide">{item.media_type}</span>
                    <span>{formatDate(item.created_at)}</span>
                    {item.tags && <span title="Has text"><FileText className="w-2.5 h-2.5" /></span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Creative detail: media + text */}
      <Dialog open={!!detail} onOpenChange={v => { if (!v) setDetail(null); }}>
        <DialogContent className="max-w-4xl">
          <DialogHeader><DialogTitle className="truncate pr-8">{detail?.name}</DialogTitle></DialogHeader>
          {detail && (
            <div className="grid md:grid-cols-2 gap-4 mt-1">
              {/* Media */}
              <div className="bg-muted rounded-lg overflow-hidden flex items-center justify-center min-h-[300px]">
                {detail.media_type === "image" && detail.file_path ? (
                  <img src={getUploadUrl(detail.file_path)} alt={detail.name} className="w-full max-h-[60vh] object-contain" />
                ) : detail.media_type === "video" && detail.file_path ? (
                  <video src={getUploadUrl(detail.file_path)} controls autoPlay className="w-full max-h-[60vh] bg-black" />
                ) : (
                  <FileText className="w-12 h-12 text-muted-foreground/40" />
                )}
              </div>
              {/* Text */}
              <div className="flex flex-col gap-2">
                <p className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                  <FileText className="w-3.5 h-3.5 text-primary" /> Creative text
                </p>
                <Textarea value={detailText} onChange={e => setDetailText(e.target.value)}
                  placeholder="Hook, copy, script... everything about this creative."
                  className="flex-1 min-h-[220px] text-sm resize-none" />
                <div className="flex items-center justify-end gap-2">
                  {detailText && (
                    <Button variant="outline" size="sm" className="gap-1.5"
                      onClick={() => { navigator.clipboard.writeText(detailText); toast({ title: "Copied to clipboard" }); }}>
                      <Copy className="w-3.5 h-3.5" /> Copy
                    </Button>
                  )}
                  <Button variant="outline" size="sm" className="gap-1.5" onClick={() => downloadOne(detail)}>
                    <Download className="w-3.5 h-3.5" /> Download
                  </Button>
                  <Button size="sm" onClick={saveDetailText} disabled={busy || detailText === (detail.tags || "")}
                    className="bg-primary text-white gap-1.5">
                    {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
                    Save text
                  </Button>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

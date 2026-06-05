import { useState, useRef, useEffect, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetProjectQueryKey, getGetProjectStatsQueryKey, getListProjectsQueryKey } from "@/lib/projecthub-api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Upload, FileText, Image, Download, X, Pencil, Check, FolderOpen, Plus, Trash2 } from "lucide-react";
import { getUploadUrl } from "@/lib/projecthub-storage";

const BASE_URL = "";

type ProjectFile = {
  id: number;
  file_type: string;
  file_path: string;
  original_name: string;
  created_at: string;
};

type ProductBriefSection = { id: string; label: string };

const STEP_COLORS = [
  "bg-violet-500 text-white",
  "bg-rose-500 text-white",
  "bg-amber-500 text-black",
  "bg-sky-500 text-white",
  "bg-emerald-500 text-white",
  "bg-pink-500 text-white",
  "bg-indigo-500 text-white",
];

// ─── LIGHTBOX ───
function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <button className="absolute top-4 right-4 text-white/80 hover:text-white" onClick={onClose}>
        <X className="w-6 h-6" />
      </button>
      <img src={src} alt={alt} className="max-w-full max-h-[90vh] object-contain rounded-lg" onClick={(e) => e.stopPropagation()} />
    </div>
  );
}

// ─── UPLOAD BUTTON ───
function UploadBtn({ projectId, fileType, label, accept, multiple }: {
  projectId: string;
  fileType: string;
  label: string;
  accept: string;
  multiple?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [uploading, setUploading] = useState(false);

  const handleFiles = async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file_type", fileType);
      files.forEach((f) => formData.append("files", f));
      const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/files`, { method: "POST", body: formData });
      // The route returns either `{ inserted, failures }` (≥1 successful
      // upload) or `{ error, failures, hint }` (everything failed). The old
      // shape (a raw array) is also handled for backward compat with any
      // in-flight clients still talking to the previous deploy.
      let body: { inserted?: unknown[]; failures?: { name: string; reason: string }[]; error?: string; hint?: string } | unknown[] | null = null;
      try { body = await r.json(); } catch { /* non-JSON response */ }

      if (r.ok) {
        queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
        queryClient.invalidateQueries({ queryKey: getGetProjectStatsQueryKey(projectId) });
        const failures = !Array.isArray(body) ? body?.failures || [] : [];
        if (failures.length > 0) {
          toast({
            title: "Some files were not uploaded",
            description: failures.map(f => `${f.name}: ${f.reason}`).join("\n"),
            variant: "destructive",
          });
        } else {
          toast({ title: "File uploaded!" });
        }
      } else {
        const reason = !Array.isArray(body) ? body?.error : null;
        const hint = !Array.isArray(body) ? body?.hint : null;
        toast({
          title: "Upload error",
          description: [reason, hint].filter(Boolean).join("\n") || `HTTP ${r.status}`,
          variant: "destructive",
        });
      }
    } catch (err) {
      toast({
        title: "Network error",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <>
      <Button type="button" variant="outline" size="sm" disabled={uploading}
        onClick={() => inputRef.current?.click()} className="gap-1.5 text-xs h-8">
        <Upload className="w-3.5 h-3.5" />
        {uploading ? "Uploading..." : label}
      </Button>
      <input ref={inputRef} type="file" accept={accept} multiple={multiple} className="hidden"
        onChange={(e) => handleFiles(Array.from(e.target.files || []))} />
    </>
  );
}

// ─── FILE ROW ───
function FileRow({ file, onDelete }: { file: ProjectFile; onDelete: (id: number) => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const handleDelete = async () => {
    try {
      const r = await fetch(`${BASE_URL}/api/projecthub/projects/${file.project_id ?? 0}/files/${file.id}`, { method: "DELETE" });
      if (r.ok || r.status === 204) {
        onDelete(file.id);
        toast({ title: "File deleted" });
      }
    } catch { toast({ title: "Delete error", variant: "destructive" }); }
  };

  return (
    <div className="flex items-center gap-3 p-3 bg-muted/40 border border-border rounded-lg hover:bg-muted/60 hover:border-primary/30 transition-all group">
      <FileText className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors flex-shrink-0" />
      <a href={getUploadUrl(file.file_path)} download={file.original_name}
        className="flex-1 text-sm text-foreground truncate hover:text-primary transition-colors">
        {file.original_name}
      </a>
      <a href={getUploadUrl(file.file_path)} download={file.original_name}
        className="text-muted-foreground hover:text-primary transition-colors flex-shrink-0">
        <Download className="w-3.5 h-3.5" />
      </a>
      <button onClick={handleDelete}
        className="text-muted-foreground hover:text-destructive transition-colors opacity-0 group-hover:opacity-100 flex-shrink-0">
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

// ─── GENERAL BRIEF TAB CONTENT ───
function GeneralBriefTabContent({ projectId, files, projectName }: {
  projectId: string;
  files: ProjectFile[];
  projectName: string;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(projectName);
  const [savingName, setSavingName] = useState(false);

  const byType = (t: string) => files.filter(f => f.file_type === t);

  const saveName = async () => {
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === projectName) { setEditingName(false); setNameDraft(projectName); return; }
    setSavingName(true);
    try {
      const r = await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (r.ok) {
        queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
        queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
        toast({ title: "Name updated!" });
        setEditingName(false);
      } else {
        toast({ title: "Error saving", variant: "destructive" });
      }
    } catch {
      toast({ title: "Network error", variant: "destructive" });
    } finally { setSavingName(false); }
  };

  const deleteFile = (id: number) => {
    queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
  };

  return (
    <div className="space-y-6">
      {/* Project Name */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <FolderOpen className="w-3.5 h-3.5 text-primary" /> Project Name
        </h3>
        {editingName ? (
          <div className="flex items-center gap-2">
            <Input autoFocus value={nameDraft} onChange={e => setNameDraft(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") saveName(); if (e.key === "Escape") { setEditingName(false); setNameDraft(projectName); } }}
              className="text-base font-medium max-w-sm" placeholder="Project name..." disabled={savingName} />
            <Button size="sm" onClick={saveName} disabled={savingName} className="bg-primary text-white gap-1.5">
              <Check className="w-3.5 h-3.5" /> {savingName ? "Saving..." : "Save"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => { setEditingName(false); setNameDraft(projectName); }}>
              <X className="w-3.5 h-3.5" />
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-3 group">
            <p className="text-base font-semibold text-foreground">{projectName || "—"}</p>
            <button onClick={() => { setNameDraft(projectName); setEditingName(true); }}
              className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-muted text-muted-foreground transition-all">
              <Pencil className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Market Research */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-sm flex items-center gap-2">
            <FileText className="w-4 h-4 text-primary" /> Market Research
          </h3>
          <UploadBtn projectId={projectId} fileType="market_research" label="Add document" accept=".pdf,.doc,.docx,.txt,.md,.markdown,.xlsx,.csv" />
        </div>
        {byType("market_research").length === 0 ? (
          <div className="border-2 border-dashed border-border rounded-lg p-8 text-center">
            <FileText className="w-8 h-8 text-muted-foreground/30 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground italic">No documents uploaded</p>
          </div>
        ) : (
          <div className="space-y-2">
            {byType("market_research").map(f => (
              <FileRow key={f.id} file={{ ...f, project_id: projectId } as any} onDelete={deleteFile} />
            ))}
          </div>
        )}
      </div>

      {/* UGC Photos */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-sm flex items-center gap-2">
            <Image className="w-4 h-4 text-primary" /> UGC Photos
            {byType("ugc").length > 0 && <Badge variant="secondary" className="text-[10px]">{byType("ugc").length}</Badge>}
          </h3>
          <UploadBtn projectId={projectId} fileType="ugc" label="Add photo" accept=".jpg,.jpeg,.png,.webp" multiple />
        </div>
        {byType("ugc").length === 0 ? (
          <div className="border-2 border-dashed border-border rounded-lg p-8 text-center">
            <Image className="w-8 h-8 text-muted-foreground/30 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground italic">No photos uploaded</p>
          </div>
        ) : (
          <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 gap-2.5">
            {byType("ugc").map(f => (
              <button key={f.id} onClick={() => setLightbox({ src: getUploadUrl(f.file_path), alt: f.original_name })}
                className="group aspect-square rounded-lg overflow-hidden border border-border bg-muted hover:border-primary/40 transition-all">
                <img src={getUploadUrl(f.file_path)} alt={f.original_name}
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
              </button>
            ))}
          </div>
        )}
      </div>

      {lightbox && <Lightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />}
    </div>
  );
}

// ─── PRODUCT BRIEF TAB CONTENT ───
function ProductBriefTabContent({ section, stepIdx, projectId, files }: {
  section: ProductBriefSection;
  stepIdx: number;
  projectId: string;
  files: ProjectFile[];
}) {
  const queryClient = useQueryClient();
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  const stepColor = STEP_COLORS[stepIdx % STEP_COLORS.length];

  const briefFiles = files.filter(f => f.file_type === section.id);
  const mockupFiles = files.filter(f => f.file_type === `img_${section.id}`);

  const deleteFile = () => {
    queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
  };

  const deleteMockup = async (fileId: number) => {
    await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/files/${fileId}`, { method: "DELETE" });
    queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
  };

  return (
    <div className="space-y-6">
      {/* Step badge */}
      <div className="flex items-center gap-3">
        <span className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold ${stepColor}`}>
          Product {stepIdx + 1} — {section.label}
        </span>
      </div>

      {/* Brief Documents */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-sm flex items-center gap-2">
            <FileText className="w-4 h-4 text-primary" /> Product Brief
            {briefFiles.length > 0 && <Badge variant="secondary" className="text-[10px]">{briefFiles.length}</Badge>}
          </h3>
          <UploadBtn projectId={projectId} fileType={section.id} label="Add document"
            accept=".pdf,.doc,.docx,.txt,.md,.markdown,.xlsx,.csv" />
        </div>
        {briefFiles.length === 0 ? (
          <div className="border-2 border-dashed border-border rounded-lg p-8 text-center">
            <FileText className="w-8 h-8 text-muted-foreground/30 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground italic">No documents uploaded</p>
            <p className="text-xs text-muted-foreground/60 mt-1">Upload the product brief for this funnel step</p>
          </div>
        ) : (
          <div className="space-y-2">
            {briefFiles.map(f => (
              <FileRow key={f.id} file={{ ...f, project_id: projectId } as any} onDelete={deleteFile} />
            ))}
          </div>
        )}
      </div>

      {/* Mockup Images */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-sm flex items-center gap-2">
            <Image className="w-4 h-4 text-primary" /> Product Image Mockups
            {mockupFiles.length > 0 && <Badge variant="secondary" className="text-[10px]">{mockupFiles.length}</Badge>}
          </h3>
          <UploadBtn projectId={projectId} fileType={`img_${section.id}`} label="Add images"
            accept=".jpg,.jpeg,.png,.webp" multiple />
        </div>
        {mockupFiles.length === 0 ? (
          <div className="border-2 border-dashed border-border rounded-lg p-8 text-center">
            <Image className="w-8 h-8 text-muted-foreground/30 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground italic">No images uploaded</p>
            <p className="text-xs text-muted-foreground/60 mt-1">Mockups, renders, product screenshots</p>
          </div>
        ) : (
          <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 gap-2.5">
            {mockupFiles.map(f => (
              <div key={f.id} className="group relative aspect-square rounded-lg overflow-hidden border border-border bg-muted">
                <button className="w-full h-full" onClick={() => setLightbox({ src: getUploadUrl(f.file_path), alt: f.original_name })}>
                  <img src={getUploadUrl(f.file_path)} alt={f.original_name}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                </button>
                <button onClick={() => deleteMockup(f.id)}
                  className="absolute top-1 right-1 p-1 rounded-full bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600">
                  <Trash2 className="w-2.5 h-2.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {lightbox && <Lightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />}
    </div>
  );
}

// ─── MAIN EXPORT ───
export function GeneralBriefSection({ projectId, files, projectName }: {
  projectId: string;
  files: ProjectFile[];
  projectName: string;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [activeTab, setActiveTab] = useState<"general" | string>("general");
  const [pbSections, setPbSections] = useState<ProductBriefSection[]>([{ id: "pb_frontend", label: "Frontend" }]);
  const [pbLoaded, setPbLoaded] = useState(false);
  // Inline rename state for the active product brief tab
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  // Load sections
  useEffect(() => {
    fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/product-brief-sections`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (Array.isArray(data)) setPbSections(data); })
      .catch(() => {})
      .finally(() => setPbLoaded(true));
  }, [projectId]);

  // One-shot backfill: re-extract text from every file in `project_files`
  // (Supabase Storage) into the legacy JSONB columns the rewrite pipeline
  // reads. Idempotent server-side — only writes when there's something new
  // to mirror — so the cost is one cheap SELECT after the initial migration
  // pass. This unsticks projects whose files were uploaded BEFORE the POST
  // route gained text-extraction, where the rewrite reported "Brief mancante"
  // even though the user could see the file in the UI.
  const backfillRanRef = useRef<string | null>(null);
  useEffect(() => {
    if (backfillRanRef.current === projectId) return;
    backfillRanRef.current = projectId;
    fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/files/backfill`, {
      method: "POST",
    })
      .then(r => r.ok ? r.json() : null)
      .then((res: { backfilled?: Record<string, number> } | null) => {
        const total = res?.backfilled
          ? Object.values(res.backfilled).reduce((a, b) => a + b, 0)
          : 0;
        if (total > 0) {
          // Refresh the project so the brief picks up the newly-mirrored
          // content immediately (rewrite reads it from the project, not
          // from project_files).
          queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
          queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
        }
      })
      .catch(() => { /* best-effort */ });
  }, [projectId, queryClient]);

  const saveSections = useCallback(async (sections: ProductBriefSection[]) => {
    await fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/product-brief-sections`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sections }),
    });
  }, [projectId]);

  const addSection = () => {
    const otoNumbers = pbSections
      .map(s => { const m = s.label.match(/^OTO(\d+)$/i); return m ? Number(m[1]) : 0; })
      .filter(n => n > 0);
    const nextOto = otoNumbers.length > 0 ? Math.max(...otoNumbers) + 1 : 2;
    const newSection: ProductBriefSection = {
      id: `pb_oto${nextOto}_${Date.now()}`,
      label: `OTO${nextOto}`,
    };
    const updated = [...pbSections, newSection];
    setPbSections(updated);
    saveSections(updated);
    setActiveTab(newSection.id);
  };

  const renameSection = (id: string, label: string) => {
    const updated = pbSections.map(s => s.id === id ? { ...s, label } : s);
    setPbSections(updated);
    saveSections(updated);
    setRenamingId(null);
  };

  const deleteSection = async (id: string) => {
    // Remove all files for this section
    const sectionFiles = files.filter(f => f.file_type === id || f.file_type === `img_${id}`);
    await Promise.all(sectionFiles.map(f =>
      fetch(`${BASE_URL}/api/projecthub/projects/${projectId}/files/${f.id}`, { method: "DELETE" })
    ));
    if (sectionFiles.length > 0) {
      queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
    }
    const updated = pbSections.filter(s => s.id !== id);
    setPbSections(updated);
    saveSections(updated);
    // Switch to general or previous tab
    if (activeTab === id) {
      const remaining = pbSections.filter(s => s.id !== id);
      setActiveTab(remaining.length > 0 ? remaining[remaining.length - 1].id : "general");
    }
    toast({ title: "Tab deleted" });
  };

  const saveRename = (id: string) => {
    const t = renameDraft.trim();
    const section = pbSections.find(s => s.id === id);
    if (t && section && t !== section.label) renameSection(id, t);
    else setRenamingId(null);
  };

  if (!pbLoaded) {
    return <div className="py-12 text-center text-xs text-muted-foreground">Loading...</div>;
  }

  return (
    <div className="space-y-0">
      {/* ── TAB BAR ── */}
      <div className="flex items-center gap-1 border-b border-border pb-0 mb-6 overflow-x-auto">
        {/* General Brief tab */}
        <button
          onClick={() => setActiveTab("general")}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-all -mb-px ${
            activeTab === "general"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
          }`}>
          <FileText className="w-3.5 h-3.5" />
          General Brief
        </button>

        {/* Product Brief tabs */}
        {pbSections.map((section, idx) => {
          const isActive = activeTab === section.id;
          const isRenaming = renamingId === section.id;
          const stepColor = STEP_COLORS[idx % STEP_COLORS.length];

          return (
            <div key={section.id} className={`group/tab flex items-center gap-1 border-b-2 -mb-px transition-all ${
              isActive ? "border-primary" : "border-transparent"
            }`}>
              <button
                onClick={() => setActiveTab(section.id)}
                className={`flex items-center gap-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors ${
                  isActive ? "text-primary" : "text-muted-foreground hover:text-foreground"
                }`}>
                <span className={`inline-flex items-center justify-center w-4.5 h-4.5 rounded-full text-[9px] font-black w-[18px] h-[18px] flex-shrink-0 ${stepColor}`}>
                  {idx + 1}
                </span>
                {isRenaming ? (
                  <input
                    autoFocus
                    value={renameDraft}
                    onChange={e => setRenameDraft(e.target.value)}
                    onKeyDown={e => {
                      e.stopPropagation();
                      if (e.key === "Enter") saveRename(section.id);
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                    onBlur={() => saveRename(section.id)}
                    onClick={e => e.stopPropagation()}
                    className="w-24 text-sm font-medium bg-transparent border-b border-primary outline-none text-foreground"
                    placeholder="Name..."
                  />
                ) : (
                  <span>Product Brief — {section.label}</span>
                )}
              </button>
              {/* Rename + Delete controls, visible on hover or when active */}
              {!isRenaming && (
                <div className="flex items-center gap-0.5 opacity-0 group-hover/tab:opacity-100 transition-opacity pr-1">
                  <button
                    onClick={(e) => { e.stopPropagation(); setRenameDraft(section.label); setRenamingId(section.id); setActiveTab(section.id); }}
                    className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                    title="Rename">
                    <Pencil className="w-3 h-3" />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); deleteSection(section.id); }}
                    className="p-0.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                    title="Delete tab">
                    <X className="w-3 h-3" />
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {/* Add tab button */}
        <button
          onClick={addSection}
          className="flex items-center gap-1.5 px-3 py-2.5 text-xs font-semibold text-muted-foreground hover:text-primary hover:bg-primary/5 rounded-t-lg transition-all whitespace-nowrap border-b-2 border-transparent -mb-px">
          <Plus className="w-3.5 h-3.5" />
          Add
        </button>
      </div>

      {/* ── TAB CONTENT ── */}
      {activeTab === "general" && (
        <GeneralBriefTabContent projectId={projectId} files={files} projectName={projectName} />
      )}
      {pbSections.map((section, idx) =>
        activeTab === section.id ? (
          <ProductBriefTabContent
            key={section.id}
            section={section}
            stepIdx={idx}
            projectId={projectId}
            files={files}
          />
        ) : null
      )}
    </div>
  );
}

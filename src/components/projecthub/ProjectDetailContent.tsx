'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { FunnelTab } from '@/components/projecthub/funnel-builder/FunnelTab';
import { GeneralBriefSection } from '@/components/projecthub/general-brief/GeneralBriefSection';
import { CreativeSection } from '@/components/projecthub/creative/CreativeSection';
import { ChiefSection } from '@/components/projecthub/chief/ChiefSection';
import { AnalyticsSection } from '@/components/projecthub/analytics/AnalyticsSection';
import { CompetitorLibrarySection } from '@/components/projecthub/competitor-library/CompetitorLibrarySection';
import {
  useGetProject,
  getGetProjectQueryKey,
} from '@/lib/projecthub-api';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { getUploadUrl } from '@/lib/projecthub-storage';
import {
  ArrowLeft, FileText, Layers, Palette, Brain, BarChart2,
  ChevronLeft, ChevronRight, Globe2,
} from 'lucide-react';

type Section = 'brief' | 'funnel' | 'competitor-library' | 'creative' | 'chief' | 'analytics';

type ProjectFile = {
  id: number;
  file_type: string;
  file_path: string;
  original_name: string;
  created_at: string;
};

const SECTIONS = [
  { id: 'brief' as Section, label: 'General Brief', icon: FileText },
  { id: 'funnel' as Section, label: 'Funnel', icon: Layers },
  { id: 'competitor-library' as Section, label: 'Competitor Library', icon: Globe2 },
  { id: 'creative' as Section, label: 'Creative', icon: Palette },
  { id: 'chief' as Section, label: 'Chief', icon: Brain },
  { id: 'analytics' as Section, label: 'Analytics', icon: BarChart2 },
];

export function ProjectDetailContent({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [activeSection, setActiveSection] = useState<Section>('brief');
  const [collapsed, setCollapsed] = useState(false);

  const { data: project, isLoading } = useGetProject(projectId, {
    query: { enabled: !!projectId, queryKey: getGetProjectQueryKey(projectId) },
  });

  if (isLoading) {
    return (
      <div className="flex h-screen bg-background">
        <aside className="w-56 bg-card border-r border-border flex flex-col p-4 gap-3">
          <Skeleton className="h-6 w-32" />
          {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-9 w-full rounded-lg" />)}
        </aside>
        <main className="flex-1 p-8 space-y-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-48 w-full rounded-xl" />
        </main>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <h2 className="text-lg font-semibold text-foreground mb-2">Progetto non trovato</h2>
          <Button onClick={() => router.push('/projects')} variant="outline" className="gap-2">
            <ArrowLeft className="w-4 h-4" /> Torna ai Progetti
          </Button>
        </div>
      </div>
    );
  }

  const files: ProjectFile[] = (project as { files?: ProjectFile[] }).files || [];
  const activeItem = SECTIONS.find(s => s.id === activeSection)!;

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      <aside className={`${collapsed ? 'w-14' : 'w-56'} bg-card border-r border-border flex flex-col transition-all duration-200 flex-shrink-0`}>
        <div className={`border-b border-border p-3 flex items-center gap-2 ${collapsed ? 'justify-center' : 'justify-between'}`}>
          {!collapsed && (
            <button
              onClick={() => router.push('/projects')}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors min-w-0"
            >
              <ArrowLeft className="w-3.5 h-3.5 flex-shrink-0" />
              <span className="truncate font-medium">Progetti</span>
            </button>
          )}
          <button
            onClick={() => setCollapsed(c => !c)}
            className="p-1 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
          >
            {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          </button>
        </div>

        {!collapsed && (
          <div className="px-3 pt-3 pb-2 border-b border-border">
            <div className="flex items-center gap-2 min-w-0">
              {project.thumbnail_path ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={getUploadUrl(project.thumbnail_path)}
                  alt={project.name}
                  className="w-7 h-7 rounded-md object-cover border border-border flex-shrink-0"
                />
              ) : (
                <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <span className="text-primary font-bold text-xs">{project.name.charAt(0).toUpperCase()}</span>
                </div>
              )}
              <p className="text-sm font-semibold text-foreground truncate leading-tight">{project.name}</p>
            </div>
          </div>
        )}

        <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto">
          {SECTIONS.map(section => {
            const Icon = section.icon;
            const active = activeSection === section.id;
            return (
              <button
                key={section.id}
                data-testid={`nav-${section.id}`}
                onClick={() => setActiveSection(section.id)}
                title={collapsed ? section.label : undefined}
                className={`w-full flex items-center gap-3 px-2.5 py-2 rounded-lg text-sm font-medium transition-all ${
                  active
                    ? 'bg-primary text-white shadow-sm'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                } ${collapsed ? 'justify-center' : ''}`}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                {!collapsed && <span className="truncate">{section.label}</span>}
              </button>
            );
          })}
        </nav>
      </aside>

      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="bg-card border-b border-border px-6 py-3 flex items-center gap-2 flex-shrink-0">
          {collapsed && (
            <button onClick={() => router.push('/projects')} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mr-1">
              <ArrowLeft className="w-3.5 h-3.5" />
            </button>
          )}
          <span className="text-xs text-muted-foreground">{project.name}</span>
          <span className="text-xs text-muted-foreground">/</span>
          <span className="text-xs font-medium text-foreground">{activeItem.label}</span>
        </header>

        <main className="flex-1 overflow-y-auto">
          <div className="max-w-6xl mx-auto px-6 py-6 pb-12">
            {activeSection === 'brief' && (
              <GeneralBriefSection
                projectId={projectId}
                files={files}
                projectName={project.name ?? ''}
              />
            )}
            {activeSection === 'funnel' && (
              <div className="space-y-4">
                <div>
                  <h2 className="text-xl font-semibold text-foreground mb-1 flex items-center gap-2">
                    <Layers className="w-5 h-5 text-primary" /> Funnel Builder
                  </h2>
                  <p className="text-sm text-muted-foreground">Costruisci il tuo funnel passo per passo con generazione AI integrata.</p>
                </div>
                <FunnelTab projectId={projectId} />
              </div>
            )}
            {activeSection === 'competitor-library' && (
              <CompetitorLibrarySection projectId={projectId} />
            )}
            {activeSection === 'creative' && (
              <CreativeSection projectId={projectId} />
            )}
            {activeSection === 'chief' && (
              <ChiefSection projectId={projectId} />
            )}
            {activeSection === 'analytics' && (
              <AnalyticsSection projectId={projectId} />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

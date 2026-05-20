'use client';

import { ProjectHubProvider } from '@/components/projecthub/ProjectHubProvider';
import { ProjectDetailContent } from '@/components/projecthub/ProjectDetailContent';

export default function ProjectDetailPage({
  params,
}: {
  params: { id: string };
}) {
  return (
    <ProjectHubProvider>
      <ProjectDetailContent projectId={params.id} />
    </ProjectHubProvider>
  );
}

'use client';

import { use } from 'react';
import { ProjectHubProvider } from '@/components/projecthub/ProjectHubProvider';
import { ProjectDetailContent } from '@/components/projecthub/ProjectDetailContent';

export default function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  return (
    <ProjectHubProvider>
      <ProjectDetailContent projectId={id} />
    </ProjectHubProvider>
  );
}

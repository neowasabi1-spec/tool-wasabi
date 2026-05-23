/**
 * Canonical list of dashboard sections the user-permissions system
 * controls. The `id` is the value stored in `app_user_permissions.sections`
 * and used by the AuthGate / Sidebar to decide what to show.
 *
 * KEEP IN SYNC with the `app_handle_new_user()` trigger in
 * `supabase-migration-user-permissions.sql` — the master role is granted
 * exactly the sections listed here.
 */

export interface DashboardSection {
  /** Stable id stored in DB. */
  id: string;
  /** Human label shown in the admin UI + sidebar. */
  label: string;
  /** Primary URL path this section owns. Used by AuthGate to match the
   *  current pathname against the allowed list. */
  path: string;
  /** Optional additional path prefixes that also belong to this section
   *  (e.g. /projects/[id]). */
  extraPathPrefixes?: string[];
  /** If true, only masters see this in the sidebar. Granted to masters
   *  automatically. Stored in DB as a regular id so masters can also
   *  delegate it to other users in the future. */
  masterOnlyByDefault?: boolean;
}

export const DASHBOARD_SECTIONS: DashboardSection[] = [
  {
    id: 'front-end-funnel',
    label: 'Front-End Funnel',
    path: '/front-end-funnel',
  },
  {
    id: 'quiz-swipe',
    label: 'Clone / Swipe Quiz',
    path: '/quiz-swipe',
  },
  {
    id: 'templates',
    label: 'My Archive',
    path: '/templates',
  },
  {
    id: 'products',
    label: 'Catalogue',
    path: '/products',
  },
  {
    id: 'projects',
    label: 'My Projects',
    path: '/projects',
    extraPathPrefixes: ['/projects/'],
  },
  {
    id: 'checkpoint',
    label: 'Checkpoint',
    path: '/checkpoint',
    extraPathPrefixes: ['/checkpoint/'],
  },
  {
    id: 'protocollo-valchiria',
    label: 'Protocollo Valchiria',
    path: '/protocollo-valchiria',
  },
  {
    id: 'api-keys',
    label: 'API Keys',
    path: '/api-keys',
  },
  {
    id: 'api-usage',
    label: 'Spesa API',
    path: '/api-usage',
  },
  {
    id: 'admin-users',
    label: 'Users',
    path: '/admin/users',
    extraPathPrefixes: ['/admin/'],
    masterOnlyByDefault: true,
  },
];

/** All section ids — used by the SQL migration's master grant and by the
 *  admin UI's "select all" button. */
export const ALL_SECTION_IDS = DASHBOARD_SECTIONS.map(s => s.id);

/** Default sections suggested for a new collaborator when the master
 *  opens the "create user" form. Intentionally excludes the admin /
 *  billing-ish pages — the master will check what they want. */
export const SAFE_DEFAULT_SECTIONS = [
  'front-end-funnel',
  'quiz-swipe',
  'templates',
  'products',
  'projects',
  'checkpoint',
];

/** Return the section that owns the given pathname, or null if the path
 *  doesn't belong to any known section (e.g. `/`, `/login`, `/no-access`). */
export function findSectionByPath(pathname: string): DashboardSection | null {
  for (const section of DASHBOARD_SECTIONS) {
    if (pathname === section.path) return section;
    if (pathname.startsWith(section.path + '/')) return section;
    for (const prefix of section.extraPathPrefixes || []) {
      if (pathname === prefix.replace(/\/$/, '')) return section;
      if (pathname.startsWith(prefix)) return section;
    }
  }
  return null;
}

export type AppRole = 'master' | 'user';

export interface AppUserPermissions {
  user_id: string;
  role: AppRole;
  sections: string[];
  created_at: string;
  updated_at: string;
}

export interface AppUserWithEmail extends AppUserPermissions {
  email: string;
  last_sign_in_at: string | null;
}

/** Helper: a master implicitly has access to every section regardless of
 *  what's stored in `sections`. Use this instead of raw `.includes()`. */
export function canAccessSection(
  permissions: Pick<AppUserPermissions, 'role' | 'sections'> | null | undefined,
  sectionId: string,
): boolean {
  if (!permissions) return false;
  if (permissions.role === 'master') return true;
  return permissions.sections.includes(sectionId);
}

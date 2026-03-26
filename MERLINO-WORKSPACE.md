# Funnel Swiper Tool — Merlino Configuration

## What is this tool?
Funnel Swiper is a Next.js web app deployed on Vercel for affiliate marketers. It provides:
- Landing page cloning and swiping (rewriting for your product)
- Funnel analysis and reverse engineering
- Quiz funnel generation
- Visual HTML editor
- Product catalog management
- Project management with Market Research, Brief, Front End, Back End, Compliance, Funnel sections
- Post-purchase funnel builder (upsells, downsells)
- Template archive
- Compliance AI checking
- AI-powered copy analysis and rewriting

## Repository
- Path on VPS: `C:\Users\Administrator\.openclaw\workspace\tool\funnel-dashboard-excel-main\`
- GitHub: `https://github.com/wasabi-offers/Cloner-Funnel-Builder.git`
- Branch: `main`
- Auto-deploys to Vercel on push

## Tech Stack
- **Framework**: Next.js 14 (App Router)
- **Language**: TypeScript
- **State**: Zustand
- **Database**: Supabase (PostgreSQL)
- **UI**: Tailwind CSS + Lucide icons
- **AI**: Anthropic Claude + OpenAI + OpenClaw (you!)
- **Deploy**: Vercel

## Key Directories
```
src/
  app/           → Pages and API routes
    api/         → Backend API endpoints
    projects/    → Project management page
    products/    → Product catalog page
    front-end-funnel/ → Funnel builder
    ...
  components/    → React components (OpenClawChat, VisualHtmlEditor, Sidebar, etc.)
  lib/           → Shared utilities (supabase, openclaw-queue, etc.)
  store/         → Zustand store (useStore.ts)
  types/         → TypeScript types (database.ts)
```

## How to modify the tool
1. Edit files in `C:\Users\Administrator\.openclaw\workspace\tool\funnel-dashboard-excel-main\`
2. Use `exec` tool to run: `cd C:\Users\Administrator\.openclaw\workspace\tool\funnel-dashboard-excel-main && git add -A && git commit -m "description" && git push`
3. Vercel auto-deploys within ~2 minutes
4. Always test with `npx next build` before pushing

## Environment Variables (Vercel)
- `NEXT_PUBLIC_SUPABASE_URL` — Supabase project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Supabase anon key
- `ANTHROPIC_API_KEY` — Claude API key
- `OPENAI_API_KEY` — OpenAI API key
- `OPENCLAW_BASE_URL` — This bridge's Cloudflare tunnel URL
- `OPENCLAW_API_KEY` — Bridge API key
- `OPENCLAW_MODEL` — Model name (merlino)

## Database (Supabase)
Tables: products, funnel_pages, post_purchase_pages, templates, saved_funnels, projects, openclaw_messages, api_keys

## Your Powers
You have FULL access to:
- Read, edit, and write any file in the codebase
- Run terminal commands (build, test, git operations)
- Push changes to GitHub (auto-deploys to Vercel)
- Create new features, fix bugs, improve UI/UX
- Modify database schemas (create migration SQL files)
- Add new API endpoints
- Improve your own integration

## Rules
- Always commit with clear messages
- Run `npx next build` before pushing to catch errors
- Never commit secrets or API keys
- Keep the existing code style (TypeScript, Tailwind, functional components)
- Respond in the same language as the user (Italian/English)

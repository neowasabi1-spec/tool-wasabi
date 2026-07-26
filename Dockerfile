# syntax = docker/dockerfile:1
# Playwright richiede Chromium + dipendenze: usiamo node:20-bookworm + install --with-deps
# ---- Base ----
FROM node:20-bookworm AS base
WORKDIR /app

# ---- Dependencies ----
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci

# ---- Build ----
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_TELEMETRY_DISABLED=1
ENV STANDALONE=true
RUN npm run build
# Installa Chromium per Playwright (usato da /api/funnel-analyzer/crawl)
RUN npx playwright install --with-deps chromium

# ---- Runner ----
FROM base AS runner
# Dipendenze di sistema per Chromium (usa lo stesso script Playwright)
RUN npx -y playwright@1.58.2 install-deps chromium
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=build /app/public ./public
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
# Copia browser Playwright da build (install --with-deps li mette in ~/.cache/ms-playwright)
COPY --from=build /root/.cache/ms-playwright /home/nextjs/.cache/ms-playwright
RUN chown -R nextjs:nodejs /home/nextjs/.cache
ENV PLAYWRIGHT_BROWSERS_PATH=/home/nextjs/.cache/ms-playwright

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
CMD ["node", "server.js"]

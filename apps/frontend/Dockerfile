# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — Dependency Installer (deps)
#   Isolated layer for node_modules so the builder stage can copy them without
#   re-running npm ci on every source change.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Required for some native npm packages on Alpine
RUN apk add --no-cache libc6-compat

# Copy manifests only — layer is cached unless package.json/lock changes
COPY package.json package-lock.json ./

# Install ALL deps (devDeps needed by Next.js build toolchain)
RUN npm ci


# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — Builder
#   Receives the API URL as a build argument so the same Dockerfile works for
#   every environment (dev / staging / prod) without code changes.
#   Next.js bakes NEXT_PUBLIC_* vars at compile time, so the ARG must be
#   provided before `next build`.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# ── Build-time configuration ─────────────────────────────────────────────────
# Override with --build-arg NEXT_PUBLIC_API_URL=<url> for different environments
ARG NEXT_PUBLIC_API_URL=https://api.ess.develop.thefusionapps.com
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

# Google Analytics 4 measurement id (e.g. G-XXXXXXXXXX).
# Empty by default: the analytics layer renders nothing and fetches nothing
# unless a real id is baked in, so dev and CI images stay untracked.
# Must be a BUILD arg — NEXT_PUBLIC_* is inlined by `next build`, so setting it
# on the running container has no effect at all.
ARG NEXT_PUBLIC_GA_MEASUREMENT_ID=
ENV NEXT_PUBLIC_GA_MEASUREMENT_ID=$NEXT_PUBLIC_GA_MEASUREMENT_ID

# Microsoft Clarity project id (e.g. y9zmq4qs0j).
# Empty by default for the same reason as the GA id above: no id, no tag, no
# session recording — so dev and CI images stay unrecorded. Also a BUILD arg,
# because NEXT_PUBLIC_* is inlined by `next build`.
ARG NEXT_PUBLIC_CLARITY_PROJECT_ID=
ENV NEXT_PUBLIC_CLARITY_PROJECT_ID=$NEXT_PUBLIC_CLARITY_PROJECT_ID
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Inherit the resolved node_modules from the deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy all application source files
COPY . .

# Run Next.js production build.
# With `output: 'standalone'` in next.config.ts, this emits:
#   .next/standalone/   — self-contained minimal server (no node_modules needed)
#   .next/static/       — hashed client assets
#   public/             — static public files
RUN npm run build


# ─────────────────────────────────────────────────────────────────────────────
# Stage 3 — Runner
#   Ultra-minimal Alpine image that only contains:
#     • the standalone server bundle (server.js + embedded runtime)
#     • static assets
#     • public assets
#   No node_modules, no TypeScript toolchain, no devDeps.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Create a non-root user for security
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

# ── Copy standalone server output ─────────────────────────────────────────────
# The standalone directory contains server.js + a trimmed node_modules.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./

# ── Copy static & public assets ──────────────────────────────────────────────
# These must sit next to server.js so Next.js can serve them.
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs

# ── Expose & launch ──────────────────────────────────────────────────────────
EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# The standalone bundle ships with its own minimal server.js at the root.
CMD ["node", "server.js"]

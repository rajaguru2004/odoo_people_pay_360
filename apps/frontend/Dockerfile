# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — Dependency Installer (deps)
#   Isolated layer for node_modules so the builder can copy them without
#   re-installing on every source change.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Required by some native npm packages on Alpine.
RUN apk add --no-cache libc6-compat

COPY package.json package-lock.json* ./
RUN npm install


# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — Builder
#   Every NEXT_PUBLIC_* value is INLINED by `next build`, so each one has to
#   arrive as a build ARG. Setting them on the running container does nothing at
#   all — that is the single most common cause of "the deployed app is talking
#   to the wrong API".
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

ARG NEXT_PUBLIC_API_URL=http://localhost:3011
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

ARG NEXT_PUBLIC_APP_NAME="People Pay 360"
ENV NEXT_PUBLIC_APP_NAME=$NEXT_PUBLIC_APP_NAME

# Empty by default: with no id the analytics layer renders nothing and fetches
# nothing, so dev and CI images stay untracked.
ARG NEXT_PUBLIC_GA_MEASUREMENT_ID=
ENV NEXT_PUBLIC_GA_MEASUREMENT_ID=$NEXT_PUBLIC_GA_MEASUREMENT_ID

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Opt in to the standalone bundle. It is off by default in next.config.ts so
# that `next start` keeps working outside this image — see the note there.
ENV NEXT_OUTPUT_STANDALONE=true

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# With `output: 'standalone'` in next.config.ts this emits:
#   .next/standalone/  — self-contained server (no node_modules needed)
#   .next/static/      — hashed client assets
RUN npm run build


# ─────────────────────────────────────────────────────────────────────────────
# Stage 3 — Runner
#   Minimal image: the standalone bundle, static assets, public assets. No
#   node_modules, no TypeScript toolchain, no devDeps.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
# These must sit next to server.js for Next to serve them.
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# The standalone bundle ships its own minimal server.js at the root.
CMD ["node", "server.js"]

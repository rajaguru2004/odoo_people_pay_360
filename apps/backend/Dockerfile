# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — Builder
#   Installs ALL dependencies (including devDeps for ts-node / nest CLI / prisma)
#   and compiles the NestJS application to dist/.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# Install native build-time dependencies
# (canvas, @napi-rs/canvas, bcrypt all require these at compile time)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    build-essential \
    libcairo2-dev \
    libjpeg-dev \
    libpango1.0-dev \
    libgif-dev \
    librsvg2-dev \
    openssl \
    && rm -rf /var/lib/apt/lists/*

# Copy dependency manifests first to maximise Docker layer caching.
# If package.json / package-lock.json are unchanged the npm ci layer is reused.
COPY package.json package-lock.json ./

# We depend on puppeteer-CORE and supply Chromium from the distro (see runner
# stage), so nothing should ever download a second browser during install.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Install all deps (devDeps are needed for: nest build, prisma generate, ts-node seed).
# Registry pulls occasionally drop mid-download (ECONNRESET) — worst on the native
# prebuilds (canvas / bcrypt). Raise npm's network timeouts/retries and retry the
# whole install up to 5x so a flaky connection can't fail the build.
ENV npm_config_fetch_retries=5 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=120000 \
    npm_config_fetch_timeout=600000
RUN for i in 1 2 3 4 5; do \
      echo "npm ci (attempt $i/5)..."; \
      npm ci && break; \
      if [ "$i" = "5" ]; then echo "npm ci failed after 5 attempts" >&2; exit 1; fi; \
      echo "npm ci failed — retrying in 15s..."; sleep 15; \
    done

# Generate Prisma client before copying source (keeps this layer cached unless
# the schema changes)
COPY prisma ./prisma
RUN npx prisma generate

# Copy the rest of the source
COPY . .

# Compile TypeScript → dist/
RUN npm run build


# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — Runner
#   Minimal production image.  Installs only the runtime native libs needed by
#   canvas / @napi-rs/canvas / Prisma, then copies the compiled output and
#   node_modules (devDeps retained because ts-node + prisma CLI are used by
#   the entrypoint seed step at startup).
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-slim AS runner

WORKDIR /app

# Runtime-only native library counterparts (no -dev headers needed).
#
# chromium + fonts back PdfService (self-service letters, payslip PDFs). It is
# the heaviest thing in this image (~120MB with fonts) and it is deliberate:
# this is a bilingual en/ar deployment, and Arabic needs contextual glyph
# shaping + bidi reordering that only a real shaping engine (HarfBuzz, which
# Chromium embeds) performs correctly. fonts-noto-core/-arabic supply the
# glyphs; without them Chromium renders Arabic as empty boxes.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libcairo2 \
    libjpeg62-turbo \
    libpango-1.0-0 \
    libgif7 \
    librsvg2-2 \
    openssl \
    chromium \
    fonts-noto-core \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Fail the build here rather than shipping an image that renders every Arabic
# letter as empty boxes. fonts-noto-core is what carries NotoSansArabic and
# NotoNaskhArabic (the families the letter templates name); there is no
# `fonts-noto-arabic` package in Debian.
RUN test -f /usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf \
    && test -f /usr/share/fonts/truetype/noto/NotoNaskhArabic-Regular.ttf \
    && test -x /usr/bin/chromium

ENV NODE_ENV=production \
    CHROMIUM_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_DOWNLOAD=true

# ── Copy artifacts from builder ──────────────────────────────────────────────

# node_modules (includes devDeps — ts-node & prisma CLI are needed at runtime
# for the db push + seed entrypoint step)
COPY --from=builder /app/node_modules ./node_modules

# Compiled NestJS application
COPY --from=builder /app/dist ./dist

# Prisma schema + generated client (already embedded in node_modules/.prisma
# but schema.prisma is needed for `prisma db push`)
COPY --from=builder /app/prisma ./prisma

# package.json (required for npm run scripts called by the entrypoint)
COPY --from=builder /app/package.json ./package.json

# tsconfig (required by ts-node when running the seed script)
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# Entrypoint script
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# ── Expose & launch ──────────────────────────────────────────────────────────
EXPOSE 3001

ENTRYPOINT ["./docker-entrypoint.sh"]

# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — Builder
#   Installs ALL dependencies (devDeps included: the nest CLI, prisma and
#   ts-node are all build/startup-time tools) and compiles to dist/.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# openssl is required by Prisma's query engine; the toolchain packages are for
# bcrypt's native build.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    openssl \
    && rm -rf /var/lib/apt/lists/*

# Manifests first, so the install layer is reused whenever only source changed.
COPY package.json package-lock.json* ./

# Registry pulls occasionally drop mid-download (ECONNRESET), worst on native
# prebuilds. Raise npm's timeouts and retry the whole install so a flaky
# connection cannot fail the build.
ENV npm_config_fetch_retries=5 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=120000 \
    npm_config_fetch_timeout=600000
RUN for i in 1 2 3 4 5; do \
      echo "npm install (attempt $i/5)..."; \
      npm install && break; \
      if [ "$i" = "5" ]; then echo "npm install failed after 5 attempts" >&2; exit 1; fi; \
      echo "failed — retrying in 15s..."; sleep 15; \
    done

# Generate the Prisma client before the source copy, so this layer stays cached
# unless the schema itself changes.
COPY prisma ./prisma
RUN npx prisma generate

COPY . .

RUN npm run build


# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — Runner
#   devDeps are RETAINED: the entrypoint runs `prisma db push` and the compiled
#   seed before starting the server.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-slim AS runner

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
# schema.prisma is needed at runtime for `prisma db push`, not just at build.
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/tsconfig.json ./tsconfig.json

COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

EXPOSE 3011

ENTRYPOINT ["./docker-entrypoint.sh"]

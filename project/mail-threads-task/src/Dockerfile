# ---- Stage 1: builder ----
FROM node:20-bookworm-slim AS builder

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma

RUN npm ci

COPY . .

RUN npx prisma generate
RUN npm run build

# ---- Stage 2: runtime ----
FROM node:20-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production

RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY prisma ./prisma

RUN npm ci --omit=dev \
    && npx prisma generate \
    && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY scripts/entrypoint.sh /app/scripts/entrypoint.sh

RUN chmod +x /app/scripts/entrypoint.sh \
    && chown -R node:node /app

USER node

ENTRYPOINT ["/usr/bin/tini", "--", "/app/scripts/entrypoint.sh"]
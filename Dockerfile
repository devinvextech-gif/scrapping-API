# Stage 1: Builder
FROM node:20-bookworm AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y \
    libnss3 libnspr4 libdbus-1-3 \
    libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libpango-1.0-0 libpangocairo-1.0-0 \
    libgtk-3-0 libasound2 libatspi2.0-0 \
    wget ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm ci --only=production

# ✅ FORCE playwright install location
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN npx playwright install chromium


# Stage 2: Runtime
FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    libnss3 libnspr4 libdbus-1-3 \
    libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libpango-1.0-0 libpangocairo-1.0-0 \
    libgtk-3-0 libasound2 libatspi2.0-0 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m appuser

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /ms-playwright /ms-playwright

COPY --chown=appuser:appuser src ./src
COPY --chown=appuser:appuser package*.json ./

RUN mkdir -p /app/downloads && chown -R appuser:appuser /app/downloads

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
CMD node -e "require('http').get('http://localhost:3000/', r => { if (r.statusCode !== 200) throw new Error() })"

USER appuser

CMD ["npm", "start"]
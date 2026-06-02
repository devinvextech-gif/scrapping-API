# Multi-stage build for smaller production image
# Stage 1: Builder
FROM node:20-bookworm AS builder

WORKDIR /app

# Install system dependencies required by Playwright
RUN apt-get update && apt-get install -y \
    libnss3 \
    libnspr4 \
    libdbus-1-3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libgtk-3-0 \
    libasound2 \
    libatspi2.0-0 \
    wget \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Install dependencies (including dev dependencies for build if needed)
RUN npm ci --only=production

# Install Playwright browsers
RUN npx playwright install chromium

# Stage 2: Runtime
FROM node:20-bookworm-slim

WORKDIR /app

# Install only runtime dependencies needed by Playwright
RUN apt-get update && apt-get install -y \
    libnss3 \
    libnspr4 \
    libdbus-1-3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libgtk-3-0 \
    libasound2 \
    libatspi2.0-0 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy built node_modules and Playwright from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /root/.cache/ms-playwright ./root/.cache/ms-playwright

# Copy application code
COPY src ./src
COPY package*.json ./

# Create downloads directory and set permissions
RUN mkdir -p /app/downloads && chmod 755 /app/downloads

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Use non-root user for security
RUN useradd -m appuser && chown -R appuser:appuser /app
USER appuser

# Start the application
CMD ["npm", "start"]

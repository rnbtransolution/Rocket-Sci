# ── Multi-Stage Dockerfile for Bang Fai High-Concurrency Service ──

# Stage 1: Build TypeScript application
FROM node:18-alpine AS builder
WORKDIR /app

# Install build dependencies
COPY package*.json tsconfig.json ./
RUN npm install

# Copy source files and compile
COPY src/ ./src/
RUN npx tsc

# Stage 2: Production runtime environment
FROM node:18-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# Install production dependencies only
COPY package*.json ./
RUN npm install --omit=dev

# Copy compiled JavaScript output from builder
COPY --from=builder /app/dist-server ./dist-server

# Expose production port
EXPOSE 8080

# Run as non-root node user
USER node

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

CMD ["node", "dist-server/index.js"]

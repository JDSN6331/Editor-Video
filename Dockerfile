# Multi-stage build for Video Creator Studio with Native FFmpeg
FROM node:20-slim AS builder

WORKDIR /app

# Install build dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --global npm@11.6.2
RUN npm ci

# Copy source code and build
COPY . .
ENV NITRO_PRESET=node-server
ARG VITE_RENDER_API_URL
ENV VITE_RENDER_API_URL=${VITE_RENDER_API_URL}
RUN npm run build

# Production runner stage
FROM node:20-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NITRO_PRESET=node-server
ENV PORT=3000
ENV HOST=0.0.0.0

# Install native FFmpeg on Debian/Ubuntu
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Copy built artifacts from builder stage
COPY --from=builder /app/.output ./.output
COPY --from=builder /app/package.json ./package.json

# Expose application port
EXPOSE 3000

# Start Nitro Node.js server
CMD ["node", ".output/server/index.mjs"]

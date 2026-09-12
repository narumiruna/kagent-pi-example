FROM node:26-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig*.json ./
COPY src ./src
COPY extensions ./extensions
RUN npm run build

# Bookworm matches the glibc baseline used by the existing BYO examples.
# Node/V8 checkpoint-restore still needs validation on your Substrate version.
FROM node:26-bookworm-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    bash ca-certificates git ripgrep \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY skills ./skills
ENV HOME=/data \
    PI_DATA_DIR=/data \
    PI_CODING_AGENT_DIR=/data/agent \
    PI_GRPC_ADDRESS=0.0.0.0:80 \
    PI_HEALTH_HOST=0.0.0.0 \
    PI_HEALTH_PORT=8081 \
    PI_OFFLINE=1 \
    PI_TELEMETRY=0
EXPOSE 80 8081
CMD ["/usr/local/bin/node", "/app/dist/src/index.js"]

FROM node:24.5.0-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/admin/package.json apps/admin/package.json
COPY apps/tv/package.json apps/tv/package.json
COPY packages/providers/package.json packages/providers/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/tv-core/package.json packages/tv-core/package.json
RUN npm ci
COPY . .
ARG CLOUDFRAME_CONTAINER_TEST=0
RUN CLOUDFRAME_CONTAINER_TEST=$CLOUDFRAME_CONTAINER_TEST npm run build:server

FROM node:24.5.0-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini && rm -rf /var/lib/apt/lists/*
RUN groupadd --system --gid 10001 cloudframe && useradd --system --uid 10001 --gid cloudframe --home-dir /app --shell /usr/sbin/nologin cloudframe
WORKDIR /app
COPY --from=build --chown=cloudframe:cloudframe /src/build/self-hosted/ /app/
RUN mkdir -p /data && chown cloudframe:cloudframe /data
VOLUME ["/data"]
EXPOSE 8080
USER cloudframe
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/index.js"]

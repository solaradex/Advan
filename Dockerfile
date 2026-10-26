FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# su-exec drops root after the entrypoint chowns the Fly volume. The image
# stays USER root so that entrypoint can run; the server process is node.
RUN npm ci --omit=dev \
  && apk add --no-cache su-exec \
  && mkdir -p /app/logs \
  && chown -R node:node /app
COPY --from=build /app/dist ./dist
COPY docker/entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh
# Fly overrides this with the same path via fly.toml. Local docker run with no
# volume still works: the entrypoint creates /data owned by node.
ENV USAGE_LOG_PATH=/data/usage.jsonl
ENV HOST=0.0.0.0
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s CMD node -e "fetch('http://127.0.0.1:8787/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/http-entry.js"]

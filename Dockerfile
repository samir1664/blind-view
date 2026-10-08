# Blind View API — Cloud Run image.
# Built by Cloud Build via `gcloud run deploy --source .`; no local Docker needed.
FROM node:22-slim

WORKDIR /app

# Workspace manifests first so dependency install is cached across code edits.
# The web manifest is copied only so `npm ci` can validate the shared lockfile.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @blind-view/server --include-workspace-root=false --no-audit --no-fund

COPY apps/server apps/server

ENV NODE_ENV=production
# Cloud Run injects PORT (8080); env.ts reads it.
EXPOSE 8080

USER node
CMD ["npm", "run", "start", "--workspace", "@blind-view/server"]

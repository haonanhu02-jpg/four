ARG NODE_IMAGE=node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.28-alpine@sha256:7377697a821c131a924a7105fafbe7414db4e9fcc77a6f08f776f33f141ec3f8
FROM ${NODE_IMAGE} AS dependencies
ARG NPM_REGISTRY=https://registry.npmjs.org
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
RUN npm ci --registry="$NPM_REGISTRY"

FROM dependencies AS build
COPY . .
# Vite copies public assets with their original modes from the private checkout.
RUN npm run build && chmod -R a+rX /app/apps/web/dist

FROM ${NODE_IMAGE} AS production-dependencies
ARG NPM_REGISTRY=https://registry.npmjs.org
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
RUN npm ci --registry="$NPM_REGISTRY" --omit=dev --workspace=@workbench/api --workspace=@workbench/contracts --include-workspace-root \
    && npm cache clean --force

FROM ${NODE_IMAGE} AS api
ARG SOURCE_REVISION=unversioned
ARG RELEASE_VERSION=1.2.0
LABEL org.opencontainers.image.title="Four Layer Workbench API" org.opencontainers.image.version=$RELEASE_VERSION org.opencontainers.image.revision=$SOURCE_REVISION
ENV NODE_ENV=production PORT=3000 APP_VERSION=$RELEASE_VERSION
WORKDIR /app
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
# Git checkout under the deployment's umask 077 can produce mode 0600.
# Bootstrap runs as the host UID with all capabilities dropped, so explicitly
# make code/metadata readable while credentials remain outside the image.
COPY --chown=node:node --chmod=0644 package.json ./package.json
COPY --chown=node:node --chmod=0644 apps/api/package.json ./apps/api/package.json
COPY --chown=node:node --chmod=0644 packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/packages/contracts/dist ./packages/contracts/dist
COPY --chown=node:node database/migrations ./database/migrations
COPY --chown=node:node --chmod=0644 scripts/migrate.mjs ./scripts/migrate.mjs
COPY --chown=node:node --chmod=0644 scripts/bootstrap-admin.mjs ./scripts/bootstrap-admin.mjs
COPY --chown=node:node --chmod=0644 scripts/database-connection.mjs ./scripts/database-connection.mjs
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]

FROM ${NGINX_IMAGE} AS web
ARG SOURCE_REVISION=unversioned
ARG RELEASE_VERSION=1.2.0
LABEL org.opencontainers.image.title="Four Layer Workbench Web" org.opencontainers.image.version=$RELEASE_VERSION org.opencontainers.image.revision=$SOURCE_REVISION
COPY --chmod=0644 deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --chmod=0644 deploy/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
USER 101
EXPOSE 8080

# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
WORKDIR /app
# Build-time metadata for the /build_version endpoint. BUILD_VERSION is left empty
# unless the commit being built is exactly a release tag — see deploy-to-ecs.yml.
ARG COMMIT_SHA=unknown
ARG BUILD_VERSION=
ENV COMMIT_SHA=$COMMIT_SHA
ENV BUILD_VERSION=$BUILD_VERSION
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY spec ./spec
ENV NODE_ENV=production
EXPOSE 3000
USER nonroot
CMD ["dist/transports/http.js"]

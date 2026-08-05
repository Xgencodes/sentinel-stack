# syntax=docker/dockerfile:1.7
#
# This image depends on three sibling repos via `file:` dependencies rather
# than published packages — the honest state of a pre-org-migration
# multi-repo checkout. Each sibling is supplied as a named BuildKit
# "additional context" (see docker-compose.yml's `additional_contexts`)
# rather than a shared parent build context, so the build only ever sees
# these four repos — never the rest of the parent directory they happen to
# live in. Requires Docker Compose v2.17+ / a BuildKit-enabled Docker Engine
# (the default since Docker 23), and the `docker compose` CLI rather than
# the legacy standalone `docker-compose`.
#
# Once the repos move to the GitHub org this whole multi-context dance goes
# away in favour of a normal npm/git dependency and a single-context build
# like ehr-bridge's own Dockerfile.

FROM node:22-alpine AS deps
WORKDIR /workspace
RUN apk add --no-cache python3 make g++

COPY --from=ehr-bridge-sdk . ./ehr-bridge-sdk
RUN cd ehr-bridge-sdk && yarn install --frozen-lockfile && yarn build

COPY --from=ehr-bridge . ./ehr-bridge
RUN cd ehr-bridge && yarn install --frozen-lockfile && yarn build

COPY --from=sentinel . ./sentinel
RUN cd sentinel && yarn install --frozen-lockfile && yarn build

COPY . ./sentinel-stack
RUN cd sentinel-stack && yarn install --frozen-lockfile

FROM node:22-alpine AS build
WORKDIR /workspace
COPY --from=deps /workspace ./
RUN cd sentinel-stack && yarn build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Full sibling packages (source + node_modules + dist), so each one's own
# `yarn db:push` works unmodified inside this image — see
# docker-entrypoint.sh.
COPY --from=build /workspace/ehr-bridge ./ehr-bridge
COPY --from=build /workspace/sentinel ./sentinel
COPY --from=build /workspace/sentinel-stack ./sentinel-stack

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

WORKDIR /app/sentinel-stack
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]

# The hub, serving the web app and handing out the runner. `docker build --target test .` runs the tests too.

FROM node:26-trixie-slim AS base
# Git for the notes repo and the working copies change sets merge in.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
COPY shared/package.json shared/package-lock.json shared/
COPY hub/package.json hub/package-lock.json hub/
COPY web/package.json web/package-lock.json web/
COPY runner/package.json runner/package-lock.json runner/
RUN npm ci --prefix shared && npm ci --prefix hub && npm ci --prefix web && npm ci --prefix runner
COPY . .
RUN npm run build --prefix web && npm run build --prefix runner

FROM build AS test
# Redis for the change log's own tests, and Python for the agents' terminals' (the runner's pseudo-terminal).
RUN apt-get update && apt-get install -y --no-install-recommends redis-server python3 && rm -rf /var/lib/apt/lists/*
RUN git config --global user.name Tests && git config --global user.email tests@binders.invalid && git config --global init.defaultBranch main
RUN npm test --prefix hub && npm test --prefix runner && npm test --prefix web && npm run budget --prefix web

FROM base AS hub
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4400 WEB_DIR=/app/web/dist
COPY shared/package.json shared/package-lock.json shared/
COPY hub/package.json hub/package-lock.json hub/
RUN npm ci --omit=dev --prefix shared && npm ci --omit=dev --prefix hub && npm cache clean --force
COPY shared shared
COPY hub/src hub/src
COPY --from=build /app/web/dist web/dist
COPY --from=build /app/runner/dist runner/dist
# The hub keeps its secret, notes and working copies in .data: a volume on a server.
RUN mkdir -p hub/.data && chown node:node hub/.data
# Last, so a new commit rebuilds only this.
ARG COMMIT=
ARG COMMIT_SUBJECT=
ARG REPO_URL=
ENV BINDERS_COMMIT=$COMMIT BINDERS_COMMIT_SUBJECT=$COMMIT_SUBJECT BINDERS_REPO_URL=$REPO_URL
USER node
WORKDIR /app/hub
EXPOSE 4400
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s CMD ["node", "-e", "fetch('http://127.0.0.1:4400/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "src/main.ts"]

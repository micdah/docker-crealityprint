# Test-runner image: Playwright (browsers included) plus the Docker CLI.
# Why: specs start and inspect app containers themselves (via the host's Docker socket), and
# the same image runs locally and in CI, so both see the same browser and tooling.

FROM docker:27.5.1-cli@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c AS docker-cli

FROM mcr.microsoft.com/playwright:v1.49.0-noble@sha256:0fc07c73230cb7c376a528d7ffc83c4bdcdcd3fc7efbe54a2eed72b1ec118377

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker

WORKDIR /e2e
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

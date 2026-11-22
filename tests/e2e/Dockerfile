# Test-runner image: Playwright (browsers included) plus the Docker CLI.
# Why: specs start and inspect app containers themselves (via the host's Docker socket), and
# the same image runs locally and in CI, so both see the same browser and tooling.

FROM docker:29.10.0-cli@sha256:34507eb5069d8be82c95dd3b6987d4250fd5fee49b82e2509b7d7a7030740d6d AS docker-cli

FROM mcr.microsoft.com/playwright:v1.65.1-noble@sha256:1507cbfc550a63a6b7396791ca4f00df17beb56342d2447b3f106c306f525579

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker

WORKDIR /e2e
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

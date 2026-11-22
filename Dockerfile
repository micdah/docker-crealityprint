# syntax=docker/dockerfile:1

# Creality Print in the browser, on linuxserver's Selkies base image.
# Research behind every choice here: docs/research/ (start with README.md and 10-implementation-brief.md).

# Pinned by digest so a base change only arrives through a reviewed Renovate PR (see docs/research/09, R7).
ARG BASE_IMAGE=ghcr.io/linuxserver/baseimage-selkies:debiantrixie@sha256:793fc3628ad6e089aecfd9f862de3ad5d9df05f1db783363c812f77d6541ccc3

# hadolint ignore=DL3006
FROM ${BASE_IMAGE}

# renovate: datasource=github-releases depName=CrealityOfficial/CrealityPrint
ARG CREALITYPRINT_VERSION=v7.3.2
ARG BUILD_DATE
ARG VERSION

LABEL org.opencontainers.image.title="Creality Print" \
      org.opencontainers.image.description="Creality Print slicer in the browser via Selkies" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      crealityprint.version="${CREALITYPRINT_VERSION}" \
      crealityprint.upstream="https://github.com/CrealityOfficial/CrealityPrint/releases/tag/${CREALITYPRINT_VERSION}"

# SELKIES_AUDIO_ENABLED=false: the slicer makes no sound worth streaming, and audio capture costs
# about 3 % of a core (pulseaudio + pcmflux) while a browser is connected (docs/research/13 §8).
# Override with -e SELKIES_AUDIO_ENABLED=true.
ENV TITLE="Creality Print" \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    PIXELFLUX_WAYLAND=true \
    SELKIES_AUDIO_ENABLED=false

# Runtime deps. ldd on the AppImage only misses webkit2gtk-4.1 (+ its jsc/soup deps).
# inotify-tools + jq: upload watcher and first-run seeding. mesa-utils: glxinfo for GPU diagnostics.
# Deliberately NOT installed: the optional gstreamer set (camera works without it), vainfo (black
# stream on Intel Gen9), firefox and variable UI fonts (crash the app). See docs/research/09.
# vainfo is also purged, in case a base update ships it (the Rust Selkies base does): with it,
# the base's init-video picks the i965 driver on Intel Gen9 and the stream goes black
# (docs/research/04). A no-op while it isn't installed.
# Package versions aren't pinned: they come from the digest-pinned base's Debian release.
# hadolint ignore=DL3008
RUN \
  echo "**** install runtime packages ****" && \
  apt-get update && \
  DEBIAN_FRONTEND=noninteractive \
  apt-get install --no-install-recommends -y \
    inotify-tools \
    jq \
    libwebkit2gtk-4.1-0 \
    mesa-utils && \
  apt-get purge -y vainfo && \
  echo "**** cleanup ****" && \
  apt-get autoclean && \
  rm -rf \
    /var/lib/apt/lists/* \
    /var/tmp/* \
    /tmp/*

# Download, verify and extract the AppImage in its own layer so the apt layer stays cached.
COPY build/fetch-crealityprint.sh /tmp/fetch-crealityprint.sh
RUN --mount=type=secret,id=github_token,required=false \
  bash /tmp/fetch-crealityprint.sh "${CREALITYPRINT_VERSION}" && \
  rm -rf /tmp/*

# Patch the base image's Selkies so it doesn't poll its key loops while nobody types
# (docs/research/14). Fails the build when a base update changes the patched code.
COPY build/patch-selkies.sh build/patches/ /tmp/patch-selkies/
RUN \
  bash /tmp/patch-selkies/patch-selkies.sh /tmp/patch-selkies/selkies-*.patch && \
  rm -rf /tmp/*

COPY /root /

EXPOSE 3001
VOLUME /config

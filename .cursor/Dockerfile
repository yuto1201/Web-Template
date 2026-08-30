FROM node:24.13.0-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      docker.io \
      git \
      ripgrep \
    && npm install --global npm@11.6.2 \
    && rm -rf /var/lib/apt/lists/*

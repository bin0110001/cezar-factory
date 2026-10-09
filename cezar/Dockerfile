# cezar container image (Podman / Docker).
#
# Build:  podman build -t localhost/cezar:local .
# Run:    see compose.yaml
#
# Stage 1 builds the workspaces from source; stage 2 installs the packed CLI so the image
# runs exactly what `npm publish` would ship (dist + web/dist), not the dev tree.

ARG UV_VERSION=0.12.15
FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv

FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/contract/package.json packages/contract/
COPY packages/api-client/package.json packages/api-client/
COPY packages/cezar/package.json packages/cezar/
COPY packages/web/package.json packages/web/
RUN npm ci
COPY . .
RUN npm run build:server && npm run build:web \
 && mkdir -p /out && cd packages/cezar && npm pack --pack-destination /out

FROM node:22-bookworm-slim
# git: every task runs in a worktree. gh: draft PRs. openssh-client: git remotes over ssh.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl openssh-client gh \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code @openai/codex opencode-ai

# uv-managed Python: Factory scripts use Python helpers in the Cezar runtime.
# Keep the uv binary and Python version pinned in the image so the unprivileged
# runtime does not depend on packages installed on the host.
ARG PYTHON_VERSION=3.13
COPY --from=uv /uv /uvx /usr/local/bin/
ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    UV_PYTHON_BIN_DIR=/usr/local/bin
RUN mkdir -p "$UV_PYTHON_INSTALL_DIR" \
 && uv python install "$PYTHON_VERSION" --default \
 && python3 --version \
 && uv --version

# PowerShell: the cezar-factory workflows run their validation/routing steps as `pwsh` scripts.
ARG PWSH_VERSION=7.6.6
RUN apt-get update \
 && apt-get install -y --no-install-recommends libicu72 libssl3 zlib1g libstdc++6 \
 && rm -rf /var/lib/apt/lists/* \
 && arch="$(uname -m)" && case "$arch" in x86_64) pa=x64 ;; aarch64) pa=arm64 ;; *) echo "unsupported arch $arch" >&2; exit 1 ;; esac \
 && mkdir -p /opt/microsoft/powershell/7 \
 && curl -fsSL "https://github.com/PowerShell/PowerShell/releases/download/v${PWSH_VERSION}/powershell-${PWSH_VERSION}-linux-${pa}.tar.gz" \
    | tar -xz -C /opt/microsoft/powershell/7 \
 && chmod +x /opt/microsoft/powershell/7/pwsh \
 && ln -s /opt/microsoft/powershell/7/pwsh /usr/local/bin/pwsh

# Godot: headless imports/tests/exports for Godot projects. To upgrade, change only
# GODOT_VERSION (and GODOT_CHANNEL for e.g. "rc1"/"beta2") here or override with
# `--build-arg GODOT_VERSION=4.8`; the download is verified against the SHA512-SUMS.txt
# published with that release. GODOT_BIN points at the binary; `godot` is also on PATH.
ARG GODOT_VERSION=4.7
ARG GODOT_CHANNEL=stable
RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip libfontconfig1 libx11-6 libxcursor1 \
      libxext6 libxi6 libxinerama1 libxrandr2 libxrender1 libgl1 libudev1 \
 && rm -rf /var/lib/apt/lists/* \
 && arch="$(uname -m)" && case "$arch" in x86_64) ga=x86_64 ;; aarch64) ga=arm64 ;; *) echo "unsupported arch $arch" >&2; exit 1 ;; esac \
 && tag="${GODOT_VERSION}-${GODOT_CHANNEL}" \
 && zip="Godot_v${tag}_linux.${ga}.zip" \
 && base="https://github.com/godotengine/godot/releases/download/${tag}" \
 && mkdir -p /opt/godot /tmp/godot && cd /tmp/godot \
 && curl -fsSLO "${base}/${zip}" && curl -fsSLO "${base}/SHA512-SUMS.txt" \
 && grep " ${zip}\$" SHA512-SUMS.txt | sha512sum -c - \
 && unzip -q "${zip}" -d /opt/godot \
 && mv "/opt/godot/Godot_v${tag}_linux.${ga}" /opt/godot/godot \
 && chmod +x /opt/godot/godot \
 && ln -s /opt/godot/godot /usr/local/bin/godot \
 && cd / && rm -rf /tmp/godot \
 && ! ldd /opt/godot/godot | grep "not found" \
 && /opt/godot/godot --version
ENV GODOT_BIN=/opt/godot/godot

COPY --from=build /out/*.tgz /tmp/cezar.tgz
RUN npm install -g /tmp/cezar.tgz && rm /tmp/cezar.tgz

# Run unprivileged: agents execute arbitrary shell, so keep them off root.
RUN useradd --create-home --uid 1001 cezar \
 && mkdir -p /workspace /home/cezar/.cezar /home/cezar/.claude /home/cezar/.codex \
      /home/cezar/.config/gh /home/cezar/.config/opencode \
      /home/cezar/.local/share/opencode /home/cezar/.local/state \
 && chown -R cezar:cezar /workspace /home/cezar
USER cezar
ENV HOME=/home/cezar \
    CEZ_HOME=/home/cezar/.cezar \
    CEZ_NO_BANNER=1
WORKDIR /workspace
# Trust bind-mounted repos whose owner differs from the container uid.
RUN git config --global --add safe.directory '*'

EXPOSE 4321
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD curl -fsS http://127.0.0.1:4321/api/v1/health || exit 1

# --bind-host 0.0.0.0 is required for the published port to reach the server; the HOST side
# stays loopback-only (see compose.yaml), because cezar has no auth of its own.
ENTRYPOINT ["cezar", "serve", "--no-open", "--port", "4321", "--bind-host", "0.0.0.0"]

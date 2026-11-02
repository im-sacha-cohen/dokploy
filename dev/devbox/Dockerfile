# Isolated Linux dev environment for Dokploy on macOS: runs its own Docker
# daemon (Docker-in-Docker) so Swarm, overlay networks and Traefik never touch
# the host's Docker Desktop daemon.
FROM node:24.22.1-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
		ca-certificates curl git git-lfs iptables iproute2 procps tini jq \
		python3 make g++ pkg-config libsecret-1-dev \
		rsync unzip zip apache2-utils \
	&& git lfs install --system \
	&& rm -rf /var/lib/apt/lists/*

# Same tool versions as the production image (root Dockerfile).
ARG DOCKER_VERSION=28.5.2
RUN curl -fsSL https://get.docker.com -o /tmp/get-docker.sh \
	&& sh /tmp/get-docker.sh --version ${DOCKER_VERSION} \
	&& rm /tmp/get-docker.sh

ARG NIXPACKS_VERSION=1.41.0
RUN curl -sSL https://nixpacks.com/install.sh -o /tmp/nixpacks.sh \
	&& bash /tmp/nixpacks.sh -y \
	&& rm /tmp/nixpacks.sh

ARG RAILPACK_VERSION=0.15.4
RUN curl -sSL https://railpack.com/install.sh | bash

COPY --from=buildpacksio/pack:0.39.1 /usr/local/bin/pack /usr/local/bin/pack

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.22.0 --activate \
	&& pnpm config set store-dir /pnpm/store --global

# The workspace is bind-mounted from macOS with a different owner.
RUN git config --system --add safe.directory '*'

WORKDIR /workspace
EXPOSE 3000 80 443

# Read from the bind-mounted workspace so edits apply on restart without a rebuild.
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/workspace/dev/devbox/entrypoint.sh"]

FROM debian:trixie AS base-builder
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV MISE_INSTALL_PATH="/usr/local/bin/mise" \
    PATH="/root/.local/share/mise/shims:$PATH"
RUN curl https://mise.run | sh && mise install
WORKDIR /app
COPY mise.toml ./
RUN curl https://mise.run | sh && mise install

FROM base-builder AS frontend
COPY . ./
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src.js public ./ 
RUN mise build-client

FROM base-builder AS backend
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
		mise build-backend

FROM debian:trixie-slim AS runner
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client && rm -rf /var/lib/apt/lists/*
COPY --from=backend /app/program .
COPY --from=frontend /app/public ./public
CMD ["./program"]


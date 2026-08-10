FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN test "$(dpkg --print-architecture)" = amd64 \
    && apt-get update \
    && mkdir -p /tmp/libssl3/root /tmp/libssl3/control \
    && chown _apt:root /tmp/libssl3 \
    && cd /tmp/libssl3 \
    && apt-get download libssl3:amd64=3.0.20-1~deb12u2 \
    && package="$(printf '%s\n' libssl3_*_amd64.deb)" \
    && test -f "$package" \
    && test "$(dpkg-deb --field "$package" Package)" = libssl3 \
    && test "$(dpkg-deb --field "$package" Version)" = 3.0.20-1~deb12u2 \
    && test "$(dpkg-deb --field "$package" Architecture)" = amd64 \
    && dpkg-deb --extract "$package" root \
    && dpkg-deb --control "$package" control \
    && cp control/control status \
    && test -s control/md5sums \
    && rm "$package" \
    && rm -rf /var/lib/apt/lists/*
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DIST_DIR=/app/dist
COPY --from=build /tmp/libssl3/root/ /
COPY --from=build /tmp/libssl3/status /var/lib/dpkg/status.d/libssl3
COPY --from=build /tmp/libssl3/control/md5sums /var/lib/dpkg/status.d/libssl3.md5sums
COPY --from=build --chown=65532:65532 /app/dist ./dist
COPY --from=build --chown=65532:65532 /app/server.mjs ./server.mjs
EXPOSE 3000
CMD ["server.mjs"]

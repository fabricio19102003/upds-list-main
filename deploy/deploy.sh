#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ ${RELEASE_TAG-} =~ ^[0-9a-f]{40}$ ]] || { printf 'RELEASE_TAG must be a certified full Git SHA (40 lowercase hexadecimal characters).\n' >&2; exit 1; }
export RELEASE_TAG
readonly APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly COMPOSE="$APP_DIR/docker-compose.production.yml"
[[ "$APP_DIR" == /srv/apps/aulas-upds ]] || { printf 'Run from /srv/apps/aulas-upds.\n' >&2; exit 1; }
for command in docker curl flock; do command -v "$command" >/dev/null || { printf 'Missing %s.\n' "$command" >&2; exit 1; }; done
docker compose version >/dev/null
exec 9>"$APP_DIR/.deploy.lock"
flock -n 9 || { printf 'Another deployment is running.\n' >&2; exit 1; }
shopt -s nullglob
data_files=("$APP_DIR"/data/*.txt)
(( ${#data_files[@]} > 0 )) || { printf 'No runtime data files found.\n' >&2; exit 1; }
for file in "${data_files[@]}"; do [[ -f "$file" && ! -L "$file" ]] || { printf 'Invalid runtime data file.\n' >&2; exit 1; }; done
compose=(docker compose -f "$COMPOSE")
old_container="$("${compose[@]}" ps -q app)"
old_image=""
[[ -z "$old_container" ]] || old_image="$(docker inspect --format '{{.Image}}' "$old_container")"
rolled_out=0
rollback() {
  status=$?; trap - ERR INT TERM
  if (( rolled_out )); then
    if [[ -n "$old_image" ]]; then docker image tag "$old_image" "aulas-upds:$RELEASE_TAG" && "${compose[@]}" up -d --no-build app || true
    else "${compose[@]}" rm -s -f app || true; fi
  fi
  exit "$status"
}
trap rollback ERR INT TERM
"${compose[@]}" config -q
"${compose[@]}" build --pull app
rolled_out=1
"${compose[@]}" up -d --no-build app
for _ in {1..30}; do curl --fail --silent --max-time 2 http://127.0.0.1:3020/health >/dev/null && { trap - ERR INT TERM; printf 'Release %s is healthy.\n' "$RELEASE_TAG"; exit; }; sleep 2; done
printf 'Health deadline exceeded.\n' >&2
false

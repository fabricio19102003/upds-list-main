#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ ${RELEASE_TAG-} =~ ^[0-9a-f]{40}$ ]] || { printf 'RELEASE_TAG must be a certified full Git SHA (40 lowercase hexadecimal characters).\n' >&2; exit 1; }
export RELEASE_TAG
command -v id >/dev/null || { printf 'Missing id.\n' >&2; exit 1; }
RUNTIME_UID="$(id -u)"
RUNTIME_GID="$(id -g)"
[[ "$RUNTIME_UID" =~ ^[1-9][0-9]*$ ]] || { printf 'Deployment operator UID must be a nonzero number.\n' >&2; exit 1; }
[[ "$RUNTIME_GID" =~ ^[1-9][0-9]*$ ]] || { printf 'Deployment operator GID must be a nonzero number.\n' >&2; exit 1; }
readonly RUNTIME_UID RUNTIME_GID
export RUNTIME_UID RUNTIME_GID
readonly APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly COMPOSE="$APP_DIR/docker-compose.production.yml"
readonly SECRET_FILE=/srv/secrets/portal/cupos-student-lookup-token
readonly PRIVATE_NETWORK=cupos-turmas_backend
[[ "$APP_DIR" == /srv/apps/aulas-upds ]] || { printf 'Run from /srv/apps/aulas-upds.\n' >&2; exit 1; }
for command in docker curl flock python3 stat; do command -v "$command" >/dev/null || { printf 'Missing %s.\n' "$command" >&2; exit 1; }; done
docker compose version >/dev/null
exec 9>"$APP_DIR/.deploy.lock"
flock -n 9 || { printf 'Another deployment is running.\n' >&2; exit 1; }
docker network inspect "$PRIVATE_NETWORK" >/dev/null 2>&1 || { printf 'Required private network is unavailable.\n' >&2; exit 1; }
[[ -f "$SECRET_FILE" && ! -L "$SECRET_FILE" ]] || { printf 'Student lookup secret is unavailable.\n' >&2; exit 1; }
secret_uid="$(stat -c '%u' -- "$SECRET_FILE")"
secret_mode="$(stat -c '%a' -- "$SECRET_FILE")"
[[ "$secret_uid" == "$RUNTIME_UID" && "$secret_mode" =~ ^[0-7]{3}$ ]] || { printf 'Student lookup secret permissions are invalid.\n' >&2; exit 1; }
(( (8#$secret_mode & 0077) == 0 && (8#$secret_mode & 0400) != 0 )) || { printf 'Student lookup secret permissions are invalid.\n' >&2; exit 1; }
secret_contents="$(<"$SECRET_FILE")"
[[ "$secret_contents" =~ ^[[:space:]]*[0-9a-fA-F]{64}[[:space:]]*$ ]] || { unset secret_contents; printf 'Student lookup secret content is invalid.\n' >&2; exit 1; }
unset secret_contents; BASH_REMATCH=()
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
"${compose[@]}" up -d --no-build --force-recreate app
for _ in {1..30}; do
  if curl --fail --silent --max-time 2 http://127.0.0.1:3020/health >/dev/null \
    && curl --silent --max-time 7 --write-out '\n%{http_code}' http://127.0.0.1:3020/api/student-search/metadata \
      | python3 -c 'import json,re,sys; body,status=sys.stdin.read().rsplit("\n",1); v=json.loads(body); p=v.get("activePeriod",{}) if isinstance(v,dict) else {}; ok=status=="200" and isinstance(v,dict) and set(v)=={"apiVersion","activePeriod","dataVersion","scheduleAvailable"} and isinstance(p,dict) and set(p)=={"code","displayName"} and v["apiVersion"]=="v1" and p["code"]=="2026-2" and p["displayName"]=="2/2026" and isinstance(v["dataVersion"],str) and re.fullmatch(r"[0-9a-fA-F]{64}",v["dataVersion"]) and v["scheduleAvailable"] is False; sys.exit(0 if ok else 1)' >/dev/null 2>&1; then
    trap - ERR INT TERM; printf 'Release %s is healthy and ready.\n' "$RELEASE_TAG"; exit
  fi
  sleep 2
done
printf 'Readiness deadline exceeded.\n' >&2
false

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
last_category=health-transport
attempts=0
candidate_container=""; candidate_image=""; candidate_discovered=0
if candidate_output="$("${compose[@]}" ps -q app 2>/dev/null)"; then candidate_ps_status=0; else candidate_ps_status=$?; fi
if (( candidate_ps_status != 0 )); then
  last_category=candidate-ps
elif [[ ! "$candidate_output" =~ ^[0-9a-f]{12,64}$ ]]; then
  last_category=candidate-container
else
  candidate_container="$candidate_output"
  if candidate_image_output="$(docker inspect --format '{{.Image}}' "$candidate_container" 2>/dev/null)"; then candidate_image_status=0; else candidate_image_status=$?; fi
  if (( candidate_image_status != 0 )); then
    last_category=candidate-image-inspect
  elif [[ ! "$candidate_image_output" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    last_category=candidate-image
  else
    candidate_image="$candidate_image_output"; candidate_discovered=1
  fi
  unset candidate_image_output
fi
unset candidate_output
for _ in {1..30}; do
  (( candidate_discovered )) || break
  ((attempts+=1))
  if ! health_http="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 2 http://127.0.0.1:3020/health)"; then
    last_category=health-transport
  elif [[ "$health_http" != 200 ]]; then
    last_category=health-http
  elif ! metadata_response="$(curl --silent --max-time 7 --max-filesize 65536 --write-out $'\n%{http_code}' http://127.0.0.1:3020/api/student-search/metadata)"; then
    last_category=metadata-transport
    unset metadata_response
  else
    metadata_http="${metadata_response##*$'\n'}"
    metadata_body="${metadata_response%$'\n'*}"
    unset metadata_response
    if [[ "$metadata_http" != 200 ]]; then
      last_category=metadata-http
    elif printf '%s' "$metadata_body" | python3 -c 'import json,re,sys
try: v=json.load(sys.stdin)
except (json.JSONDecodeError,UnicodeDecodeError): sys.exit(20)
p=v.get("activePeriod") if isinstance(v,dict) else None
schema=isinstance(v,dict) and set(v)=={"apiVersion","activePeriod","dataVersion","scheduleAvailable"} and isinstance(p,dict) and set(p)=={"code","displayName"} and v["apiVersion"]=="v1" and isinstance(p["code"],str) and isinstance(p["displayName"],str) and isinstance(v["dataVersion"],str) and re.fullmatch(r"[0-9a-fA-F]{64}",v["dataVersion"]) and v["scheduleAvailable"] is False
if not schema: sys.exit(21)
if p["code"]!="2026-2" or p["displayName"]!="2/2026": sys.exit(22)' >/dev/null 2>&1; then
      unset metadata_body metadata_http health_http
      trap - ERR INT TERM; printf 'Release %s is healthy and ready.\n' "$RELEASE_TAG"; exit
    else
      parser_status=$?
      case "$parser_status" in 20) last_category=metadata-invalid-json;; 21) last_category=metadata-schema;; 22) last_category=metadata-period;; *) last_category=metadata-parser;; esac
    fi
    unset metadata_body metadata_http
  fi
  unset health_http
  sleep 2
done
container_prefix=unavailable; health_status=unavailable; restart_count=unavailable; health_exit_codes=unavailable
logs_status=unavailable; startup_lines=unavailable; startup_classes=unavailable
if [[ -n "$candidate_container" ]]; then
  container_prefix="${candidate_container:0:12}"
  health_status="$(docker inspect --format '{{.State.Health.Status}}' "$candidate_container" 2>/dev/null || true)"
  [[ "$health_status" =~ ^(starting|healthy|unhealthy)$ ]] || health_status=unavailable
  if restart_output="$(docker inspect --format '{{.RestartCount}}' "$candidate_container" 2>/dev/null)"; then restart_status=0; else restart_status=$?; fi
  if (( restart_status != 0 )); then restart_count=unavailable
  elif [[ ! "$restart_output" =~ ^[0-9]+$ ]]; then restart_count=invalid
  elif (( ${#restart_output} > 6 )); then restart_count=capped
  else restart_count="$((10#$restart_output))"
  fi
  unset restart_output
  health_exit_codes="$(docker inspect --format '{{range .State.Health.Log}}{{printf "%d," .ExitCode}}{{end}}' "$candidate_container" 2>/dev/null || true)"
  health_exit_codes="${health_exit_codes%,}"; health_exit_codes="${health_exit_codes:0:32}"
  [[ "$health_exit_codes" =~ ^[0-9]+(,[0-9]+)*$ ]] || health_exit_codes=unavailable
  if startup_logs="$(docker logs --tail 200 "$candidate_container" 2>/dev/null)"; then
    logs_status=available; startup_logs="${startup_logs:0:32768}"
    startup_lines=0; permission_denied=0; missing_file=0; module_startup=0; port_binding=0; unclassified=0
    while IFS= read -r line; do
      [[ -n "$line" ]] || continue
      ((startup_lines+=1)); normalized="${line,,}"
      case "$normalized" in
        *"permission denied"*|*eacces*) ((permission_denied+=1));;
        *"no such file"*|*enoent*) ((missing_file+=1));;
        *"cannot find module"*|*module_not_found*|*"startup failed"*) ((module_startup+=1));;
        *"address already in use"*|*eaddrinuse*|*"bind failed"*) ((port_binding+=1));;
        *) ((unclassified+=1));;
      esac
    done <<< "$startup_logs"
    startup_classes="permission-denied:$permission_denied,missing-file:$missing_file,module-startup:$module_startup,port-binding:$port_binding,unclassified:$unclassified"
  fi
  unset startup_logs line normalized
fi
[[ -n "$candidate_image" ]] || candidate_image=unavailable
printf 'Readiness deadline exceeded: attempts=%d last=%s candidate=%s image=%s health=%s restarts=%s health_exit_codes=%s logs=%s startup_lines=%s startup_classes=%s\n' \
  "$attempts" "$last_category" "$container_prefix" "$candidate_image" "$health_status" "$restart_count" "$health_exit_codes" "$logs_status" "$startup_lines" "$startup_classes" >&2
false

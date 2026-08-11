#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

die() { printf 'Release stopped: %s\n' "$1" >&2; exit 1; }
say() { printf '%s\n' "$1"; }
validate_tracked_modes() {
  local modes="$container/tracked-modes" container_real worktree_real entry metadata mode path expected actual relative current
  [[ ! -L $container && -d $container ]] || die 'owned release container is not a real directory'
  container_real=$(cd -- "$container" && pwd -P) || die 'cannot resolve owned release container'
  [[ ! -L $worktree && -d $worktree ]] || die 'temporary worktree is not a real directory'
  worktree_real=$(cd -- "$worktree" && pwd -P) || die 'cannot resolve temporary worktree'
  [[ $worktree_real == "$container_real/worktree" ]] || die 'temporary worktree escaped its owned container'
  actual=$(stat -c %a -- "$worktree") || die 'cannot inspect temporary worktree mode'
  [[ $actual == 755 ]] || die 'temporary worktree mode is not canonical 0755'
  git -C "$worktree" ls-files --stage -z >"$modes" || die 'cannot read tracked file modes'
  while IFS= read -r -d '' entry; do
    [[ $entry == *$'\t'* ]] || die 'malformed tracked file record'
    metadata=${entry%%$'\t'*}
    path=${entry#*$'\t'}
    mode=${metadata%% *}
    case $mode in 100644) expected=644;; 100755) expected=755;; *) die 'non-canonical tracked file mode';; esac
    [[ -n $path && $path != /* && $path != . && $path != .. && $path != ../* && $path != */../* && $path != */.. && $path != ./* && $path != */./* && $path != */. ]] || die 'tracked path escaped temporary worktree'
    relative=${path%/*}
    if [[ $relative != "$path" ]]; then
      current=''
      while [[ -n $relative ]]; do
        current=${current:+$current/}${relative%%/*}
        [[ ! -L $worktree/$current && -d $worktree/$current ]] || die 'tracked parent is not a real directory'
        actual=$(stat -c %a -- "$worktree/$current") || die 'cannot inspect tracked parent directory mode'
        [[ $actual == 755 ]] || die 'tracked parent directory mode is not canonical 0755'
        [[ $relative == */* ]] || break
        relative=${relative#*/}
      done
    fi
    [[ ! -L $worktree/$path && -f $worktree/$path ]] || die 'tracked path is not a regular file'
    actual=$(stat -c %a -- "$worktree/$path") || die 'cannot inspect tracked file mode'
    [[ $actual == "$expected" ]] || die "tracked file mode is not canonical 0$expected"
  done <"$modes"
}
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

dry_run=0
case ${1-} in --dry-run) dry_run=1;; '') :;; *) die 'usage: deploy/release-production.sh [--dry-run]';; esac

host=${RELEASE_HOST:-31.97.129.151}
user=${RELEASE_USER:-pedro}
identity=${RELEASE_IDENTITY:-"${HOME:?}/.ssh/upds_vps_20260810"}
remote=${RELEASE_REMOTE_DIR:-/srv/apps/aulas-upds}
branch=${RELEASE_BRANCH:-main}
domain=${RELEASE_DOMAIN:-aulas.upds-cobija.cloud}
[[ $host =~ ^[A-Za-z0-9.-]+$ && $user =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] || die 'invalid SSH destination'
[[ $identity =~ ^/[A-Za-z0-9._/-]+$ && $remote =~ ^/[A-Za-z0-9._/-]+$ ]] || die 'invalid release path'
[[ $branch =~ ^[A-Za-z0-9._/-]+$ && $domain =~ ^[A-Za-z0-9.-]+$ ]] || die 'invalid branch or domain'
[[ -f $identity && ! -L $identity && -r $identity ]] || die 'SSH identity is not a readable regular file'

for tool in git npm node docker trivy rsync ssh curl sha256sum grep mktemp stat; do
  command -v "$tool" >/dev/null || die "missing prerequisite: $tool"
done
docker compose version >/dev/null 2>&1 || die 'Docker Compose is unavailable'

root=$(git -C "$(dirname -- "${BASH_SOURCE[0]}")/.." rev-parse --show-toplevel) || die 'not in a Git repository'
[[ $root == "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)" ]] || die 'wrapper must run from its repository'
main_status=$(git -C "$root" status --porcelain=v1 --untracked-files=all) || die 'cannot inspect current worktree or index'
[[ -z $main_status ]] || die 'current worktree or index is dirty'
git -C "$root" fetch --quiet origin "$branch" || die 'origin fetch failed'
sha=$(git -C "$root" rev-parse --verify HEAD) || die 'cannot resolve HEAD'
remote_ref=$(git -C "$root" rev-parse --verify "refs/remotes/origin/$branch") || die 'cannot resolve local origin branch'
live=$(git -C "$root" ls-remote origin "refs/heads/$branch") || die 'live origin query failed'
[[ $sha =~ ^[0-9a-f]{40}$ && $remote_ref == "$sha" && $live == "$sha"$'\t'"refs/heads/$branch" ]] || die 'HEAD, local origin, and live origin are not the same full SHA'

printf 'Type the full release SHA %s to continue: ' "$sha" >&2
IFS= read -r confirmation || die 'confirmation was not received'
[[ $confirmation == "$sha" ]] || die 'confirmation did not match the full SHA'

parent=$(cd -- "$(dirname -- "$root")" && pwd -P)
[[ $root == "$parent"/* && ${root#"$parent"/} != */* ]] || die 'repository parent validation failed'
release_root="$parent/.aulas-upds-releases"
[[ -e $release_root ]] || mkdir -m 700 -- "$release_root" || die 'cannot create release root'
[[ -d $release_root && ! -L $release_root && -O $release_root && $(stat -c %a -- "$release_root") == 700 ]] || die 'release root must be an owner-only directory'
image="aulas-upds:$sha"
container=''; worktree=''; container_owned=0; worktree_registered=0; image_created=0
cleanup() {
  status=$?
  trap - EXIT
  trap '' HUP INT TERM
  (( image_created == 0 )) || docker image rm "$image" >/dev/null 2>&1 || true
  (( worktree_registered == 0 )) || git -C "$root" worktree remove --force "$worktree" >/dev/null 2>&1 || true
  if (( container_owned )) && [[ $container == "$release_root"/release.* ]]; then rm -rf -- "$container"; fi
  exit "$status"
}
trap cleanup EXIT
container=$(mktemp -d "$release_root/release.XXXXXX") || die 'cannot create owned release container'
container_owned=1
worktree="$container/worktree"
(umask 022; git -C "$root" worktree add --quiet --detach "$worktree" "$sha") || die 'cannot create detached release worktree'
worktree_registered=1
[[ $worktree == "$container/worktree" && $(git -C "$worktree" rev-parse --is-inside-work-tree) == true ]] || die 'temporary worktree containment failed'
[[ $(git -C "$worktree" symbolic-ref -q HEAD || true) == '' && $(git -C "$worktree" rev-parse HEAD) == "$sha" ]] || die 'temporary worktree is not detached at the release SHA'
release_status=$(git -C "$worktree" status --porcelain=v1 --untracked-files=all) || die 'cannot inspect temporary worktree'
[[ -z $release_status ]] || die 'temporary worktree is not clean'
validate_tracked_modes

(cd -- "$worktree" && npm ci && npm test && npm run lint && npm run build && npm audit --audit-level=low)
git -C "$worktree" diff --quiet && git -C "$worktree" diff --cached --quiet || die 'verification gates changed tracked files'
export RELEASE_TAG=$sha RUNTIME_UID=65532 RUNTIME_GID=65532
existing_image=$(docker image ls --quiet --no-trunc --filter "reference=$image") || die 'cannot determine whether the exact local release image tag exists'
[[ -z $existing_image ]] || die 'exact local release image tag already exists'
docker compose -f "$worktree/docker-compose.production.yml" build app
docker image inspect "$image" >/dev/null 2>&1 || die 'exact release image was not built'
image_created=1
trivy image --quiet --exit-code 1 --scanners vuln --severity HIGH,CRITICAL "$image" >/dev/null 2>&1 || die 'image has HIGH or CRITICAL vulnerabilities'
trivy image --quiet --exit-code 1 --scanners secret "$image" >/dev/null 2>&1 || die 'image has detected secrets'

ssh_opts=(-i "$identity" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 -o ConnectionAttempts=1 -o ServerAliveInterval=5 -o ServerAliveCountMax=1)
rsync_ssh="ssh -i $identity -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 -o ConnectionAttempts=1 -o ServerAliveInterval=5 -o ServerAliveCountMax=1"
excludes=(.git/ .codegraph/ '.env*' node_modules/ dist/ src/data/ data/ test-results/ playwright-report/ '*[Ss]ecret*' '*[Tt]oken*' '*[Cc]redential*' '*.key' '*.pem' '*.db' '*.db-*' '*.sqlite*' '*.sql' '*.dump' '*.xls*' '*.ods' '*[Ww]orkbook*' '*.log' coverage/ tmp/ temp/ '*.tmp' .cache/ .npm/ .vite/ '__pycache__/' '*.py[co]')
rsync_args=(-az --safe-links -e "$rsync_ssh")
for pattern in "${excludes[@]}"; do rsync_args+=(--exclude "$pattern"); done
(( dry_run == 0 )) || rsync_args+=(--dry-run)
validate_tracked_modes
rsync "${rsync_args[@]}" "$worktree/" "$user@$host:$remote/" >/dev/null || die 'rsync staging failed'
if (( dry_run )); then
  say "DRY RUN certified $sha; rsync opened SSH/remote rsync but made no file or deploy mutation."
  say 'Rollback: none required; no production state was changed.'
  exit 0
fi

staged_nginx="$remote/deploy/nginx/aulas-upds.conf"
active_nginx=/etc/nginx/sites-enabled/aulas-upds.conf
hashes=$(ssh "${ssh_opts[@]}" "$user@$host" "set -Eeuo pipefail; staged=\$(sha256sum -- '$staged_nginx'); active=\$(sha256sum -- '$active_nginx'); printf 'STAGED %s\\nACTIVE %s\\n' \"\$staged\" \"\$active\"") || die 'cannot compare Nginx configuration'
mapfile -t hash_lines <<<"$hashes"
[[ ${#hash_lines[@]} == 2 && ${hash_lines[0]} =~ ^STAGED\ ([0-9a-f]{64})\ \  ]] || die 'ambiguous staged Nginx hash output'
staged_hash=${BASH_REMATCH[1]}
[[ ${hash_lines[0]} == "STAGED $staged_hash  $staged_nginx" ]] || die 'wrong staged Nginx hash path'
[[ ${hash_lines[1]} =~ ^ACTIVE\ ([0-9a-f]{64})\ \  ]] || die 'ambiguous active Nginx hash output'
active_hash=${BASH_REMATCH[1]}
[[ ${hash_lines[1]} == "ACTIVE $active_hash  $active_nginx" ]] || die 'wrong active Nginx hash path'
if [[ $staged_hash != "$active_hash" ]]; then
  printf '%s\n' 'Nginx differs; deploy was NOT run. Review, then run exactly:'
  printf 'sudo install -m 0644 %q %q\n' "$remote/deploy/nginx/aulas-upds.conf" /etc/nginx/sites-available/aulas-upds.conf
  printf '%s\n' 'sudo nginx -t' 'sudo systemctl reload nginx' 'Then rerun deploy/release-production.sh.'
  die 'Nginx must be installed by a human first'
fi

ssh "${ssh_opts[@]}" "$user@$host" "RELEASE_TAG=$sha bash $remote/deploy/deploy.sh" || die 'remote deploy failed; it was not retried'
http=$(curl --silent --show-error --max-time 10 --output /dev/null --write-out '%{http_code} %{redirect_url}' "http://$domain/")
[[ $http == "301 https://$domain/" ]] || die 'public HTTP redirect verification failed'
headers="$worktree/.release-headers"
https=$(curl --silent --show-error --max-time 10 --output /dev/null --dump-header "$headers" --write-out '%{http_code}' "https://$domain/")
[[ $https == 200 ]] || die 'public HTTPS verification failed'
for header in content-security-policy permissions-policy referrer-policy strict-transport-security x-content-type-options x-frame-options; do
  grep -Eiq "^$header:[[:space:]]*[^[:space:]]" "$headers" || die "missing HTTPS security header: $header"
done
rm -f -- "$headers"
metadata_body="$worktree/.release-metadata"
metadata_status=$(curl --silent --show-error --max-time 15 --output "$metadata_body" --write-out '%{http_code}' "https://$domain/api/student-search/metadata")
[[ $metadata_status == 200 ]] && node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1]));const p=v?.activePeriod;const ok=v&&Object.keys(v).sort().join()==="activePeriod,apiVersion,dataVersion,scheduleAvailable"&&v.apiVersion==="v1"&&p&&Object.keys(p).sort().join()==="code,displayName"&&p.code==="2026-2"&&p.displayName==="2/2026"&&/^[0-9a-f]{64}$/i.test(v.dataVersion)&&v.scheduleAvailable===false;if(!ok)process.exit(1)' "$metadata_body" || die 'safe public metadata verification failed'
search_body="$worktree/.release-invalid-search"
search_status=$(curl --silent --show-error --max-time 15 --output "$search_body" --write-out '%{http_code}' -H 'Content-Type: application/json' --data '{"mode":"name","query":"x"}' "https://$domain/api/student-search")
[[ $search_status == 400 ]] && node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1]));if(JSON.stringify(v)!==JSON.stringify({error:{code:"invalid_request",message:"Invalid request."}}))process.exit(1)' "$search_body" || die 'sanitized invalid-search verification failed'
legacy=$(curl --silent --show-error --max-time 10 --output /dev/null --write-out '%{http_code}' "https://$domain/api/search")
[[ $legacy == 404 ]] || die 'legacy endpoint is not 404'
remote_health=$(ssh "${ssh_opts[@]}" "$user@$host" "bash -s -- '$sha'" <<'REMOTE'
set -Eeuo pipefail
sha=$1
app=$(docker ps -q --filter label=com.docker.compose.project=aulas-upds --filter label=com.docker.compose.service=app)
[[ -n $app && $(wc -w <<<"$app") == 1 ]]
[[ $(docker inspect -f '{{.Config.Image}} {{.State.Health.Status}} {{.RestartCount}}' "$app") == "aulas-upds:$sha healthy 0" ]]
mapfile -t cupos < <(docker ps -q --filter label=com.docker.compose.project=cupos-turmas)
[[ ${#cupos[@]} == 2 ]]
for container in "${cupos[@]}"; do [[ $(docker inspect -f '{{.State.Health.Status}} {{.RestartCount}}' "$container") == 'healthy 0' ]]; done
printf 'APP_EXACT=1 CUPOS_HEALTHY=2/2\n'
REMOTE
) || die 'remote image or health verification failed'
[[ $remote_health == 'APP_EXACT=1 CUPOS_HEALTHY=2/2' ]] || die 'ambiguous remote health output'
say "RELEASED $sha: redirect, HTTPS headers, safe metadata, sanitized invalid search, legacy 404, exact healthy image, and Cupos 2/2 passed."
say "Rollback: rerun remote deploy authority with the previously certified SHA/image; deploy.sh also restores the previous image on readiness failure."

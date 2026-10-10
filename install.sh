#!/usr/bin/env bash
# Builds and runs xspeckle-server on this machine with Docker Compose.
#
#   ./install.sh                 build the images, write .env if missing, start
#   ./install.sh start|stop      start or stop the services (data is kept)
#   ./install.sh status          show the services
#   ./install.sh logs [service]  follow the logs
#   ./install.sh help
#
# Options for the first run: --url URL  --port N  --yes (take the defaults, ask nothing)
set -euo pipefail
cd "$(dirname "$0")"

FILES=(-f docker-compose-deps.yml -f docker-compose-speckle.yml -f docker-compose.yml)
# Your own adjustments, if any; the file is ignored by git.
[ -f docker-compose.local.yml ] && FILES+=(-f docker-compose.local.yml)

# The deps file also defines development tools (keycloak, pgadmin, ...) that a
# server does not need, so the services are always named.
BUILT=(speckle-server speckle-frontend-2 speckle-ingress preview-service webhook-service fileimport-service)
SERVICES=(postgres redis minio "${BUILT[@]}")

MIN_COMPOSE="2.24.0" # first version with the !override and !reset tags docker-compose.yml uses

say() { printf '\n==> %s\n' "$*"; }
warn() { printf 'Warning: %s\n' "$*" >&2; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
compose() { docker compose "${FILES[@]}" "$@"; }

usage() { sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; }

version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]; }

check_docker() {
  command -v docker >/dev/null 2>&1 || die "Docker is not installed. See https://docs.docker.com/engine/install/"
  docker info >/dev/null 2>&1 || die "Docker is installed but not reachable. Is it running, and may this user use it?"
  local v
  v=$(docker compose version --short 2>/dev/null) || die "The Docker Compose plugin is missing. See https://docs.docker.com/compose/install/"
  v=${v#v}
  version_ge "$v" "$MIN_COMPOSE" || die "Docker Compose $v is too old; $MIN_COMPOSE or newer is needed."
}

check_resources() {
  local mem_kb free_kb
  if [ -r /proc/meminfo ]; then
    mem_kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
    [ "$mem_kb" -ge 7500000 ] || warn "this machine has $((mem_kb / 1024 / 1024)) GB of memory; building the frontend may fail with less than 8 GB."
  fi
  free_kb=$(df -Pk . | awk 'NR==2 {print $4}')
  [ "$free_kb" -ge 30000000 ] || warn "only $((free_kb / 1024 / 1024)) GB of disk are free here; the images and their build cache take about 30 GB."
}

port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

random_hex() { openssl rand -hex "$1" 2>/dev/null || head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

primary_ip() {
  local ip
  ip=$(hostname -I 2>/dev/null | awk '{print $1}') || true
  printf '%s' "${ip:-127.0.0.1}"
}

ask() { # ask <prompt> <default> -> answer on stdout
  local answer
  if [ "$ASSUME_YES" = 1 ] || [ ! -t 0 ]; then printf '%s' "$2"; return; fi
  read -r -p "$1 [$2]: " answer
  printf '%s' "${answer:-$2}"
}

write_env() {
  local url port default_port
  url=${OPT_URL:-$(ask "Address people will open in their browser" "http://$(primary_ip)")}
  url=${url%/}
  case $url in http://* | https://*) ;; *) die "The address must start with http:// or https://" ;; esac

  # http://host:8080 -> 8080; otherwise 80. An https address needs a reverse
  # proxy in front that handles TLS and forwards to this port.
  default_port=80
  if [[ $url =~ ^http://[^/:]+:([0-9]+)$ ]]; then default_port=${BASH_REMATCH[1]}; fi
  port=${OPT_PORT:-$(ask "Port on this machine to listen on" "$default_port")}
  [[ $port =~ ^[0-9]+$ ]] || die "The port must be a number."
  if port_in_use "$port"; then
    die "Port $port is already in use on this machine. Run again with another one, e.g. --port 8080 --url http://$(primary_ip):8080"
  fi

  (
    umask 077
    cat > .env <<EOF
# Written by install.sh on $(date -u +%Y-%m-%d). Keep this file private: it holds the secrets.
COMPOSE_PROJECT_NAME=xspeckle
SPECKLE_URL=$url
SPECKLE_PORT=$port
SESSION_SECRET=$(random_hex 32)
SPECKLE_DB_PASSWORD=$(random_hex 16)
MINIO_ROOT_USER=xspeckle
MINIO_ROOT_PASSWORD=$(random_hex 16)
EOF
  )
  echo "Wrote .env (address $url, port $port)."
  case $url in https://*) echo "Note: point your TLS reverse proxy at port $port of this machine; it must also forward websockets." ;; esac
}

env_value() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2-; }

wait_until_ready() {
  local id status i
  echo "Waiting for the server to become ready (the first start sets up the database) ..."
  for i in $(seq 1 90); do
    id=$(compose ps -q speckle-server 2>/dev/null || true)
    status=$([ -n "$id" ] && docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || echo "starting")
    [ "$status" = healthy ] && return 0
    sleep 5
  done
  return 1
}

cmd_install() {
  check_docker
  check_resources
  if [ -f .env ]; then
    echo "Keeping the existing .env."
    grep -q '^SPECKLE_URL=' .env || die ".env has no SPECKLE_URL. Add it, or move .env away to have a new one written."
  else
    write_env
  fi

  say "Building the images. The first build takes a long time (30 minutes or more)."
  compose build "${BUILT[@]}"

  say "Starting the services"
  compose up -d "${SERVICES[@]}"

  if wait_until_ready; then
    say "xspeckle-server is running at $(env_value SPECKLE_URL)"
    cat <<EOF
Open that address and register: the first account becomes the server administrator.

  ./install.sh status    show the services
  ./install.sh logs      follow the logs
  ./install.sh stop      stop everything (data is kept)
  ./install.sh start     start again
  ./install.sh           after updating the code: rebuild and restart
EOF
  else
    warn "the server did not report ready within the time limit."
    echo "Look at its log with: ./install.sh logs speckle-server"
    exit 1
  fi
}

ASSUME_YES=0
OPT_URL=""
OPT_PORT=""
COMMAND=install
ARGS=()
while [ $# -gt 0 ]; do
  case $1 in
    --url) OPT_URL=${2:?--url needs a value}; shift 2 ;;
    --port) OPT_PORT=${2:?--port needs a value}; shift 2 ;;
    --yes | -y) ASSUME_YES=1; shift ;;
    -h | --help | help) usage; exit 0 ;;
    install | start | stop | status | logs) COMMAND=$1; shift; ARGS=("$@"); break ;;
    *) die "Unknown argument: $1 (try ./install.sh help)" ;;
  esac
done

case $COMMAND in
  install) cmd_install ;;
  start) check_docker; [ -f .env ] || die "Not installed yet: run ./install.sh first."; compose up -d "${SERVICES[@]}" ;;
  stop) check_docker; compose stop ;;
  status) check_docker; compose ps ;;
  logs) check_docker; compose logs -f --tail 100 ${ARGS[@]+"${ARGS[@]}"} ;;
esac

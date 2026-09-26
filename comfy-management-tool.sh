#!/usr/bin/env bash
#
# swarm-manage.sh — build/ship/deploy manager for comfy-orchestrator on Docker Swarm
#
# Usage:
#   ./swarm-manage.sh <command> [args]
#
# Commands:
#   build              Build the image and tag it for the local registry
#   push               Push the already-built image to the local registry
#   ship               build + push (no deploy)
#   up                 docker stack deploy using current REGISTRY/TAG
#   deploy             build + push + up  (the "one shot" release command)
#   down               Remove the stack
#   restart            down, wait for cleanup, then up (redeploys same image tag)
#   ps                 Show stack services + task status
#   logs <service>     Tail logs for a service in the stack (e.g. `logs api`)
#   config             Print the resolved config (for debugging)
#   help               Show usage
#
# Config (env vars, all overridable, e.g. `TAG=v1.2.3 ./swarm-manage.sh deploy`):
#   REGISTRY       default: 192.168.0.140:5000
#   IMAGE_NAME     default: comfy-orchestrator
#   STACK_NAME     default: comfy-orchestrator
#   COMPOSE_FILE   default: stack.yml
#   DOCKERFILE     default: Dockerfile
#   BUILD_CONTEXT  default: .
#   TAG            default: git short sha, else timestamp
#
# NOTE: 192.168.0.140:5000 (or whatever REGISTRY you set) is a plain-HTTP
# local registry. Every Swarm node needs it listed under "insecure-registries"
# in /etc/docker/daemon.json, e.g.:
#   { "insecure-registries": ["192.168.0.140:5000"] }
# ...then `systemctl restart docker` on each node, or push/pull will fail
# with a TLS handshake error.

set -euo pipefail

# ---------- config ----------
REGISTRY="${REGISTRY:-192.168.0.140:5000}"
IMAGE_NAME="${IMAGE_NAME:-comfy-orchestrator}"
STACK_NAME="${STACK_NAME:-comfy-orchestrator}"
COMPOSE_FILE="${COMPOSE_FILE:-stack.yml}"
DOCKERFILE="${DOCKERFILE:-Dockerfile}"
BUILD_CONTEXT="${BUILD_CONTEXT:-.}"
TAG="${TAG:-$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d-%H%M%S)}"

FULL_IMAGE="${REGISTRY}/${IMAGE_NAME}:${TAG}"
LATEST_IMAGE="${REGISTRY}/${IMAGE_NAME}:latest"

export REGISTRY IMAGE_NAME TAG  # so ${REGISTRY}/${IMAGE_NAME}:${TAG} in stack.yml resolves

# ---------- output helpers ----------
C_INFO='\033[1;34m'; C_OK='\033[1;32m'; C_WARN='\033[1;33m'; C_ERR='\033[1;31m'; C_RESET='\033[0m'
log()  { echo -e "${C_INFO}==>${C_RESET} $*"; }
ok()   { echo -e "${C_OK}✔${C_RESET} $*"; }
warn() { echo -e "${C_WARN}!${C_RESET} $*"; }
err()  { echo -e "${C_ERR}✘ $*${C_RESET}" >&2; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { err "'$1' is not installed or not on PATH"; exit 1; }
}

require_swarm() {
  local state
  state=$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || echo "unknown")
  if [[ "$state" != "active" ]]; then
    err "This node is not part of an active Swarm (state: $state). Run 'docker swarm init' first."
    exit 1
  fi
}

require_compose_file() {
  if [[ ! -f "$COMPOSE_FILE" ]]; then
    err "Compose/stack file '$COMPOSE_FILE' not found in $(pwd). Set COMPOSE_FILE=path/to/file.yml"
    exit 1
  fi
}

# ---------- commands ----------
cmd_config() {
  cat <<EOF
REGISTRY       = $REGISTRY
IMAGE_NAME     = $IMAGE_NAME
TAG            = $TAG
FULL_IMAGE     = $FULL_IMAGE
LATEST_IMAGE   = $LATEST_IMAGE
STACK_NAME     = $STACK_NAME
COMPOSE_FILE   = $COMPOSE_FILE
DOCKERFILE     = $DOCKERFILE
BUILD_CONTEXT  = $BUILD_CONTEXT
EOF
}

cmd_build() {
  log "Building $FULL_IMAGE (also tagging :latest)"
  docker build \
    -f "$DOCKERFILE" \
    -t "$FULL_IMAGE" \
    -t "$LATEST_IMAGE" \
    "$BUILD_CONTEXT"
  ok "Built $FULL_IMAGE"
}

cmd_push() {
  log "Pushing $FULL_IMAGE to $REGISTRY"
  docker push "$FULL_IMAGE"
  log "Pushing $LATEST_IMAGE to $REGISTRY"
  docker push "$LATEST_IMAGE"
  ok "Pushed $IMAGE_NAME (tags: $TAG, latest)"
}

cmd_ship() {
  cmd_build
  cmd_push
}

cmd_up() {
  require_swarm
  require_compose_file
  log "Deploying stack '$STACK_NAME' from $COMPOSE_FILE (image tag: $TAG)"
  docker stack deploy -c "$COMPOSE_FILE" --with-registry-auth "$STACK_NAME"
  ok "Stack '$STACK_NAME' deployed"
  cmd_ps
}

cmd_deploy() {
  cmd_ship
  cmd_up
}

cmd_down() {
  require_swarm
  log "Removing stack '$STACK_NAME'"
  docker stack rm "$STACK_NAME"
  # docker stack rm returns immediately; give networks/volumes a moment to clear
  log "Waiting for stack resources to clear..."
  sleep 5
  ok "Stack '$STACK_NAME' removed"
}

cmd_restart() {
  cmd_down
  cmd_up
}

cmd_ps() {
  require_swarm
  log "Services in '$STACK_NAME':"
  docker stack services "$STACK_NAME" 2>/dev/null || warn "Stack '$STACK_NAME' not found/running"
  echo
  log "Tasks in '$STACK_NAME':"
  docker stack ps "$STACK_NAME" --no-trunc 2>/dev/null || true
}

cmd_logs() {
  local svc="${1:-}"
  if [[ -z "$svc" ]]; then
    err "Usage: $0 logs <service-name>   (e.g. logs api)"
    echo
    log "Available services:"
    docker stack services "$STACK_NAME" --format '  {{.Name}}' 2>/dev/null || true
    exit 1
  fi
  local full_svc="${STACK_NAME}_${svc}"
  if ! docker service inspect "$full_svc" >/dev/null 2>&1; then
    if docker service inspect "$svc" >/dev/null 2>&1; then
      full_svc="$svc"
    else
      err "Service '$full_svc' (or '$svc') not found."
      docker stack services "$STACK_NAME" --format '  {{.Name}}' 2>/dev/null || true
      exit 1
    fi
  fi
  log "Tailing logs for $full_svc (Ctrl+C to stop)"
  docker service logs -f --tail 200 "$full_svc"
}

usage() {
  sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'
}

# ---------- entrypoint ----------
require_cmd docker

case "${1:-help}" in
  build)    cmd_build ;;
  push)     cmd_push ;;
  ship)     cmd_ship ;;
  up)       cmd_up ;;
  deploy)   cmd_deploy ;;
  down)     cmd_down ;;
  restart)  cmd_restart ;;
  ps)       cmd_ps ;;
  logs)     shift; cmd_logs "${1:-}" ;;
  config)   cmd_config ;;
  help|-h|--help) usage ;;
  *)
    err "Unknown command: ${1:-}"
    usage
    exit 1
    ;;
esac

#!/usr/bin/env bash
set -Eeuo pipefail

CURRENT_STAGE="init"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${HOMELAB_PROJECT_ROOT:-/home/gsg/workspace/project/homelab}"
SOURCE_DIR="${HOMELAB_SOURCE_DIR:-${PROJECT_ROOT}/source}"
RUNTIME_DIR="${HOMELAB_RUNTIME_DIR:-${PROJECT_ROOT}/deploy}"
ENV_FILE="${HOMELAB_ENV_FILE:-${RUNTIME_DIR}/.env}"
REPO_URL="${HOMELAB_REPO_URL:-git@github.com:gsgsdtc/homelab.git}"
GIT_REF="${HOMELAB_GIT_REF:-main}"
DOMAIN="${HOMELAB_DOMAIN:-home.gfun.vip}"
PORTAL_PUBLIC_PORT="${HOMELAB_PORTAL_PUBLIC_PORT:-8321}"
ADMIN_PUBLIC_PORT="${HOMELAB_ADMIN_PUBLIC_PORT:-8322}"
BACKEND_PUBLIC_PORT="${HOMELAB_BACKEND_PUBLIC_PORT:-8323}"
BACKEND_PORT="${HOMELAB_BACKEND_PORT:-3000}"
ADMIN_PORT="${HOMELAB_ADMIN_PORT:-3002}"
PORTAL_PORT="${HOMELAB_PORTAL_PORT:-3001}"
BACKEND_IP="${HOMELAB_BACKEND_IP:-127.0.0.1}"
ADMIN_IP="${HOMELAB_ADMIN_IP:-127.0.0.1}"
PORTAL_IP="${HOMELAB_PORTAL_IP:-127.0.0.1}"
NGINX_CONTAINER="${HOMELAB_NGINX_CONTAINER:-nginx}"
NGINX_CONFIG_DIR="${HOMELAB_NGINX_CONFIG_DIR:-/home/gsg/workspace/app/nginx/config}"
LOG_DIR="${HOMELAB_LOG_DIR:-${RUNTIME_DIR}/logs}"
PID_DIR="${HOMELAB_PID_DIR:-${RUNTIME_DIR}/pids}"
LOG_TAIL="${HOMELAB_LOG_TAIL:-120}"
RESULT_FILE="${HOMELAB_DEPLOY_RESULT_FILE:-${RUNTIME_DIR}/deploy-result.json}"
DEPLOY_TRIGGER="${HOMELAB_DEPLOY_TRIGGER:-manual}"
DEPLOY_TRIGGER_REF="${HOMELAB_DEPLOY_TRIGGER_REF:-}"
DEPLOY_TRIGGER_SHA="${HOMELAB_DEPLOY_TRIGGER_SHA:-}"
DEPLOY_TRIGGER_RUN_URL="${HOMELAB_DEPLOY_TRIGGER_RUN_URL:-}"
DEPLOY_COMMIT_SHA=""
RESULT_WRITTEN=0
NGINX_RELOADED=0

CHECK_ONLY=0
SKIP_GIT=0
SKIP_NGINX=0

usage() {
  cat <<USAGE
Usage: ./ops-deploy.sh [--check-only] [--skip-git] [--skip-nginx]

Environment overrides:
  HOMELAB_PROJECT_ROOT       default: /home/gsg/workspace/project/homelab
  HOMELAB_SOURCE_DIR         default: \$HOMELAB_PROJECT_ROOT/source
  HOMELAB_RUNTIME_DIR        default: \$HOMELAB_PROJECT_ROOT/deploy
  HOMELAB_ENV_FILE           default: \$HOMELAB_RUNTIME_DIR/.env
  HOMELAB_ENV_SOURCE         optional source file copied to HOMELAB_ENV_FILE
  HOMELAB_GIT_REF            branch/tag/SHA to deploy, default: main
  HOMELAB_DEPLOY_RESULT_FILE QA-readable JSON result path, default: \$HOMELAB_RUNTIME_DIR/deploy-result.json
  HOMELAB_DOMAIN             default: home.gfun.vip
  HOMELAB_BACKEND_PORT       default: 3000
  HOMELAB_ADMIN_PORT         default: 3002
  HOMELAB_PORTAL_PORT        default: 3001
  HOMELAB_NGINX_CONTAINER    default: nginx
  HOMELAB_NGINX_CONFIG_DIR   default: /home/gsg/workspace/app/nginx/config
  HOMELAB_RUN_PRISMA_MIGRATE set to 1 to run prisma migrate deploy
  HOMELAB_PRISMA_BASELINE_CONFIRMED must be 1 when migrations are enabled
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check-only)
      CHECK_ONLY=1
      ;;
    --skip-git)
      SKIP_GIT=1
      ;;
    --skip-nginx)
      SKIP_NGINX=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

on_error() {
  local rc=$?
  trap - ERR
  echo
  echo "Deploy failed"
  echo "stage: ${CURRENT_STAGE}"
  echo "exit_code: ${rc}"
  if [ "${RESULT_WRITTEN}" -eq 0 ]; then
    write_deploy_result "failure" "${rc}" "Unhandled error; inspect deploy log." || true
  fi
  exit "${rc}"
}

trap on_error ERR

stage() {
  CURRENT_STAGE="$1"
  echo
  echo "==> ${CURRENT_STAGE}"
}

json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf "%s" "${value}"
}

write_deploy_result() {
  local status="$1"
  local exit_code="${2:-0}"
  local failure_summary="${3:-}"
  local now commit tmp

  [ -n "${RESULT_FILE}" ] || return 0

  now="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  commit="${DEPLOY_COMMIT_SHA}"
  if [ -z "${commit}" ] && [ -d "${SOURCE_DIR}/.git" ]; then
    commit="$(git -C "${SOURCE_DIR}" rev-parse HEAD 2>/dev/null || true)"
  fi

  mkdir -p "$(dirname "${RESULT_FILE}")"
  tmp="$(mktemp)"
  {
    echo "{"
    echo "  \"status\": \"$(json_escape "${status}")\","
    echo "  \"exit_code\": ${exit_code},"
    echo "  \"stage\": \"$(json_escape "${CURRENT_STAGE}")\","
    echo "  \"deployed_at\": \"$(json_escape "${now}")\","
    echo "  \"git_ref\": \"$(json_escape "${GIT_REF}")\","
    echo "  \"commit_sha\": \"$(json_escape "${commit}")\","
    echo "  \"source_dir\": \"$(json_escape "${SOURCE_DIR}")\","
    echo "  \"result_file\": \"$(json_escape "${RESULT_FILE}")\","
    echo "  \"trigger\": {"
    echo "    \"source\": \"$(json_escape "${DEPLOY_TRIGGER}")\","
    echo "    \"ref\": \"$(json_escape "${DEPLOY_TRIGGER_REF}")\","
    echo "    \"sha\": \"$(json_escape "${DEPLOY_TRIGGER_SHA}")\","
    echo "    \"run_url\": \"$(json_escape "${DEPLOY_TRIGGER_RUN_URL}")\""
    echo "  },"
    if [ "${status}" = "success" ]; then
      echo "  \"urls\": {"
      echo "    \"portal\": \"https://$(json_escape "${DOMAIN}"):${PORTAL_PUBLIC_PORT}/\","
      echo "    \"admin\": \"https://$(json_escape "${DOMAIN}"):${ADMIN_PUBLIC_PORT}/login\","
      echo "    \"backend\": \"https://$(json_escape "${DOMAIN}"):${BACKEND_PUBLIC_PORT}/health\","
      echo "    \"rewrite\": \"https://$(json_escape "${DOMAIN}"):${ADMIN_PUBLIC_PORT}/api/backend/health\""
      echo "  },"
      echo "  \"failure\": null"
    else
      echo "  \"urls\": null,"
      echo "  \"failure\": {"
      echo "    \"stage\": \"$(json_escape "${CURRENT_STAGE}")\","
      echo "    \"summary\": \"$(json_escape "${failure_summary}")\""
      echo "  }"
    fi
    echo "}"
  } > "${tmp}"
  install -m 644 "${tmp}" "${RESULT_FILE}"
  rm -f "${tmp}"
  RESULT_WRITTEN=1
  echo "Deploy result written: ${RESULT_FILE}"
}

die() {
  local summary="$*"
  echo
  echo "Deploy failed"
  echo "stage: ${CURRENT_STAGE}"
  echo "summary: ${summary}" >&2
  write_deploy_result "failure" 1 "${summary}" || true
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Required command is missing: $1"
}

load_env() {
  if [ -f "${ENV_FILE}" ]; then
    set -a
    # shellcheck source=/dev/null
    . "${ENV_FILE}"
    set +a
  fi
}

check_dependencies() {
  stage "dependency check"
  require_cmd git
  require_cmd curl
  require_cmd pnpm
  require_cmd node
  require_cmd start-stop-daemon
  echo "Host dependencies are present. Services will run directly from source code (no Docker)."
}

checkout_ref() {
  git -C "${SOURCE_DIR}" fetch --prune origin
  if git -C "${SOURCE_DIR}" rev-parse --verify --quiet "refs/remotes/origin/${GIT_REF}" >/dev/null; then
    git -C "${SOURCE_DIR}" checkout -B "${GIT_REF}" "origin/${GIT_REF}"
    git -C "${SOURCE_DIR}" pull --ff-only origin "${GIT_REF}"
  else
    git -C "${SOURCE_DIR}" checkout "${GIT_REF}"
  fi
}

sync_source() {
  stage "source sync"
  mkdir -p "${PROJECT_ROOT}"
  if [ "${SKIP_GIT}" -eq 1 ]; then
    echo "Skipping git sync by request."
  elif [ -d "${SOURCE_DIR}/.git" ]; then
    checkout_ref
  else
    git clone "${REPO_URL}" "${SOURCE_DIR}"
    checkout_ref
  fi

  [ -f "${SOURCE_DIR}/package.json" ] || die "Missing package.json in source"
  DEPLOY_COMMIT_SHA="$(git -C "${SOURCE_DIR}" rev-parse HEAD)"
  echo "Source ready: ${SOURCE_DIR}"
  echo "Source revision: ${DEPLOY_COMMIT_SHA}"
}

copy_env_source() {
  if [ -z "${HOMELAB_ENV_SOURCE:-}" ]; then
    return 1
  fi
  [ -f "${HOMELAB_ENV_SOURCE}" ] || die "HOMELAB_ENV_SOURCE does not exist: ${HOMELAB_ENV_SOURCE}"
  install -m 600 "${HOMELAB_ENV_SOURCE}" "${ENV_FILE}"
  echo "Installed env file from HOMELAB_ENV_SOURCE."
}

env_value() {
  local key="$1"
  local line
  line="$(grep -E "^${key}=" "${ENV_FILE}" | tail -n 1 || true)"
  line="${line#*=}"
  line="${line%\"}"
  line="${line#\"}"
  line="${line%\'}"
  line="${line#\'}"
  printf "%s" "${line}"
}

validate_required_env() {
  local missing=()
  local key value
  for key in DATABASE_URL JWT_SECRET; do
    value="$(env_value "${key}")"
    if [ -z "${value}" ] || [[ "${value}" == *change-me* ]] || [[ "${value}" == *example* ]]; then
      missing+=("${key}")
    fi
  done

  if [ "${#missing[@]}" -gt 0 ]; then
    die "Set real values for required env keys in ${ENV_FILE}: ${missing[*]}"
  fi
}

prepare_config() {
  stage "configuration"
  mkdir -p "${RUNTIME_DIR}"
  mkdir -p "$(dirname "${ENV_FILE}")"
  if [ ! -f "${ENV_FILE}" ]; then
    if ! copy_env_source; then
      install -m 600 "${SOURCE_DIR}/deploy/env.local.example" "${ENV_FILE}"
      die "Created ${ENV_FILE} from deploy/env.local.example. Fill the required secrets and rerun."
    fi
  fi
  chmod 600 "${ENV_FILE}"
  validate_required_env
  load_env
  echo "Runtime env file validated: ${ENV_FILE}"
}

install_dependencies() {
  stage "dependency install"
  cd "${SOURCE_DIR}"
  pnpm install
  echo "Dependencies installed."
}

build_apps() {
  stage "build apps"
  cd "${SOURCE_DIR}"
  # Admin rewrites bake ADMIN_BACKEND_URL at build time; default to local backend.
  export ADMIN_BACKEND_URL="${ADMIN_BACKEND_URL:-http://${BACKEND_IP}:${BACKEND_PORT}}"
  export NEXT_PUBLIC_ADMIN_API_BASE_URL="${NEXT_PUBLIC_ADMIN_API_BASE_URL:-/api/backend}"
  pnpm build
  echo "Apps built."
}

run_migrations_if_enabled() {
  stage "database migration gate"
  if [ "${HOMELAB_RUN_PRISMA_MIGRATE:-0}" != "1" ]; then
    echo "Prisma migrate deploy is skipped. Set HOMELAB_RUN_PRISMA_MIGRATE=1 after baseline confirmation."
    return
  fi
  if [ "${HOMELAB_PRISMA_BASELINE_CONFIRMED:-0}" != "1" ]; then
    die "Refusing Prisma migrations until HOMELAB_PRISMA_BASELINE_CONFIRMED=1 is set"
  fi
  cd "${SOURCE_DIR}"
  pnpm --filter @homelab/backend prisma migrate deploy
}

service_pid_file() {
  printf "%s/%s.pid" "${PID_DIR}" "$1"
}

service_log_file() {
  printf "%s/%s.log" "${LOG_DIR}" "$1"
}

stop_service() {
  local name="$1"
  local pid_file
  pid_file="$(service_pid_file "${name}")"
  if [ -f "${pid_file}" ]; then
    start-stop-daemon --stop --pidfile "${pid_file}" --retry TERM/5/KILL/5 --remove-pidfile || true
  fi
}

start_service() {
  local name="$1"
  local command="$2"
  local pid_file log_file workdir
  pid_file="$(service_pid_file "${name}")"
  log_file="$(service_log_file "${name}")"
  workdir="${SOURCE_DIR}"

  mkdir -p "${PID_DIR}" "${LOG_DIR}"
  stop_service "${name}"

  : > "${log_file}"
  start-stop-daemon --start --background \
    --pidfile "${pid_file}" --make-pidfile \
    --chdir "${workdir}" \
    --output "${log_file}" \
    --startas /bin/bash -- -c "exec ${command}"
  echo "${name} started."
}

stop_services() {
  stage "stop services"
  stop_service "homelab-portal"
  stop_service "homelab-admin"
  stop_service "homelab-backend"
  echo "Old services stopped."
}

start_services() {
  stage "start services"
  start_service "homelab-backend" "PORT=${BACKEND_PORT} pnpm --filter @homelab/backend start"
  start_service "homelab-admin" "PORT=${ADMIN_PORT} ADMIN_BACKEND_URL=http://${BACKEND_IP}:${BACKEND_PORT} pnpm --filter @homelab/admin start"
  start_service "homelab-portal" "PORT=${PORTAL_PORT} pnpm --filter @homelab/portal start"
  echo "New services started."
}

render_nginx_config() {
  cat <<NGINX
# Managed by homelab ops-deploy.sh.
server {
    listen ${PORTAL_PUBLIC_PORT} ssl;
    server_name ${DOMAIN};

    ssl_certificate /etc/nginx/conf.d/${DOMAIN}.pem;
    ssl_certificate_key /etc/nginx/conf.d/${DOMAIN}.key;

    location / {
        proxy_pass http://${PORTAL_IP}:${PORTAL_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}

server {
    listen ${ADMIN_PUBLIC_PORT} ssl;
    server_name ${DOMAIN};

    ssl_certificate /etc/nginx/conf.d/${DOMAIN}.pem;
    ssl_certificate_key /etc/nginx/conf.d/${DOMAIN}.key;

    location / {
        proxy_pass http://${ADMIN_IP}:${ADMIN_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}

server {
    listen ${BACKEND_PUBLIC_PORT} ssl;
    server_name ${DOMAIN};

    ssl_certificate /etc/nginx/conf.d/${DOMAIN}.pem;
    ssl_certificate_key /etc/nginx/conf.d/${DOMAIN}.key;

    location / {
        proxy_pass http://${BACKEND_IP}:${BACKEND_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
NGINX
}

configure_nginx() {
  stage "nginx registration"
  if [ "${SKIP_NGINX}" -eq 1 ]; then
    echo "Skipping nginx registration by request."
    return
  fi

  require_cmd docker
  docker inspect "${NGINX_CONTAINER}" >/dev/null || die "nginx container '${NGINX_CONTAINER}' is not available"

  mkdir -p "${NGINX_CONFIG_DIR}"
  local managed_conf="${NGINX_CONFIG_DIR}/homelab.conf"
  local tmp
  tmp="$(mktemp)"
  render_nginx_config > "${tmp}"

  if [ -f "${managed_conf}" ] && cmp -s "${tmp}" "${managed_conf}"; then
    echo "nginx managed config is unchanged: ${managed_conf}"
    rm -f "${tmp}"
    return
  fi

  install -m 644 "${tmp}" "${managed_conf}"
  rm -f "${tmp}"
  echo "Wrote nginx managed config: ${managed_conf}"

  docker exec "${NGINX_CONTAINER}" nginx -t
  if docker exec "${NGINX_CONTAINER}" nginx -s reload; then
    NGINX_RELOADED=1
    echo "nginx reloaded."
  else
    docker restart "${NGINX_CONTAINER}" >/dev/null
    NGINX_RELOADED=1
    echo "nginx restarted."
  fi
}

wait_for_service() {
  local name="$1"
  local url="$2"
  local timeout="${3:-60}"
  local elapsed=0
  while [ "${elapsed}" -lt "${timeout}" ]; do
    if curl --fail --silent --show-error --location --connect-timeout 2 --max-time 5 "${url}" >/dev/null 2>&1; then
      echo "${name}: healthy"
      return
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  die "${name} did not become healthy within ${timeout}s"
}

wait_for_services() {
  stage "service health"
  wait_for_service "backend" "http://${BACKEND_IP}:${BACKEND_PORT}/health" 90
  wait_for_service "admin" "http://${ADMIN_IP}:${ADMIN_PORT}/login" 90
  wait_for_service "portal" "http://${PORTAL_IP}:${PORTAL_PORT}/" 90
}

check_logs() {
  stage "log check"
  local service log_file
  for service in homelab-backend homelab-admin homelab-portal; do
    log_file="$(service_log_file "${service}")"
    if [ -f "${log_file}" ]; then
      echo "Checking recent logs for ${service}"
      if tail -n "${LOG_TAIL}" "${log_file}" | grep -Eai "(exception|fatal|panic|failed|error)" >/tmp/homelab-${service}-deploy-errors.log; then
        cat "/tmp/homelab-${service}-deploy-errors.log" >&2
        die "Recent ${service} logs contain error patterns"
      fi
    fi
  done
}

curl_url() {
  local name="$1"
  local url="$2"
  local extra=()
  if [ "${HOMELAB_CURL_INSECURE:-0}" = "1" ]; then
    extra+=("--insecure")
  fi
  echo "Probing ${name}: ${url}"
  curl "${extra[@]}" --fail --silent --show-error --location --connect-timeout 5 --max-time 20 --retry 3 --retry-delay 2 "${url}" >/dev/null
}

health_check() {
  stage "public health check"
  curl_url "portal" "https://${DOMAIN}:${PORTAL_PUBLIC_PORT}/"
  curl_url "admin" "https://${DOMAIN}:${ADMIN_PUBLIC_PORT}/login"
  curl_url "admin backend rewrite" "https://${DOMAIN}:${ADMIN_PUBLIC_PORT}/api/backend/health"
  curl_url "backend" "https://${DOMAIN}:${BACKEND_PUBLIC_PORT}/health"
}

print_urls() {
  stage "deployment summary"
  echo "Deployment succeeded."
  echo "QA URLs:"
  echo "  portal:  https://${DOMAIN}:${PORTAL_PUBLIC_PORT}/"
  echo "  admin:   https://${DOMAIN}:${ADMIN_PUBLIC_PORT}/login"
  echo "  backend: https://${DOMAIN}:${BACKEND_PUBLIC_PORT}/health"
  echo "  rewrite: https://${DOMAIN}:${ADMIN_PUBLIC_PORT}/api/backend/health"
}

write_success_result() {
  stage "result writeback"
  write_deploy_result "success" 0 ""
}

main() {
  check_dependencies
  sync_source
  prepare_config

  if [ "${CHECK_ONLY}" -eq 1 ]; then
    echo
    echo "Check-only mode completed before build/start."
    exit 0
  fi

  install_dependencies
  build_apps
  run_migrations_if_enabled
  stop_services
  start_services
  configure_nginx
  wait_for_services
  check_logs
  health_check
  write_success_result
  print_urls
}

main

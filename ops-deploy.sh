#!/usr/bin/env bash
set -Eeuo pipefail

CURRENT_STAGE="init"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${HOMELAB_PROJECT_ROOT:-/home/gsg/workspace/project/homelab}"
SOURCE_DIR="${HOMELAB_SOURCE_DIR:-${PROJECT_ROOT}/source}"
RUNTIME_DIR="${HOMELAB_RUNTIME_DIR:-${PROJECT_ROOT}/deploy}"
ENV_FILE="${HOMELAB_ENV_FILE:-${RUNTIME_DIR}/.env}"
ENV_TEMPLATE="${HOMELAB_ENV_TEMPLATE:-${SOURCE_DIR}/deploy/env.local.example}"
LOG_DIR="${RUNTIME_DIR}/logs"
USER_SYSTEMD_DIR="${HOMELAB_USER_SYSTEMD_DIR:-$HOME/.config/systemd/user}"
REPO_URL="${HOMELAB_REPO_URL:-git@github.com:gsgsdtc/homelab.git}"
GIT_REF="${HOMELAB_GIT_REF:-main}"
DOMAIN="${HOMELAB_DOMAIN:-home.gfun.vip}"
BACKEND_PORT="${HOMELAB_BACKEND_PORT:-3005}"
ADMIN_PORT="${HOMELAB_ADMIN_PORT:-3006}"
PORTAL_PORT="${HOMELAB_PORTAL_PORT:-3007}"
BACKEND_HOST="${HOMELAB_BACKEND_HOST:-192.168.50.11}"
ADMIN_HOST="${HOMELAB_ADMIN_HOST:-192.168.50.11}"
PORTAL_HOST="${HOMELAB_PORTAL_HOST:-192.168.50.11}"
NGINX_CONTAINER="${HOMELAB_NGINX_CONTAINER:-nginx}"
NGINX_CONFIG_DIR="${HOMELAB_NGINX_CONFIG_DIR:-/home/gsg/workspace/app/nginx/config}"
RESULT_FILE="${HOMELAB_DEPLOY_RESULT_FILE:-${RUNTIME_DIR}/deploy-result.json}"
LOG_TAIL="${HOMELAB_LOG_TAIL:-120}"
DEPLOY_COMMIT_SHA=""
RESULT_WRITTEN=0

CHECK_ONLY=0
SKIP_GIT=0
SKIP_NGINX=0

usage() {
  cat <<USAGE
Usage: ./deploy.sh [--check-only] [--skip-git] [--skip-nginx]

Environment overrides:
  HOMELAB_PROJECT_ROOT       default: /home/gsg/workspace/project/homelab
  HOMELAB_SOURCE_DIR         default: \$HOMELAB_PROJECT_ROOT/source
  HOMELAB_RUNTIME_DIR        default: \$HOMELAB_PROJECT_ROOT/deploy
  HOMELAB_ENV_FILE           default: \$HOMELAB_RUNTIME_DIR/.env
  HOMELAB_ENV_SOURCE         optional source file copied to HOMELAB_ENV_FILE
  HOMELAB_ENV_TEMPLATE       default: \$HOMELAB_SOURCE_DIR/deploy/env.local.example
  HOMELAB_GIT_REF            branch/tag/SHA to deploy, default: main
  HOMELAB_DEPLOY_RESULT_FILE QA-readable JSON result path
  HOMELAB_DOMAIN             default: home.gfun.vip
  HOMELAB_BACKEND_PORT       default: 3005
  HOMELAB_ADMIN_PORT         default: 3006
  HOMELAB_PORTAL_PORT        default: 3007
  HOMELAB_CURL_INSECURE      set to 1 to skip TLS verification in health checks
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
    echo "    \"name\": \"$(json_escape "${HOMELAB_DEPLOY_TRIGGER:-manual}")\","
    echo "    \"ref\": \"$(json_escape "${HOMELAB_DEPLOY_TRIGGER_REF:-}")\","
    echo "    \"sha\": \"$(json_escape "${HOMELAB_DEPLOY_TRIGGER_SHA:-}")\","
    echo "    \"run_url\": \"$(json_escape "${HOMELAB_DEPLOY_TRIGGER_RUN_URL:-}")\""
    echo "  },"
    if [ "${status}" = "success" ]; then
      echo "  \"urls\": {"
      echo "    \"portal\": \"https://$(json_escape "${DOMAIN}"):8321/\","
      echo "    \"admin\": \"https://$(json_escape "${DOMAIN}"):8322/login\","
      echo "    \"backend\": \"https://$(json_escape "${DOMAIN}"):8323/health\","
      echo "    \"rewrite\": \"https://$(json_escape "${DOMAIN}"):8322/api/backend/health\""
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
    source "${ENV_FILE}"
    set +a
  fi
}

check_dependencies() {
  stage "dependency check"
  require_cmd git
  require_cmd node
  require_cmd pnpm
  require_cmd curl
  require_cmd docker
  require_cmd systemctl
  node --version
  pnpm --version
  echo "Host dependencies are present."
}

sync_source() {
  stage "source sync"
  mkdir -p "${PROJECT_ROOT}"
  if [ "${SKIP_GIT}" -eq 1 ]; then
    echo "Skipping git sync by request."
  elif [ -d "${SOURCE_DIR}/.git" ]; then
    git -C "${SOURCE_DIR}" fetch --prune origin
    if git -C "${SOURCE_DIR}" rev-parse --verify --quiet "refs/remotes/origin/${GIT_REF}" >/dev/null; then
      git -C "${SOURCE_DIR}" checkout -B "${GIT_REF}" "origin/${GIT_REF}"
      git -C "${SOURCE_DIR}" pull --ff-only origin "${GIT_REF}"
    else
      git -C "${SOURCE_DIR}" checkout "${GIT_REF}"
    fi
  else
    git clone "${REPO_URL}" "${SOURCE_DIR}"
    git -C "${SOURCE_DIR}" checkout "${GIT_REF}"
  fi
  DEPLOY_COMMIT_SHA="$(git -C "${SOURCE_DIR}" rev-parse HEAD)"
  echo "Source ready: ${SOURCE_DIR}"
  echo "Source revision: ${DEPLOY_COMMIT_SHA}"
}

prepare_config() {
  stage "configuration"
  mkdir -p "${RUNTIME_DIR}" "${LOG_DIR}" "${USER_SYSTEMD_DIR}"
  if [ ! -f "${ENV_FILE}" ]; then
    if [ -n "${HOMELAB_ENV_SOURCE:-}" ]; then
      [ -f "${HOMELAB_ENV_SOURCE}" ] || die "HOMELAB_ENV_SOURCE is missing: ${HOMELAB_ENV_SOURCE}"
      install -m 600 "${HOMELAB_ENV_SOURCE}" "${ENV_FILE}"
    else
      [ -f "${ENV_TEMPLATE}" ] || die "Env template is missing: ${ENV_TEMPLATE}"
      install -m 600 "${ENV_TEMPLATE}" "${ENV_FILE}"
      die "Created ${ENV_FILE} from ${ENV_TEMPLATE}. Fill the required secrets and rerun."
    fi
  fi
  chmod 600 "${ENV_FILE}"

  # Point admin rewrite to the direct backend on the host loopback.
  if grep -q "^ADMIN_BACKEND_URL=" "${ENV_FILE}"; then
    sed -i "s|^ADMIN_BACKEND_URL=.*|ADMIN_BACKEND_URL=http://127.0.0.1:${BACKEND_PORT}|" "${ENV_FILE}"
  else
    printf "\nADMIN_BACKEND_URL=http://127.0.0.1:%s\n" "${BACKEND_PORT}" >> "${ENV_FILE}"
  fi

  # Basic validation
  local db_url jwt_secret
  db_url="$(grep -E "^DATABASE_URL=" "${ENV_FILE}" | tail -n1 | cut -d= -f2- || true)"
  jwt_secret="$(grep -E "^JWT_SECRET=" "${ENV_FILE}" | tail -n1 | cut -d= -f2- || true)"
  if [ -z "${db_url}" ] || [ -z "${jwt_secret}" ]; then
    die "DATABASE_URL and JWT_SECRET must be set in ${ENV_FILE}"
  fi
  if [[ "${db_url}" == *change-me* ]] || [[ "${jwt_secret}" == *change-me* ]]; then
    die "Replace placeholder DATABASE_URL and JWT_SECRET values in ${ENV_FILE}"
  fi
  echo "Runtime env file validated: ${ENV_FILE}"
}

install_dependencies() {
  stage "install dependencies"
  cd "${SOURCE_DIR}"
  CI=true NODE_ENV=development pnpm install --frozen-lockfile
}

build_apps() {
  stage "build apps"
  cd "${SOURCE_DIR}"
  load_env
  # Backend
  pnpm --filter @homelab/backend build
  # Admin: build with the backend rewrite target pointing to the local backend.
  ADMIN_BACKEND_URL="http://127.0.0.1:${BACKEND_PORT}" \
    NEXT_PUBLIC_ADMIN_API_BASE_URL="/api/backend" \
    pnpm --filter @homelab/admin build
  # Portal
  NEXT_PUBLIC_SITE_URL="https://${DOMAIN}:8321" \
    pnpm --filter @homelab/portal build
}

stop_docker_homelab() {
  stage "stop docker homelab containers"
  local containers=(homelab-backend homelab-admin homelab-portal)
  local c
  for c in "${containers[@]}"; do
    if docker inspect "${c}" >/dev/null 2>&1; then
      echo "Stopping Docker container: ${c}"
      docker stop "${c}" >/dev/null || true
      docker rm "${c}" >/dev/null || true
    fi
  done
}

update_nginx_default_conf() {
  local conf="${NGINX_CONFIG_DIR}/default.conf"
  local tmp
  tmp="$(mktemp)"

  cp -a "${conf}" "${tmp}"

  # Update Homelab proxy targets to the direct host deployment.
  # These three lines are the only references to the Homelab Docker network IPs
  # on the Homelab public ports (8321/8322/8323) in the original default.conf.
  sed -i "s|proxy_pass http://192.168.52.24:3000/;|proxy_pass http://${PORTAL_HOST}:${PORTAL_PORT}/;|" "${tmp}"
  sed -i "s|proxy_pass http://192.168.52.23:3002/;|proxy_pass http://${ADMIN_HOST}:${ADMIN_PORT}/;|" "${tmp}"
  sed -i "s|proxy_pass http://192.168.52.22:3000/;|proxy_pass http://${BACKEND_HOST}:${BACKEND_PORT}/;|" "${tmp}"

  if cmp -s "${tmp}" "${conf}"; then
    echo "nginx default.conf is unchanged"
  else
    install -m 644 "${tmp}" "${conf}"
    echo "Updated nginx default.conf Homelab proxy targets"
  fi
  rm -f "${tmp}"
}

configure_nginx() {
  stage "nginx registration"
  if [ "${SKIP_NGINX}" -eq 1 ]; then
    echo "Skipping nginx registration by request."
    return
  fi

  mkdir -p "${NGINX_CONFIG_DIR}"
  # Remove any standalone homelab.conf created by earlier iterations to avoid
  # duplicate listen directives with default.conf.
  rm -f "${NGINX_CONFIG_DIR}/homelab.conf"
  update_nginx_default_conf

  docker exec "${NGINX_CONTAINER}" nginx -t
  if ! docker exec "${NGINX_CONTAINER}" nginx -s reload; then
    docker restart "${NGINX_CONTAINER}" >/dev/null
  fi
}

write_systemd_service() {
  local name="$1"
  local port="$2"
  local service="$3"
  local pkg="$4"
  local extra_env="$5"
  local log_file="${LOG_DIR}/${name}.log"
  local unit="${USER_SYSTEMD_DIR}/homelab-${name}.service"

  cat > "${unit}" <<UNIT
[Unit]
Description=Homelab ${service}
After=network.target

[Service]
Type=simple
WorkingDirectory=${SOURCE_DIR}
EnvironmentFile=${ENV_FILE}
Environment=PATH=/home/gsg/.nvm/versions/node/v24.13.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=PORT=${port}
Environment=NODE_ENV=production
${extra_env}
ExecStart=/home/gsg/.nvm/versions/node/v24.13.0/bin/pnpm --filter ${pkg} ${service}
StandardOutput=append:${log_file}
StandardError=append:${log_file}
SyslogIdentifier=homelab-${name}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT
  chmod 644 "${unit}"
  echo "Wrote systemd user unit: ${unit}"
}

restart_services() {
  stage "service restart"

  write_systemd_service "backend" "${BACKEND_PORT}" "start" "@homelab/backend" ""
  write_systemd_service "admin" "${ADMIN_PORT}" "exec next start -p ${ADMIN_PORT}" "@homelab/admin" "Environment=ADMIN_BACKEND_URL=http://127.0.0.1:${BACKEND_PORT}"
  write_systemd_service "portal" "${PORTAL_PORT}" "exec next start -p ${PORTAL_PORT}" "@homelab/portal" "Environment=NEXT_PUBLIC_SITE_URL=https://${DOMAIN}:8321"

  systemctl --user daemon-reload
  systemctl --user stop homelab-backend homelab-admin homelab-portal 2>/dev/null || true
  systemctl --user enable homelab-backend homelab-admin homelab-portal
  systemctl --user start homelab-backend homelab-admin homelab-portal
}

wait_for_port() {
  local name="$1"
  local port="$2"
  local timeout="${3:-90}"
  local elapsed=0
  echo "Waiting for ${name} on port ${port}..."
  while [ "${elapsed}" -lt "${timeout}" ]; do
    if ss -tln 2>/dev/null | grep -E ":${port}[[:space:]]" >/dev/null; then
      echo "${name} is listening on port ${port}"
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  die "${name} did not start listening on port ${port} within ${timeout}s"
}

wait_for_services() {
  stage "wait for services"
  wait_for_port "backend" "${BACKEND_PORT}" 120
  wait_for_port "admin" "${ADMIN_PORT}" 120
  wait_for_port "portal" "${PORTAL_PORT}" 120
  # Give Next.js a moment to finish initialization
  sleep 3
}

check_logs() {
  stage "log check"
  local service
  for service in backend admin portal; do
    echo "Checking recent logs for ${service}"
    if [ -f "${LOG_DIR}/${service}.log" ]; then
      if grep -Eai "(exception|fatal|panic|failed|error)" "${LOG_DIR}/${service}.log" | tail -n "${LOG_TAIL}" >/tmp/homelab-${service}-deploy-errors.log; then
        if [ -s /tmp/homelab-${service}-deploy-errors.log ]; then
          cat /tmp/homelab-${service}-deploy-errors.log >&2
          die "Recent ${service} logs contain error patterns"
        fi
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
  curl_url "portal" "https://${DOMAIN}:8321/"
  curl_url "admin" "https://${DOMAIN}:8322/login"
  curl_url "admin backend rewrite" "https://${DOMAIN}:8322/api/backend/health"
  curl_url "backend" "https://${DOMAIN}:8323/health"
}

print_urls() {
  stage "deployment summary"
  echo "Deployment succeeded."
  echo "QA URLs:"
  echo "  portal:  https://${DOMAIN}:8321/"
  echo "  admin:   https://${DOMAIN}:8322/login"
  echo "  backend: https://${DOMAIN}:8323/health"
  echo "  rewrite: https://${DOMAIN}:8322/api/backend/health"
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

  stop_docker_homelab
  install_dependencies
  build_apps
  configure_nginx
  restart_services
  wait_for_services
  check_logs
  health_check
  write_success_result
  print_urls
}

main

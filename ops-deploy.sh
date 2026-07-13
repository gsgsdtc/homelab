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
SELF_TEST_LOG_CHECK=0

usage() {
  cat <<USAGE
Usage: ./deploy.sh [--check-only] [--skip-git] [--skip-nginx] [--self-test-log-check]

Requirements:
  bash, git, node, pnpm, curl, docker, systemctl

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
    --self-test-log-check)
      SELF_TEST_LOG_CHECK=1
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
  local db_url jwt_secret provider_key
  db_url="$(grep -E "^DATABASE_URL=" "${ENV_FILE}" | tail -n1 | cut -d= -f2- || true)"
  jwt_secret="$(grep -E "^JWT_SECRET=" "${ENV_FILE}" | tail -n1 | cut -d= -f2- || true)"
  provider_key="$(grep -E "^MODEL_PROVIDER_ENCRYPTION_KEY=" "${ENV_FILE}" | tail -n1 | cut -d= -f2- || true)"
  if [ -z "${db_url}" ] || [ -z "${jwt_secret}" ] || [ -z "${provider_key}" ]; then
    die "DATABASE_URL, JWT_SECRET, and MODEL_PROVIDER_ENCRYPTION_KEY must be set in ${ENV_FILE}"
  fi
  if [[ "${db_url}" == *change-me* ]] || [[ "${jwt_secret}" == *change-me* ]] || [[ "${provider_key}" == *change-me* ]]; then
    die "Replace placeholder DATABASE_URL, JWT_SECRET, and MODEL_PROVIDER_ENCRYPTION_KEY values in ${ENV_FILE}"
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
  truncate_service_logs
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

truncate_service_logs() {
  local service log_file

  echo "Truncating service logs before start."
  mkdir -p "${LOG_DIR}"
  for service in backend admin portal; do
    log_file="${LOG_DIR}/${service}.log"
    : > "${log_file}" || die "Cannot truncate service log: ${log_file}"
    echo "Log baseline for ${service}: 0 bytes"
  done
}

scan_log_for_error_patterns() {
  local service="$1"
  local log_file="$2"
  local error_file="$3"

  if [ ! -f "${log_file}" ]; then
    return 1
  fi

  echo "Checking ${service} logs written since current start"
  grep -Eai "(exception|fatal|panic|failed|error)" "${log_file}" | tail -n "${LOG_TAIL}" >"${error_file}" || true
  [ -s "${error_file}" ]
}

check_logs() {
  stage "log check"
  local service log_file error_file
  for service in backend admin portal; do
    log_file="${LOG_DIR}/${service}.log"
    error_file="/tmp/homelab-${service}-deploy-errors.log"
    rm -f "${error_file}"
    if scan_log_for_error_patterns "${service}" "${log_file}" "${error_file}"; then
      cat "${error_file}" >&2
      die "New ${service} logs since restart contain error patterns"
    fi
    rm -f "${error_file}"
  done
}

run_log_check_self_test() {
  stage "log check self-test"
  local tmp_dir log_file new_log stdout_file error_file old_size

  tmp_dir="$(mktemp -d)"
  log_file="${tmp_dir}/logs/backend.log"
  new_log="${tmp_dir}/logs/backend.new"
  stdout_file="${tmp_dir}/stdout.log"
  error_file="${tmp_dir}/errors.log"
  mkdir -p "${tmp_dir}/logs"

  LOG_DIR="${tmp_dir}/logs"
  RESULT_FILE=""

  old_size=128
  printf "%${old_size}s" "old clean baseline" > "${log_file}"
  truncate_service_logs >/dev/null

  {
    echo "error: replacement log must be detected"
    printf "%192s" "new file padding beyond old offset"
  } > "${new_log}"
  mv -f "${new_log}" "${log_file}"

  if ! scan_log_for_error_patterns "backend" "${log_file}" "${error_file}" >"${stdout_file}"; then
    cat "${stdout_file}" >&2 || true
    cat "${error_file}" >&2 || true
    rm -rf "${tmp_dir}"
    echo "Log check self-test failed: replacement log error was not detected." >&2
    exit 1
  fi

  if ! grep -q "replacement log must be detected" "${error_file}"; then
    cat "${stdout_file}" >&2 || true
    cat "${error_file}" >&2 || true
    rm -rf "${tmp_dir}"
    echo "Log check self-test failed: expected error line was not reported." >&2
    exit 1
  fi

  printf "%${old_size}s" "old clean baseline" > "${log_file}"
  truncate_service_logs >/dev/null
  : > "${log_file}"
  {
    echo "error: same inode truncate log must be detected"
    printf "%192s" "same inode padding beyond old offset"
  } >> "${log_file}"
  rm -f "${error_file}" "${stdout_file}"

  if ! scan_log_for_error_patterns "backend" "${log_file}" "${error_file}" >"${stdout_file}"; then
    cat "${stdout_file}" >&2 || true
    cat "${error_file}" >&2 || true
    rm -rf "${tmp_dir}"
    echo "Log check self-test failed: same-inode truncated log error was not detected." >&2
    exit 1
  fi

  if ! grep -q "same inode truncate log must be detected" "${error_file}"; then
    cat "${stdout_file}" >&2 || true
    cat "${error_file}" >&2 || true
    rm -rf "${tmp_dir}"
    echo "Log check self-test failed: expected same-inode error line was not reported." >&2
    exit 1
  fi

  rm -rf "${tmp_dir}"
  echo "Log check self-test passed."
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
  if [ "${SELF_TEST_LOG_CHECK}" -eq 1 ]; then
    run_log_check_self_test
    exit 0
  fi

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

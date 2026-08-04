#!/usr/bin/env bash
set -Eeuo pipefail

# Run the Docker exporter without copying vault data into the repository.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${EXPORT_REPO_ROOT:-$SCRIPT_DIR}"
IMAGE_NAME="${EXPORT_IMAGE:-archivatorium-web-export:local}"
CONTAINER_NAME="${EXPORT_CONTAINER_NAME:-archivatorium-web-export}"
EXPORT_MEMORY="${EXPORT_MEMORY:-12g}"
EXPORT_MEMORY_SWAP="${EXPORT_MEMORY_SWAP:-16g}"
EXPORT_RESTART_AFTER_RENDERED_MB="${EXPORT_RESTART_AFTER_RENDERED_MB:-0}"

VAULT_PATH="${1:-${EXPORT_VAULT:-}}"
CONFIG_PATH="${2:-${EXPORT_CONFIG:-}}"
CONFIG_WAS_EXPLICIT=0
if [[ -n "${2:-${EXPORT_CONFIG:-}}" ]]; then
  CONFIG_WAS_EXPLICIT=1
fi

if [[ -z "$VAULT_PATH" ]]; then
  echo "Pass the vault path as the first argument or set EXPORT_VAULT." >&2
  exit 2
fi

if [[ -z "$CONFIG_PATH" ]]; then
  CONFIG_PATH="$VAULT_PATH/.obsidian/plugins/archivatorium-web-export/data.json"
fi

if [[ ! -d "$REPO_ROOT" ]]; then
  echo "Export repository not found: $REPO_ROOT" >&2
  exit 1
fi

if [[ ! -d "$VAULT_PATH" ]]; then
  echo "Vault directory not found: $VAULT_PATH" >&2
  exit 1
fi
VAULT_PATH="$(realpath "$VAULT_PATH")"

if [[ ! -f "$CONFIG_PATH" && "$CONFIG_WAS_EXPLICIT" -eq 1 ]]; then
  echo "Configuration file not found: $CONFIG_PATH" >&2
  exit 1
fi
if [[ -f "$CONFIG_PATH" ]]; then
  CONFIG_PATH="$(realpath "$CONFIG_PATH")"
else
  CONFIG_PATH=""
fi

if ! [[ "$EXPORT_RESTART_AFTER_RENDERED_MB" =~ ^[0-9]+$ ]]; then
  echo "EXPORT_RESTART_AFTER_RENDERED_MB must be a non-negative integer." >&2
  exit 2
fi

PLUGIN_PATH="$VAULT_PATH/.obsidian/plugins/archivatorium-web-export"
PLUGIN_LINK_TARGET=""
PLUGIN_LINK_STAGED=0

restore_plugin_link() {
  local exit_code=$?
  if [[ "$PLUGIN_LINK_STAGED" -eq 1 ]]; then
    rm -rf "$PLUGIN_PATH"
    ln -s "$PLUGIN_LINK_TARGET" "$PLUGIN_PATH"
    echo "Restored plugin symlink: $PLUGIN_PATH -> $PLUGIN_LINK_TARGET"
  fi
  exit "$exit_code"
}

if [[ -L "$PLUGIN_PATH" ]]; then
  PLUGIN_LINK_TARGET="$(readlink "$PLUGIN_PATH")"
  PLUGIN_LINK_STAGED=1
  trap restore_plugin_link EXIT INT TERM
  rm "$PLUGIN_PATH"
  mkdir -p "$PLUGIN_PATH"
  echo "Temporarily replacing plugin symlink with a Docker-compatible directory"
fi

echo "Building Docker image $IMAGE_NAME from $REPO_ROOT"
docker build --tag "$IMAGE_NAME" "$REPO_ROOT"

docker_args=(
  docker run --rm
  --name "$CONTAINER_NAME"
  --memory "$EXPORT_MEMORY"
  --memory-swap "$EXPORT_MEMORY_SWAP"
  --env EXPORT_ENTIRE_VAULT=1
  --env "EXPORT_RESTART_AFTER_RENDERED_MB=$EXPORT_RESTART_AFTER_RENDERED_MB"
  --volume "$VAULT_PATH:/vault"
)
if [[ -n "$CONFIG_PATH" ]]; then
  docker_args+=(--volume "$CONFIG_PATH:/config.json:ro")
fi
docker_args+=("$IMAGE_NAME")

echo "Exporting vault: $VAULT_PATH"
echo "Server root:      $VAULT_PATH/.archivatorium"
echo "Container name:   $CONTAINER_NAME"
echo "Container memory: $EXPORT_MEMORY (memory+swap: $EXPORT_MEMORY_SWAP)"
if [[ "$EXPORT_RESTART_AFTER_RENDERED_MB" -gt 0 ]]; then
  echo "Planned restart interval: $EXPORT_RESTART_AFTER_RENDERED_MB MB of newly rendered Markdown"
fi
"${docker_args[@]}"

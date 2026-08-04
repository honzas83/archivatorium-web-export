#!/bin/bash

PLUGIN_DIR="/vault/.obsidian/plugins/archivatorium-web-export"
mkdir -p "$PLUGIN_DIR"

# Always run the plugin bundled into this image while preserving vault settings.
cp /plugin/main.js /plugin/manifest.json /plugin/styles.css "$PLUGIN_DIR/"

if [[ -f /config.json && ! /config.json -ef "$PLUGIN_DIR/data.json" ]]; then
  cp /config.json "$PLUGIN_DIR/data.json"
fi

RETRY_DELAY_SECONDS="${EXPORT_RENDERER_RETRY_DELAY_SECONDS:-20}"
if ! [[ "$RETRY_DELAY_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "EXPORT_RENDERER_RETRY_DELAY_SECONDS must be a non-negative integer, got: $RETRY_DELAY_SECONDS" >&2
  exit 2
fi

STARTUP_TIMEOUT_SECONDS="${EXPORT_STARTUP_TIMEOUT_SECONDS:-90}"
if ! [[ "$STARTUP_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "EXPORT_STARTUP_TIMEOUT_SECONDS must be a positive integer, got: $STARTUP_TIMEOUT_SECONDS" >&2
  exit 2
fi

RESTART_AFTER_RENDERED_MB="${EXPORT_RESTART_AFTER_RENDERED_MB:-0}"
if ! [[ "$RESTART_AFTER_RENDERED_MB" =~ ^[0-9]+$ ]]; then
  echo "EXPORT_RESTART_AFTER_RENDERED_MB must be a non-negative integer, got: $RESTART_AFTER_RENDERED_MB" >&2
  exit 2
fi
RESTART_AFTER_RENDERED_BYTES=$((RESTART_AFTER_RENDERED_MB * 1024 * 1024))

STATUS_FILE="/output/.docker-export-status.json"
attempt=0

cleanup_previous_attempt() {
  # A renderer crash can leave part of the Electron process tree behind. A
  # fresh attempt must not inherit its profile, X server, or debugging port.
  pkill -TERM -x electron-injector 2>/dev/null || true
  pkill -TERM -f '/opt/obsidian/obsidian' 2>/dev/null || true
  pkill -TERM -x Xvfb 2>/dev/null || true
  sleep 2
  pkill -KILL -x electron-injector 2>/dev/null || true
  pkill -KILL -f '/opt/obsidian/obsidian' 2>/dev/null || true
  pkill -KILL -x Xvfb 2>/dev/null || true
  fuser -k 8315/tcp 2>/dev/null || true
  rm -f /tmp/.X99-lock /tmp/.X100-lock

  # Obsidian downloads replacement ASARs into the profile. They are outside
  # the pinned image and have caused retries to switch application versions.
  rm -f /root/.config/obsidian/obsidian-*.asar
}

while true; do
  attempt=$((attempt + 1))
  echo "Preparing a clean, pinned Obsidian instance."
  cleanup_previous_attempt
  echo "Starting export attempt ${attempt}"
  printf '{"status":"starting","attempt":%d}\n' "$attempt" > "$STATUS_FILE"
  LOG_FILE="$(mktemp /tmp/archivatorium-export.XXXXXX.log)"
  FILE_LOG="/output/.export-files.log"
  : > "$FILE_LOG"
  tail -n 0 -F "$FILE_LOG" &
  FILE_LOG_TAIL_PID=$!

  set +e
  RUST_LOG=debug xvfb-run electron-injector \
    --delay=5000 \
    --script=/export-vault.mjs \
    /opt/obsidian/obsidian \
      --arg=--remote-allow-origins=* \
      --arg=--no-sandbox \
      --arg=--no-xshm \
      --arg=--disable-dev-shm-usage \
      --arg=--disable-gpu \
      --arg=--disable-software-rasterizer \
      --arg=--enable-logging=stderr > >(tee "$LOG_FILE") 2>&1 &
  INJECTOR_PID=$!
  STARTUP_DEADLINE=$((SECONDS + STARTUP_TIMEOUT_SECONDS))
  STARTUP_STALLED=false
  SCRIPT_STARTED=false
  LAST_PROGRESS_LOG=0
  FILE_LOG_LINES=0
  RENDERED_BYTES_SINCE_RESTART=0
  PLANNED_RESTART=false

  # The status and progress files bypass Electron console forwarding. They make
  # it clear whether the injected script is alive even when console.log output
  # from a newer Obsidian version is not visible to electron-injector.
  while kill -0 "$INJECTOR_PID" 2>/dev/null; do
	# Count only new render completions. Resume entries are logged as "Reused"
	# and must not retrigger a restart before new documents are rendered.
	if [[ "$RESTART_AFTER_RENDERED_BYTES" -gt 0 && -f "$FILE_LOG" ]]; then
		while IFS= read -r file_log_line; do
			FILE_LOG_LINES=$((FILE_LOG_LINES + 1))
			if [[ "$file_log_line" != *" Reused "* ]]; then
				file_log_details="${file_log_line#"[export-file] "}"
				source_path="${file_log_details#* }"
				if [[ "$source_path" != "$file_log_details" ]]; then
					source_size=$(stat -c '%s' "/vault/$source_path" 2>/dev/null || true)
					if [[ "$source_size" =~ ^[0-9]+$ ]]; then
						RENDERED_BYTES_SINCE_RESTART=$((RENDERED_BYTES_SINCE_RESTART + source_size))
					fi
				fi
			fi
		done < <(sed -n "$((FILE_LOG_LINES + 1)),\$p" "$FILE_LOG")
		if [[ "$RENDERED_BYTES_SINCE_RESTART" -ge "$RESTART_AFTER_RENDERED_BYTES" ]]; then
			PLANNED_RESTART=true
			printf '{"status":"planned-restart","attempt":%d,"renderedBytes":%d,"limitBytes":%d}\n' "$attempt" "$RENDERED_BYTES_SINCE_RESTART" "$RESTART_AFTER_RENDERED_BYTES" > "$STATUS_FILE"
			echo "Planned restart after ${RENDERED_BYTES_SINCE_RESTART} bytes of newly rendered Markdown (resume data is preserved)."
			kill -TERM "$INJECTOR_PID" 2>/dev/null || true
			cleanup_previous_attempt
			break
		fi
	fi
    if [[ "$SCRIPT_STARTED" == false ]] && grep -q '"status":"running"' "$STATUS_FILE" 2>/dev/null; then
      SCRIPT_STARTED=true
      echo "[docker-debug] Export script recorded running status."
    fi
    if [[ "$SCRIPT_STARTED" == false ]] && (( SECONDS >= STARTUP_DEADLINE )); then
      STARTUP_STALLED=true
      echo "Export script did not start within ${STARTUP_TIMEOUT_SECONDS}s; restarting Electron." >&2
      kill -TERM "$INJECTOR_PID" 2>/dev/null || true
      cleanup_previous_attempt
      break
    fi
    if [[ "$SCRIPT_STARTED" == true ]] && [[ ! -s "$FILE_LOG" ]] && (( SECONDS - LAST_PROGRESS_LOG >= 15 )); then
      if [[ -f /output/.export-progress.json ]]; then
        PROGRESS_SUMMARY=$(sed -n 's/.*"stage":"\([^"]*\)".*"completed":\([0-9]*\).*"total":\([0-9]*\).*/\1 \2 \3/p' /output/.export-progress.json)
        echo "[docker-progress] ${PROGRESS_SUMMARY:-progress file is being updated}"
      else
        echo "[docker-progress] script is running; waiting for export progress files."
      fi
      LAST_PROGRESS_LOG=$SECONDS
    fi
    sleep 1
  done

  wait "$INJECTOR_PID"
  INJECTOR_STATUS=$?
  kill "$FILE_LOG_TAIL_PID" 2>/dev/null || true
  wait "$FILE_LOG_TAIL_PID" 2>/dev/null || true
  set -e

  if grep -q '"status":"completed"' "$STATUS_FILE"; then
    rm -f "$LOG_FILE"
    echo "Export completed successfully."
    exit 0
  fi

  if [[ "$PLANNED_RESTART" == true ]]; then
    rm -f "$LOG_FILE"
    echo "Restarting planned export segment in ${RETRY_DELAY_SECONDS} seconds."
    sleep "$RETRY_DELAY_SECONDS"
    continue
  fi

  if [[ "$STARTUP_STALLED" == true ]] || grep -q 'Renderer process killed' "$LOG_FILE"; then
    if [[ "$STARTUP_STALLED" == true ]]; then
      echo "Electron stalled before export startup; restarting export in ${RETRY_DELAY_SECONDS} seconds (resume data is preserved)." >&2
    else
      echo "Renderer process crashed; restarting the complete Obsidian process in ${RETRY_DELAY_SECONDS} seconds (resume data is preserved)." >&2
    fi
    rm -f "$LOG_FILE"
    sleep "$RETRY_DELAY_SECONDS"
    continue
  fi

  echo "Export did not complete on attempt ${attempt}." >&2
  if [[ -f "$STATUS_FILE" ]]; then
    echo "Last export status: $(cat "$STATUS_FILE")" >&2
  fi
  rm -f "$LOG_FILE"
  if [[ "$INJECTOR_STATUS" -eq 0 ]]; then
    exit 1
  fi
  exit "$INJECTOR_STATUS"
done

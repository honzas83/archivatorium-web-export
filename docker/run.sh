#!/bin/bash

PLUGIN_DIR="/vault/.obsidian/plugins/archivatorium-web-export"
mkdir -p "$PLUGIN_DIR"

# Always run the plugin bundled into this image while preserving vault settings.
cp /plugin/main.js /plugin/manifest.json /plugin/styles.css "$PLUGIN_DIR/"

if [[ -f /config.json ]]; then
  cp /config.json "$PLUGIN_DIR/data.json"
fi

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
    --arg=--enable-logging=stderr || true

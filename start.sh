#!/usr/bin/env bash

set -e

echo "========================================================"
echo "       🎵 MusicDownloader - Docker App Avvio"
echo "========================================================"
echo ""

# Controlla se Docker è attivo
if ! docker info >/dev/null 2>&1; then
    echo "[!] Docker non è attivo. Avvia il servizio Docker prima di continuare."
    exit 1
fi

echo "[✓] Docker è operativo."
echo "[*] Avvio container in corso..."
echo ""

docker compose up --build -d

echo ""
echo "========================================================"
echo " [✓] Applicazione avviata con successo!"
echo " [🌐] Interfaccia Web: http://localhost:8765"
echo " [📁] Cartella download: ./downloads"
echo "========================================================"
echo ""

# Prova ad aprire il browser
if command -v xdg-open > /dev/null; then
    xdg-open http://localhost:8765 >/dev/null 2>&1 &
elif command -v open > /dev/null; then
    open http://localhost:8765 >/dev/null 2>&1 &
fi

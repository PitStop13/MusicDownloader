"""
Script per eseguire MusicDownloader localmente con Python senza Docker.
Utile per test immediati o sviluppo rapido.
"""
import sys
import uvicorn

if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    print("=" * 60)
    print("[MusicDownloader] Avvio Locale")
    print("Interfaccia: http://localhost:8765")
    print("=" * 60)
    uvicorn.run("app.main:app", host="0.0.0.0", port=8765, reload=False)

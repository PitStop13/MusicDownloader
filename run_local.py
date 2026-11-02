"""
Script per eseguire MusicDownloader localmente con Python senza Docker.
Utile per test immediati o sviluppo rapido.
"""
import uvicorn

if __name__ == "__main__":
    print("=" * 60)
    print("🎵 MusicDownloader - Avvio Locale")
    print("🌐 Interfaccia: http://localhost:8000")
    print("=" * 60)
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)

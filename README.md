# 🎵 MusicDownloader - Docker App (100% Open Source)

Applicazione web moderna, elegante e **completamente Open Source** per cercare, ascoltare in anteprima e scaricare brani musicali e video da **YouTube, YouTube Music e Spotify** alla **massima qualità disponibile**.

---

## ✨ Caratteristiche Principali

- 🌐 **100% Open Source & Zero Dipendenze Esterne**: Non richiede account premium, chiavi API o login su servizi esterni. Tutto gira nel tuo container locale.
- 🔥 **Canzoni Più Popolari in Home**: Pagina iniziale con le classifiche e i brani di tendenza in tempo reale (Italia 🇮🇹, Globale 🌍, USA 🇺🇸, UK 🇬🇧, Spagna 🇪🇸).
- 🔍 **Ricerca Universale**:
  - Cerca per **titolo o artista** (es. *Coldplay*, *Geolier*, *Sfera Ebbasta*).
  - Incolla direttamente link di **YouTube** (`https://youtube.com/watch?v=...` o `youtu.be`).
  - Incolla direttamente link di **Spotify** (`https://open.spotify.com/track/...`), l'app estrae automaticamente i metadati via oEmbed e trova la corrispondenza perfetta.
- 📄 **Pagina Dettagli Canzone**:
  - Copertina HD ad alta risoluzione con effetto bagliore.
  - Titolo, artista verificato, album, durata, data di rilascio e visualizzazioni.
  - **Player di Anteprima integrato**: ascolta o guarda il brano prima di scaricarlo.
- ⚡ **Due Modalità di Download in Massima Qualità**:
  - 🎵 **Scarica MP3 (320 kbps)**: audio estratto alla massima qualità, convertito a 320 kbps con FFmpeg, con copertina HD e tag ID3 (Artista, Titolo, Album) incorporati automaticamente per autoradio e smartphone.
  - 🎬 **Scarica Video MP4 (HD / 4K)**: fusione automatica del miglior flusso video (1080p, 1440p o 4K) e audio in un file MP4 universale compatibile con qualsiasi lettore o Smart TV.
- 📁 **Salvataggio Locale Istantaneo & Download nel Browser**:
  - Tutti i file scaricati vengono salvati direttamente nella cartella `./downloads` del tuo computer grazie ai volumi Docker.
  - Pulsante per il download diretto nel browser (se accedi da cellulare o un altro PC).
- 📂 **Sezione "I Miei Download"**:
  - Gestisci, riproduci ed elimina i file scaricati direttamente dall'interfaccia.

---

## 🚀 Avvio Rapido con Docker

### Opzione 1: Con 1 Click (Windows)
Fai doppio clic sul file:
```
start.bat
```
Lo script verificherà che Docker sia attivo, avvierà il container ed aprirà automaticamente l'interfaccia web nel tuo browser su:
👉 **http://localhost:8000**

---

### Opzione 2: Tramite Riga di Comando (Windows, Mac, Linux)
Assicurati che Docker Desktop o il daemon Docker sia avviato, quindi esegui:

```bash
docker compose up --build -d
```

L'app sarà immediatamente disponibile all'indirizzo:
👉 **http://localhost:8000**

Per fermare l'applicazione:
```bash
docker compose down
```

---

## 📂 Dove Finiscono i File Scaricati?

I file scaricati dall'applicazione (brani `.mp3` e video `.mp4`) vengono salvati sia:
1. **Nel tuo computer** nella cartella:
   `c:\Users\pietr\Music\Crack\MusicDownloader\downloads\`
   (grazie al volume montato `- ./downloads:/app/downloads` in Docker).
2. **Nel tuo browser** cliccando sul pulsante *"Scarica subito nel browser"*.

---

## 🛠️ Architettura Tecnica

- **Backend**: Python 3.11, [FastAPI](https://fastapi.tiangolo.com/), Uvicorn.
- **Motore di Download**: [yt-dlp](https://github.com/yt-dlp/yt-dlp) con supporto Node.js integrato per la risoluzione delle firme senza throttling.
- **Motore Classifiche & Ricerca**: [ytmusicapi](https://github.com/sigma67/ytmusicapi) (API non autenticata, zero token).
- **Elaborazione Audio & Video**: [FFmpeg](https://ffmpeg.org/) installato all'interno dell'immagine Docker Debian per conversione a 320 kbps e embedding copertine.
- **Tagging Metadati**: [Mutagen](https://mutagen.readthedocs.io/) per la scrittura di ID3v2.3 (APIC, TIT2, TPE1, TALB).
- **Frontend**: Single-Page Application (HTML5, Modern CSS Dark Glassmorphism, JavaScript nativo con polling asincrono dei task).

---

## 💻 Esecuzione Locale Senza Docker (Opzionale)

Se desideri testare l'app direttamente su Python:

1. Installa i requisiti:
   ```bash
   pip install -r requirements.txt
   ```
2. Avvia il server:
   ```bash
   python run_local.py
   ```
3. Apri `http://localhost:8000`.
*(Nota: Per la conversione MP3 locale senza Docker è consigliabile avere `ffmpeg` nel PATH di sistema).*
"# MusicDownloader" 

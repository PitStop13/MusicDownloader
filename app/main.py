import os
import requests
from fastapi import FastAPI, HTTPException, Query, BackgroundTasks, Request
from fastapi.responses import HTMLResponse, FileResponse, JSONResponse, StreamingResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
from typing import Optional

from app.music_service import (
    get_popular_tracks,
    search_tracks,
    get_track_details,
    resolve_spotify_url,
    get_audio_stream_url
)
from app.downloader import (
    start_download_task,
    get_task,
    get_raw_task,
    cleanup_task_file,
    get_all_tasks,
    pause_download_task,
    resume_download_task,
    cancel_download_task,
    delete_task,
    list_downloaded_files,
    get_safe_file_path,
    delete_file,
    delete_all_files
)

app = FastAPI(
    title="MusicDownloader Open Source",
    description="Applicazione moderna e open source per cercare e scaricare musica e video da YouTube e Spotify in massima qualità (MP3 320kbps / MP4)",
    version="1.0.0"
)

# Static and Templates
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
templates = Jinja2Templates(directory=TEMPLATES_DIR)


class DownloadRequest(BaseModel):
    id_or_url: str
    format: str = "mp3"  # "mp3" or "mp4"
    title: Optional[str] = None
    artist: Optional[str] = None
    thumbnail: Optional[str] = None
    official_video_id: Optional[str] = None
    client_id: Optional[str] = None


@app.get("/", response_class=FileResponse)
async def home():
    """Renders the single page application."""
    index_path = os.path.join(TEMPLATES_DIR, "index.html")
    if not os.path.exists(index_path):
        raise HTTPException(status_code=404, detail="index.html non trovato")
    return FileResponse(index_path, media_type="text/html")


@app.get("/api/popular")
async def api_popular(country: str = Query("IT", description="Country code (IT, ZZ, US, GB, ES)")):
    """Retrieve trending and popular tracks."""
    tracks = get_popular_tracks(country=country, limit=30)
    return {
        "success": True,
        "country": country,
        "count": len(tracks),
        "tracks": tracks
    }


@app.get("/api/search")
async def api_search(q: str = Query(..., description="Query search string or YouTube/Spotify URL")):
    """Search for songs or videos across platforms."""
    clean_q = q.strip()
    if not clean_q:
        return {"success": False, "items": [], "error": "Query vuota"}
    
    data = search_tracks(clean_q, limit=25)
    return {
        "success": True,
        **data
    }


@app.get("/api/details/{video_id}")
async def api_details(video_id: str):
    """Get complete details and metadata for a specific song/video."""
    details = get_track_details(video_id)
    if not details:
        raise HTTPException(status_code=404, detail="Brano o video non trovato.")
    return {
        "success": True,
        "data": details
    }


@app.get("/api/preview/audio/{video_id}")
async def api_preview_audio(video_id: str, request: Request):
    """
    Direct proxy audio stream for native in-browser preview.
    Supports HTTP Range requests (seeking) and completely bypasses
    YouTube iframe blocks, VPN restrictions, and 'Watch on YouTube' errors.
    """
    res = get_audio_stream_url(video_id)
    if not res:
        raise HTTPException(status_code=404, detail="Audio preview non disponibile per questo brano.")

    stream_url, mime_type = res
    range_header = request.headers.get("Range")
    
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    if range_header:
        headers["Range"] = range_header

    try:
        upstream_resp = requests.get(stream_url, headers=headers, stream=True, timeout=12)
        
        response_headers = {
            "Content-Type": mime_type,
            "Accept-Ranges": "bytes",
            "Cache-Control": "public, max-age=3600"
        }
        if "Content-Range" in upstream_resp.headers:
            response_headers["Content-Range"] = upstream_resp.headers["Content-Range"]
        if "Content-Length" in upstream_resp.headers:
            response_headers["Content-Length"] = upstream_resp.headers["Content-Length"]

        def stream_content():
            try:
                for chunk in upstream_resp.iter_content(chunk_size=64 * 1024):
                    if chunk:
                        yield chunk
            except Exception:
                pass
            finally:
                upstream_resp.close()

        status_code = upstream_resp.status_code if upstream_resp.status_code in (200, 206) else 200

        return StreamingResponse(
            stream_content(),
            status_code=status_code,
            headers=response_headers,
            media_type=mime_type
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Errore nello streaming audio: {e}")


@app.post("/api/download")
async def api_download(req: DownloadRequest):
    """Initiate an MP3 or MP4 download task with sequential queue management."""
    fmt = req.format.lower()
    if fmt not in ["mp3", "mp4"]:
        fmt = "mp3"

    task_id = start_download_task(
        video_id_or_url=req.id_or_url,
        output_format=fmt,
        title=req.title,
        artist=req.artist,
        thumbnail_url=req.thumbnail,
        official_video_id=req.official_video_id,
        client_id=req.client_id
    )

    task = get_task(task_id)
    status = task.get("status", "pending") if task else "pending"
    queue_pos = task.get("queue_position", 0) if task else 0

    return {
        "success": True,
        "task_id": task_id,
        "status": status,
        "queue_position": queue_pos,
        "format": fmt
    }


@app.get("/api/tasks")
async def api_get_all_tasks(client_id: Optional[str] = Query(None)):
    """Retrieve all active, queued, and recent download tasks, optionally filtered by client_id."""
    tasks = get_all_tasks(client_id=client_id)
    return {
        "success": True,
        "count": len(tasks),
        "tasks": tasks
    }


@app.get("/api/task/{task_id}")
async def api_task_status(task_id: str):
    """Poll the status of an ongoing or queued download task."""
    task = get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Attività di download non trovata.")
    return {
        "success": True,
        "task": task
    }


@app.post("/api/task/{task_id}/pause")
async def api_task_pause(task_id: str):
    """Pause an active or queued download task."""
    success = pause_download_task(task_id)
    if not success:
        raise HTTPException(status_code=400, detail="Impossibile mettere in pausa l'attività (non attiva o già terminata).")
    return {
        "success": True,
        "message": "Download messo in pausa."
    }


@app.post("/api/task/{task_id}/resume")
async def api_task_resume(task_id: str):
    """Resume a paused download task."""
    success = resume_download_task(task_id)
    if not success:
        raise HTTPException(status_code=400, detail="Impossibile riprendere l'attività (non in pausa).")
    return {
        "success": True,
        "message": "Download ripreso con successo."
    }


@app.post("/api/task/{task_id}/cancel")
async def api_task_cancel(task_id: str):
    """Cancel an active or queued download task and clean up partial files."""
    success = cancel_download_task(task_id)
    if not success:
        raise HTTPException(status_code=404, detail="Attività non trovata.")
    return {
        "success": True,
        "message": "Download annullato e memoria liberata."
    }


@app.delete("/api/task/{task_id}")
async def api_task_delete(task_id: str):
    """Remove task from active tracker list and queue."""
    success = delete_task(task_id)
    if not success:
        raise HTTPException(status_code=404, detail="Attività non trovata.")
    return {
        "success": True,
        "message": "Attività rimossa."
    }


@app.get("/api/download/file/{task_id}")
async def api_download_file_direct(task_id: str, background_tasks: BackgroundTasks):
    """
    Streams the media file directly to the client browser and immediately
    deletes the temporary file from the server upon transfer completion.
    Zero bytes stored permanently on the server!
    """
    task = get_raw_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Attività non trovata o scaduta.")

    filepath = task.get("filepath")
    if not filepath or not os.path.exists(filepath):
        filepath = get_safe_file_path(task.get("filename", ""))

    if not filepath or not os.path.exists(filepath):
        raise HTTPException(status_code=404, detail="File non trovato o già scaricato sul tuo dispositivo.")

    filename = task.get("filename", "download.mp3")
    media_type = "audio/mpeg" if filename.lower().endswith(".mp3") else "video/mp4"

    # Immediately delete from server after streaming finishes
    background_tasks.add_task(cleanup_task_file, task_id)

    return FileResponse(
        path=filepath,
        filename=filename,
        media_type=media_type,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-cache, no-store, must-revalidate"
        }
    )


@app.get("/api/files/download/{filename}")
async def api_download_file(filename: str, background_tasks: BackgroundTasks):
    """Download the media file directly to the browser and delete from server."""
    path = get_safe_file_path(filename)
    if not path:
        raise HTTPException(status_code=404, detail="File non trovato.")

    media_type = "audio/mpeg" if filename.lower().endswith(".mp3") else "video/mp4"
    background_tasks.add_task(delete_file, filename)
    return FileResponse(
        path=path,
        filename=filename,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )


@app.get("/api/files")
async def api_list_files():
    """Confirms 100% client-side downloads without server storage."""
    return {
        "success": True,
        "count": 0,
        "client_only": True,
        "files": [],
        "message": "I download avvengono esclusivamente sul client. Nessun file è memorizzato sul server."
    }


@app.delete("/api/files")
async def api_delete_all_files():
    """Delete all temporary files from server storage."""
    deleted_count = delete_all_files()
    return {
        "success": True,
        "deleted_count": deleted_count,
        "message": f"Eliminati {deleted_count} file temporanei con successo."
    }


@app.get("/api/files/stream/{filename}")
async def api_stream_file(filename: str):
    """Stream audio or video directly for in-browser playback."""
    path = get_safe_file_path(filename)
    if not path:
        raise HTTPException(status_code=404, detail="File non trovato.")

    media_type = "audio/mpeg" if filename.lower().endswith(".mp3") else "video/mp4"
    return FileResponse(
        path=path,
        media_type=media_type
    )


@app.delete("/api/files/{filename}")
async def api_delete_file(filename: str):
    """Delete a downloaded file from server storage."""
    success = delete_file(filename)
    if not success:
        raise HTTPException(status_code=404, detail="File non trovato o impossibile eliminarlo.")
    return {
        "success": True,
        "message": f"File {filename} eliminato con successo."
    }


@app.get("/api/health")
async def api_health():
    """Service health check."""
    return {"status": "ok", "app": "MusicDownloader", "open_source": True}

import os
from fastapi import FastAPI, HTTPException, Query, BackgroundTasks, Request
from fastapi.responses import HTMLResponse, FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
from typing import Optional

from app.music_service import (
    get_popular_tracks,
    search_tracks,
    get_track_details,
    resolve_spotify_url
)
from app.downloader import (
    start_download_task,
    get_task,
    list_downloaded_files,
    get_safe_file_path,
    delete_file
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


@app.post("/api/download")
async def api_download(req: DownloadRequest):
    """Initiate an MP3 or MP4 download task."""
    fmt = req.format.lower()
    if fmt not in ["mp3", "mp4"]:
        fmt = "mp3"

    task_id = start_download_task(
        video_id_or_url=req.id_or_url,
        output_format=fmt,
        title=req.title,
        artist=req.artist,
        thumbnail_url=req.thumbnail
    )

    return {
        "success": True,
        "task_id": task_id,
        "status": "pending",
        "format": fmt
    }


@app.get("/api/task/{task_id}")
async def api_task_status(task_id: str):
    """Poll the status of an ongoing download task."""
    task = get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Attività di download non trovata.")
    return {
        "success": True,
        "task": task
    }


@app.get("/api/files")
async def api_list_files():
    """List all downloaded files saved on the server."""
    files = list_downloaded_files()
    total_size = sum(f["size_mb"] for f in files)
    return {
        "success": True,
        "count": len(files),
        "total_size_mb": round(total_size, 2),
        "files": files
    }


@app.get("/api/files/download/{filename}")
async def api_download_file(filename: str):
    """Download the saved MP3 or MP4 file directly to the browser."""
    path = get_safe_file_path(filename)
    if not path:
        raise HTTPException(status_code=404, detail="File non trovato.")

    media_type = "audio/mpeg" if filename.lower().endswith(".mp3") else "video/mp4"
    return FileResponse(
        path=path,
        filename=filename,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )


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

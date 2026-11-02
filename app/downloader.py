import os
import re
import uuid
import time
import shutil
import threading
import requests
import yt_dlp
from typing import Dict, Any, Optional, List
from mutagen.easyid3 import EasyID3
from mutagen.mp3 import MP3
from mutagen.id3 import ID3, APIC, TIT2, TPE1, TALB

# Directory configuration: configurable via env var
DOWNLOADS_DIR = os.getenv("DOWNLOADS_DIR", os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "downloads")))
os.makedirs(DOWNLOADS_DIR, exist_ok=True)

# In-memory dictionary for download tasks
_TASKS: Dict[str, Dict[str, Any]] = {}
_LOCK = threading.Lock()


def get_task(task_id: str) -> Optional[Dict[str, Any]]:
    with _LOCK:
        return _TASKS.get(task_id)


def _update_task(task_id: str, **kwargs):
    with _LOCK:
        if task_id in _TASKS:
            _TASKS[task_id].update(kwargs)


def _sanitize_filename(name: str) -> str:
    """Remove unsafe characters for Windows and Linux filesystems."""
    clean = re.sub(r'[\\/*?:"<>|]', "", name)
    clean = re.sub(r'\s+', " ", clean).strip()
    return clean[:120] if clean else "download"


def _embed_metadata_and_art(mp3_path: str, title: str, artist: str, album: Optional[str] = None, thumbnail_url: Optional[str] = None):
    """
    Ensure ID3 metadata (Title, Artist, Album) and Cover Art (APIC)
    are embedded directly into the MP3 file using mutagen.
    """
    try:
        # Load or create ID3 tags
        try:
            audio = EasyID3(mp3_path)
        except Exception:
            audio = MP3(mp3_path)
            audio.add_tags()
            audio = EasyID3(mp3_path)

        if title:
            audio["title"] = [title]
        if artist:
            audio["artist"] = [artist]
        if album:
            audio["album"] = [album]
        audio.save()

        # Embed cover art image if available
        if thumbnail_url:
            try:
                resp = requests.get(thumbnail_url, timeout=10)
                if resp.status_code == 200:
                    image_data = resp.content
                    mime_type = "image/jpeg"
                    if thumbnail_url.lower().endswith(".png"):
                        mime_type = "image/png"

                    id3_audio = ID3(mp3_path)
                    id3_audio.delall("APIC")
                    id3_audio.add(
                        APIC(
                            encoding=3,  # UTF-8
                            mime=mime_type,
                            type=3,  # 3 is for the front cover
                            desc="Cover",
                            data=image_data
                        )
                    )
                    id3_audio.save(v2_version=3)
            except Exception as e:
                print(f"[Warning] Failed to embed cover image into {mp3_path}: {e}")
    except Exception as e:
        print(f"[Warning] Failed to write ID3 tags to {mp3_path}: {e}")


def _progress_hook(task_id: str):
    def hook(d):
        status = d.get('status')
        if status == 'downloading':
            # Extract clean percent
            percent_str = d.get('_percent_str', '0%')
            clean_percent = re.sub(r'[^\d.]', '', percent_str)
            try:
                percent = float(clean_percent)
            except ValueError:
                percent = 0.0

            speed = d.get('_speed_str', '')
            eta = d.get('_eta_str', '')
            
            _update_task(
                task_id,
                status="downloading",
                progress=round(percent, 1),
                speed=speed.strip() if speed else "",
                eta=eta.strip() if eta else ""
            )
        elif status == 'finished':
            _update_task(
                task_id,
                status="converting",
                progress=95.0,
                speed="",
                eta=""
            )
    return hook


def _run_download_thread(task_id: str, video_id_or_url: str, output_format: str, custom_title: Optional[str] = None, custom_artist: Optional[str] = None, thumbnail_url: Optional[str] = None):
    """Background worker for yt-dlp execution."""
    url = video_id_or_url if video_id_or_url.startswith("http") else f"https://www.youtube.com/watch?v={video_id_or_url}"

    try:
        # Template for output file
        out_template = os.path.join(DOWNLOADS_DIR, "%(title)s.%(ext)s")

        hook = _progress_hook(task_id)

        if output_format == "mp3":
            # MP3 audio at maximum 320 kbps with metadata
            ydl_opts = {
                'format': 'bestaudio/best',
                'outtmpl': out_template,
                'postprocessors': [
                    {
                        'key': 'FFmpegExtractAudio',
                        'preferredcodec': 'mp3',
                        'preferredquality': '320',
                    },
                    {
                        'key': 'FFmpegMetadata',
                        'add_metadata': True,
                    },
                ],
                'progress_hooks': [hook],
                'quiet': True,
                'no_warnings': True,
                'noplaylist': True,
            }
        else:
            # MP4 video at highest available resolution merged with best audio
            ydl_opts = {
                'format': 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best[ext=mp4]/best',
                'merge_output_format': 'mp4',
                'outtmpl': out_template,
                'postprocessors': [
                    {
                        'key': 'FFmpegMetadata',
                        'add_metadata': True,
                    }
                ],
                'progress_hooks': [hook],
                'quiet': True,
                'no_warnings': True,
                'noplaylist': True,
            }

        _update_task(task_id, status="starting", progress=5.0)

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            if not info:
                raise Exception("Impossibile estrarre le informazioni sul file multimediale.")

            # Identify resulting filename
            actual_title = info.get('title', 'Audio')
            clean_title = _sanitize_filename(actual_title)
            
            ext = "mp3" if output_format == "mp3" else "mp4"
            final_filename = f"{clean_title}.{ext}"
            final_path = os.path.join(DOWNLOADS_DIR, final_filename)

            # Check if file exists under original title template
            if not os.path.exists(final_path):
                # Look for file with expected extension in DOWNLOADS_DIR matching part of title
                for f in os.listdir(DOWNLOADS_DIR):
                    if f.endswith(f".{ext}"):
                        candidate = os.path.join(DOWNLOADS_DIR, f)
                        if abs(os.path.getmtime(candidate) - time.time()) < 60:
                            final_path = candidate
                            final_filename = f
                            break

            # If audio, finalize ID3 tags and embed cover
            if output_format == "mp3" and os.path.exists(final_path):
                _update_task(task_id, status="tagging", progress=98.0)
                art_url = thumbnail_url or info.get('thumbnail')
                song_artist = custom_artist or info.get('artist') or info.get('uploader') or ""
                song_title = custom_title or info.get('title') or ""
                album_name = info.get('album')
                _embed_metadata_and_art(final_path, song_title, song_artist, album_name, art_url)

            # Get final file size
            file_size = os.path.getsize(final_path) if os.path.exists(final_path) else 0

            _update_task(
                task_id,
                status="finished",
                progress=100.0,
                filename=final_filename,
                filepath=final_path,
                file_size=file_size,
                completed_at=time.time()
            )

    except Exception as e:
        print(f"[Download Error on task {task_id}] {e}")
        _update_task(
            task_id,
            status="error",
            error=str(e),
            progress=0.0
        )


def start_download_task(
    video_id_or_url: str,
    output_format: str = "mp3",
    title: Optional[str] = None,
    artist: Optional[str] = None,
    thumbnail_url: Optional[str] = None
) -> str:
    """
    Initiate an asynchronous download task.
    Returns the unique task_id.
    """
    task_id = str(uuid.uuid4())
    fmt = "mp3" if output_format.lower() == "mp3" else "mp4"

    with _LOCK:
        _TASKS[task_id] = {
            "task_id": task_id,
            "url_or_id": video_id_or_url,
            "format": fmt,
            "title": title or "Download",
            "artist": artist or "",
            "thumbnail_url": thumbnail_url,
            "status": "pending",
            "progress": 0.0,
            "speed": "",
            "eta": "",
            "filename": None,
            "filepath": None,
            "file_size": 0,
            "error": None,
            "created_at": time.time()
        }

    thread = threading.Thread(
        target=_run_download_thread,
        args=(task_id, video_id_or_url, fmt, title, artist, thumbnail_url),
        daemon=True
    )
    thread.start()

    return task_id


def list_downloaded_files() -> List[Dict[str, Any]]:
    """List all completed audio and video files in the downloads directory."""
    files: List[Dict[str, Any]] = []
    if not os.path.exists(DOWNLOADS_DIR):
        return files

    for entry in os.scandir(DOWNLOADS_DIR):
        if entry.is_file() and entry.name.lower().endswith(('.mp3', '.mp4', '.m4a')):
            stats = entry.stat()
            ext = entry.name.split('.')[-1].lower()
            size_mb = stats.st_size / (1024 * 1024)
            
            created_str = time.strftime('%d/%m/%Y %H:%M', time.localtime(stats.st_mtime))
            files.append({
                "filename": entry.name,
                "format": ext,
                "size_mb": round(size_mb, 2),
                "size_bytes": stats.st_size,
                "created_at": created_str,
                "timestamp": stats.st_mtime
            })

    # Sort newest first
    files.sort(key=lambda x: x["timestamp"], reverse=True)
    return files


def get_safe_file_path(filename: str) -> Optional[str]:
    """Prevent directory traversal and return absolute file path if exists."""
    safe_name = os.path.basename(filename)
    full_path = os.path.join(DOWNLOADS_DIR, safe_name)
    if os.path.exists(full_path) and os.path.isfile(full_path):
        return full_path
    return None


def delete_file(filename: str) -> bool:
    """Delete a downloaded file."""
    path = get_safe_file_path(filename)
    if path and os.path.exists(path):
        os.remove(path)
        return True
    return False

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

# Custom Exceptions for clean task control
class DownloadPausedException(Exception):
    """Raised inside yt-dlp hook when user requests download pause."""
    pass

class DownloadCancelledException(Exception):
    """Raised inside yt-dlp hook when user requests download cancellation."""
    pass

# In-memory dictionary for download tasks
_TASKS: Dict[str, Dict[str, Any]] = {}
_LOCK = threading.Lock()


def serialize_task(task: Dict[str, Any]) -> Dict[str, Any]:
    """Return a JSON-serializable dictionary omitting threading objects."""
    return {
        k: v for k, v in task.items()
        if k not in ("pause_event", "cancel_event", "thread")
    }


def get_task(task_id: str) -> Optional[Dict[str, Any]]:
    with _LOCK:
        task = _TASKS.get(task_id)
        return serialize_task(task) if task else None


def get_all_tasks() -> List[Dict[str, Any]]:
    with _LOCK:
        tasks = [serialize_task(t) for t in _TASKS.values()]
        tasks.sort(key=lambda x: x.get("created_at", 0), reverse=True)
        return tasks


def _update_task(task_id: str, **kwargs):
    with _LOCK:
        if task_id in _TASKS:
            task = _TASKS[task_id]
            # Prevent overwriting paused or cancelled status if an operation is stopping
            if task.get("status") in ("paused", "cancelled") and kwargs.get("status") in ("starting", "downloading", "converting", "tagging"):
                kwargs.pop("status", None)
            task.update(kwargs)


def _sanitize_filename(name: str) -> str:
    """Remove unsafe characters for Windows and Linux filesystems."""
    clean = re.sub(r'[\\/*?:"<>|]', "", name)
    clean = re.sub(r'\s+', " ", clean).strip()
    return clean[:120] if clean else "download"


def _cleanup_partial_files(task: Dict[str, Any]):
    """Clean up .part, .ytdl, or temporary files associated with task."""
    try:
        clean_title = _sanitize_filename(task.get("title", ""))
        now = time.time()
        for f in os.listdir(DOWNLOADS_DIR):
            if f.endswith(('.part', '.ytdl', '.temp')):
                full_p = os.path.join(DOWNLOADS_DIR, f)
                # If name matches or modified in last 2 hours
                if not clean_title or clean_title.lower() in f.lower() or abs(os.path.getmtime(full_p) - now) < 7200:
                    try:
                        os.remove(full_p)
                    except Exception:
                        pass
    except Exception as e:
        print(f"[Warning] Failed to cleanup partial files: {e}")


def _embed_metadata_and_art(mp3_path: str, title: str, artist: str, album: Optional[str] = None, thumbnail_url: Optional[str] = None):
    """
    Ensure ID3 metadata (Title, Artist, Album) and Cover Art (APIC)
    are embedded directly into the MP3 file using mutagen.
    """
    try:
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
        with _LOCK:
            task = _TASKS.get(task_id)

        if not task:
            return

        # Check user cancellation first
        if task.get("cancel_event") and task["cancel_event"].is_set():
            raise DownloadCancelledException("Download annullato dall'utente.")

        # Check user pause
        if task.get("pause_event") and task["pause_event"].is_set():
            raise DownloadPausedException("Download messo in pausa dall'utente.")

        status = d.get('status')
        if status == 'downloading':
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


def _run_download_thread(
    task_id: str,
    video_id_or_url: str,
    output_format: str,
    custom_title: Optional[str] = None,
    custom_artist: Optional[str] = None,
    thumbnail_url: Optional[str] = None,
    official_video_id: Optional[str] = None,
    is_resume: bool = False
):
    """Background worker for yt-dlp execution with pause/resume and video resolution."""
    from app.music_service import find_official_music_video, is_art_track_info

    target_id_or_url = video_id_or_url

    # When downloading video (MP4), verify if we should fetch the official music video
    if output_format == "mp4":
        if official_video_id:
            target_id_or_url = official_video_id
            _update_task(task_id, is_official_clip=True)
        else:
            # Check if current track is an Art Track
            try:
                ydl_check_opts = {'quiet': True, 'skip_download': True}
                check_url = target_id_or_url if target_id_or_url.startswith("http") else f"https://www.youtube.com/watch?v={target_id_or_url}"
                with yt_dlp.YoutubeDL(ydl_check_opts) as ydl_check:
                    c_info = ydl_check.extract_info(check_url, download=False)
                    if c_info and is_art_track_info(c_info):
                        c_title = custom_title or c_info.get('title', '')
                        c_artist = custom_artist or c_info.get('artist') or c_info.get('uploader') or ''
                        c_uploader = c_info.get('uploader')
                        off_v = find_official_music_video(c_title, c_artist, c_uploader)
                        if off_v and off_v.get("id"):
                            target_id_or_url = off_v["id"]
                            _update_task(task_id, is_official_clip=True, official_clip_title=off_v.get("title"))
            except Exception as e:
                print(f"[Warning] Failed to pre-check official video: {e}")

    url = target_id_or_url if target_id_or_url.startswith("http") else f"https://www.youtube.com/watch?v={target_id_or_url}"

    try:
        out_template = os.path.join(DOWNLOADS_DIR, "%(title)s.%(ext)s")
        hook = _progress_hook(task_id)

        if output_format == "mp3":
            ydl_opts = {
                'format': 'bestaudio/best',
                'outtmpl': out_template,
                'continuedl': True,
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
            ydl_opts = {
                'format': 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best[ext=mp4]/best',
                'merge_output_format': 'mp4',
                'outtmpl': out_template,
                'continuedl': True,
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

        _update_task(
            task_id,
            status="downloading" if is_resume else "starting",
            progress=5.0 if not is_resume else None,
            speed="" if not is_resume else "Ripresa download...",
            effective_url=url
        )

        with _LOCK:
            task = _TASKS.get(task_id)
        if task:
            if task.get("cancel_event") and task["cancel_event"].is_set():
                raise DownloadCancelledException()
            if task.get("pause_event") and task["pause_event"].is_set():
                raise DownloadPausedException()

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            if not info:
                raise Exception("Impossibile estrarre le informazioni sul file multimediale.")

            # Identify resulting filename
            actual_title = info.get('title', custom_title or 'Audio')
            clean_title = _sanitize_filename(actual_title)
            
            ext = "mp3" if output_format == "mp3" else "mp4"
            final_filename = f"{clean_title}.{ext}"
            final_path = os.path.join(DOWNLOADS_DIR, final_filename)

            # Check if file exists under original title template
            if not os.path.exists(final_path):
                for f in os.listdir(DOWNLOADS_DIR):
                    if f.endswith(f".{ext}"):
                        candidate = os.path.join(DOWNLOADS_DIR, f)
                        if abs(os.path.getmtime(candidate) - time.time()) < 90:
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
                completed_at=time.time(),
                speed="",
                eta=""
            )

    except DownloadPausedException:
        print(f"[Task {task_id}] In pausa su richiesta dell'utente.")
        _update_task(task_id, status="paused", speed="", eta="")
    except DownloadCancelledException:
        print(f"[Task {task_id}] Annullato su richiesta dell'utente.")
        with _LOCK:
            task = _TASKS.get(task_id)
        if task:
            _cleanup_partial_files(task)
        _update_task(task_id, status="cancelled", progress=0.0, speed="", eta="")
    except Exception as e:
        print(f"[Download Error on task {task_id}] {e}")
        _update_task(
            task_id,
            status="error",
            error=str(e),
            progress=0.0,
            speed="",
            eta=""
        )


def start_download_task(
    video_id_or_url: str,
    output_format: str = "mp3",
    title: Optional[str] = None,
    artist: Optional[str] = None,
    thumbnail_url: Optional[str] = None,
    official_video_id: Optional[str] = None
) -> str:
    """Initiate an asynchronous download task with pause/resume/cancel tracking."""
    task_id = str(uuid.uuid4())
    fmt = "mp3" if output_format.lower() == "mp3" else "mp4"

    pause_event = threading.Event()
    cancel_event = threading.Event()

    task_data = {
        "task_id": task_id,
        "url_or_id": video_id_or_url,
        "format": fmt,
        "title": title or "Download",
        "artist": artist or "",
        "thumbnail_url": thumbnail_url,
        "official_video_id": official_video_id,
        "is_official_clip": False,
        "status": "pending",
        "progress": 0.0,
        "speed": "",
        "eta": "",
        "filename": None,
        "filepath": None,
        "file_size": 0,
        "error": None,
        "created_at": time.time(),
        "completed_at": None,
        "pause_event": pause_event,
        "cancel_event": cancel_event,
        "thread": None
    }

    with _LOCK:
        _TASKS[task_id] = task_data

    thread = threading.Thread(
        target=_run_download_thread,
        args=(task_id, video_id_or_url, fmt, title, artist, thumbnail_url, official_video_id, False),
        daemon=True
    )
    task_data["thread"] = thread
    thread.start()

    return task_id


def pause_download_task(task_id: str) -> bool:
    """Pause an active download task."""
    with _LOCK:
        task = _TASKS.get(task_id)
        if not task:
            return False
        if task["status"] in ("downloading", "starting", "pending"):
            task["pause_event"].set()
            task["status"] = "paused"
            task["speed"] = ""
            task["eta"] = ""
            return True
    return False


def resume_download_task(task_id: str) -> bool:
    """Resume a paused download task from where it was interrupted."""
    with _LOCK:
        task = _TASKS.get(task_id)
        if not task or task["status"] != "paused":
            return False

        task["pause_event"].clear()
        task["cancel_event"].clear()
        task["status"] = "downloading"
        task["speed"] = "Ripresa..."
        task["error"] = None

        thread = threading.Thread(
            target=_run_download_thread,
            args=(
                task_id,
                task["url_or_id"],
                task["format"],
                task.get("title"),
                task.get("artist"),
                task.get("thumbnail_url"),
                task.get("official_video_id"),
                True
            ),
            daemon=True
        )
        task["thread"] = thread
        thread.start()
        return True


def cancel_download_task(task_id: str) -> bool:
    """Cancel an active or paused download task and clean up partial files."""
    with _LOCK:
        task = _TASKS.get(task_id)
        if not task:
            return False

        task["cancel_event"].set()
        task["status"] = "cancelled"
        task["progress"] = 0.0
        task["speed"] = ""
        task["eta"] = ""

    _cleanup_partial_files(task)
    return True


def delete_task(task_id: str) -> bool:
    """Cancel if running and remove task from in-memory tracking list."""
    with _LOCK:
        task = _TASKS.pop(task_id, None)
        if not task:
            return False

        if task.get("status") in ("downloading", "starting", "paused"):
            task["cancel_event"].set()

    _cleanup_partial_files(task)
    return True


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
    """Delete a single downloaded file."""
    path = get_safe_file_path(filename)
    if path and os.path.exists(path):
        os.remove(path)
        return True
    return False


def delete_all_files() -> int:
    """Delete all downloaded files in the storage directory."""
    deleted_count = 0
    if not os.path.exists(DOWNLOADS_DIR):
        return 0

    for entry in os.scandir(DOWNLOADS_DIR):
        if entry.is_file() and entry.name.lower().endswith(('.mp3', '.mp4', '.m4a')):
            try:
                os.remove(entry.path)
                deleted_count += 1
            except Exception as e:
                print(f"[Warning] Failed to delete {entry.name}: {e}")
    return deleted_count

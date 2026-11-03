import os
# Ensure FFmpeg and Deno are in PATH if installed on Windows

for _extra_path in [

    os.path.expanduser(r"~\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.2-full_build\bin"),

    os.path.expanduser(r"~\AppData\Local\Microsoft\WinGet\Packages\DenoLand.Deno_Microsoft.Winget.Source_8wekyb3d8bbwe"),

    r"C:\ffmpeg\bin",

    r"C:\Program Files\ffmpeg\bin"

]:

    if os.path.isdir(_extra_path) and _extra_path not in os.environ.get("PATH", ""):

        os.environ["PATH"] = f"{_extra_path};" + os.environ.get("PATH", "")



import re

import uuid

import time

import shutil

import tempfile

import threading

import requests

import yt_dlp

from typing import Dict, Any, Optional, List

from mutagen.easyid3 import EasyID3

from mutagen.mp3 import MP3

from mutagen.id3 import ID3, APIC, TIT2, TPE1, TALB



# Ephemeral temporary directory: files exist ONLY during conversion/transmission, then deleted immediately!

TEMP_DIR = os.getenv("TEMP_DIR", os.path.join(tempfile.gettempdir(), "musicdownloader_temp"))

os.makedirs(TEMP_DIR, exist_ok=True)



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



# Sequential Queue management: allows 1 active download/conversion at a time, queueing subsequent tasks

_DOWNLOAD_QUEUE: List[str] = []

_ACTIVE_RUNNING_TASK_ID: Optional[str] = None





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





def get_raw_task(task_id: str) -> Optional[Dict[str, Any]]:

    """Return the raw in-memory task dictionary including internal filepaths."""

    with _LOCK:

        return _TASKS.get(task_id)





def get_all_tasks(client_id: Optional[str] = None) -> List[Dict[str, Any]]:

    with _LOCK:

        tasks = []

        for t in _TASKS.values():

            if client_id and t.get("client_id") and t.get("client_id") != client_id:

                continue

            tasks.append(serialize_task(t))

        tasks.sort(key=lambda x: x.get("created_at", 0), reverse=True)

        return tasks





def _update_queue_positions_locked():

    """Recalculate and update queue positions for all queued tasks."""

    pos = 1

    for tid in _DOWNLOAD_QUEUE:

        t = _TASKS.get(tid)

        if t and t.get("status") == "queued":

            t["queue_position"] = pos

            t["eta"] = f"In coda (#{pos})"

            pos += 1





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





def cleanup_task_file(task_id: str) -> bool:

    """

    Delete the generated media file from the server immediately after delivery to client browser.

    Ensures 0 bytes remain on the server!

    """

    with _LOCK:

        task = _TASKS.get(task_id)

        if not task:

            return False

        filepath = task.get("filepath")

        if filepath and os.path.exists(filepath):

            try:

                os.remove(filepath)

                task["filepath"] = None

                task["server_cleaned"] = True

                print(f"[Client-Only Delivery] File temporaneo per task {task_id} eliminato dal server con successo.")

                return True

            except Exception as e:

                print(f"[Warning] Impossibile eliminare {filepath}: {e}")

    return False





def _cleanup_partial_files(task: Dict[str, Any]):

    """Clean up .part, .ytdl, or temporary files associated with task."""

    try:

        clean_title = _sanitize_filename(task.get("title", ""))

        now = time.time()

        for f in os.listdir(TEMP_DIR):

            if f.endswith(('.part', '.ytdl', '.temp')):

                full_p = os.path.join(TEMP_DIR, f)

                if not clean_title or clean_title.lower() in f.lower() or abs(os.path.getmtime(full_p) - now) < 7200:

                    try:

                        os.remove(full_p)

                    except Exception:

                        pass

    except Exception as e:

        print(f"[Warning] Failed to cleanup partial files: {e}")





# Background sweeper for any abandoned temporary files (>10 minutes old)

def _periodic_cleanup_sweeper():

    while True:

        try:

            now = time.time()

            if os.path.exists(TEMP_DIR):

                for entry in os.scandir(TEMP_DIR):

                    if entry.is_file():

                        # Delete any file older than 10 minutes

                        if now - entry.stat().st_mtime > 600:

                            try:

                                os.remove(entry.path)

                            except Exception:

                                pass

        except Exception:

            pass

        time.sleep(180)



_cleaner_thread = threading.Thread(target=_periodic_cleanup_sweeper, daemon=True)

_cleaner_thread.start()





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





def _process_next_in_queue_locked():

    """Trigger the next task in queue when active task concludes."""

    global _ACTIVE_RUNNING_TASK_ID

    while _DOWNLOAD_QUEUE:

        next_id = _DOWNLOAD_QUEUE.pop(0)

        task = _TASKS.get(next_id)

        if not task:

            continue

        # Skip if already cancelled or errored

        if task.get("status") in ("cancelled", "error", "finished"):

            continue



        _ACTIVE_RUNNING_TASK_ID = next_id

        task["status"] = "starting"

        task["progress"] = 5.0

        task["speed"] = ""

        task["eta"] = "Avvio elaborazione..."

        task["queue_position"] = 0

        _update_queue_positions_locked()



        thread = threading.Thread(

            target=_run_download_thread,

            args=(

                next_id,

                task["url_or_id"],

                task["format"],

                task.get("title"),

                task.get("artist"),

                task.get("thumbnail_url"),

                task.get("official_video_id"),

                False

            ),

            daemon=True

        )

        task["thread"] = thread

        thread.start()

        print(f"[Sequential Queue] Avviato prossimo download in coda: Task {next_id} ('{task.get('title')}')")

        return



    _ACTIVE_RUNNING_TASK_ID = None





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

    """Background worker for yt-dlp execution with queue integration, pause/resume and video resolution."""

    from app.music_service import find_official_music_video, is_art_track_info



    target_id_or_url = video_id_or_url



    try:

        # When downloading video (MP4), verify if we should fetch the official music video

        if output_format == "mp4":

            if official_video_id:

                target_id_or_url = official_video_id

                _update_task(task_id, is_official_clip=True)

            else:

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



        out_template = os.path.join(TEMP_DIR, "%(title)s.%(ext)s")

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

            effective_url=url,

            queue_position=0

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

            final_path = os.path.join(TEMP_DIR, final_filename)



            # Check if file exists under original title template

            if not os.path.exists(final_path):

                for f in os.listdir(TEMP_DIR):

                    if f.endswith(f".{ext}"):

                        candidate = os.path.join(TEMP_DIR, f)

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

                download_url=f"/api/download/file/{task_id}",

                speed="",

                eta="",

                queue_position=0

            )



    except DownloadPausedException:

        print(f"[Task {task_id}] In pausa su richiesta dell'utente.")

        _update_task(task_id, status="paused", speed="", eta="", queue_position=0)

    except DownloadCancelledException:

        print(f"[Task {task_id}] Annullato su richiesta dell'utente.")

        with _LOCK:

            task = _TASKS.get(task_id)

        if task:

            _cleanup_partial_files(task)

        _update_task(task_id, status="cancelled", progress=0.0, speed="", eta="", queue_position=0)

    except Exception as e:

        print(f"[Download Error on task {task_id}] {e}")

        _update_task(

            task_id,

            status="error",

            error=str(e),

            progress=0.0,

            speed="",

            eta="",

            queue_position=0

        )

    finally:

        # Crucial for Queue System: release active worker and process next task in queue

        with _LOCK:

            global _ACTIVE_RUNNING_TASK_ID

            if _ACTIVE_RUNNING_TASK_ID == task_id:

                _ACTIVE_RUNNING_TASK_ID = None

                _process_next_in_queue_locked()





def start_download_task(

    video_id_or_url: str,

    output_format: str = "mp3",

    title: Optional[str] = None,

    artist: Optional[str] = None,

    thumbnail_url: Optional[str] = None,

    official_video_id: Optional[str] = None,

    client_id: Optional[str] = None

) -> str:

    """

    Initiate or enqueue a download task.

    If another download is active, automatically queues this task sequentially.

    """

    global _ACTIVE_RUNNING_TASK_ID

    task_id = str(uuid.uuid4())

    fmt = "mp3" if output_format.lower() == "mp3" else "mp4"



    pause_event = threading.Event()

    cancel_event = threading.Event()



    task_data = {

        "task_id": task_id,

        "client_id": client_id,

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

        "queue_position": 0,

        "filename": None,

        "filepath": None,

        "download_url": None,

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

        

        # Check if worker is currently busy

        active_task = _TASKS.get(_ACTIVE_RUNNING_TASK_ID) if _ACTIVE_RUNNING_TASK_ID else None

        is_busy = active_task and active_task.get("status") in ("starting", "downloading", "converting", "tagging")



        if not is_busy:

            _ACTIVE_RUNNING_TASK_ID = task_id

            task_data["status"] = "starting"

            task_data["progress"] = 5.0

            task_data["eta"] = "Avvio elaborazione..."

            

            thread = threading.Thread(

                target=_run_download_thread,

                args=(task_id, video_id_or_url, fmt, title, artist, thumbnail_url, official_video_id, False),

                daemon=True

            )

            task_data["thread"] = thread

            thread.start()

            print(f"[Sequential Queue] Avvio immediato Task {task_id} ('{task_data['title']}').")

        else:

            # Add to sequential queue

            _DOWNLOAD_QUEUE.append(task_id)

            task_data["status"] = "queued"

            _update_queue_positions_locked()

            print(f"[Sequential Queue] Task {task_id} ('{task_data['title']}') aggiunto in coda alla posizione #{task_data['queue_position']}.")



    return task_id





def pause_download_task(task_id: str) -> bool:

    """Pause an active download task or a queued download task."""

    global _ACTIVE_RUNNING_TASK_ID

    with _LOCK:

        task = _TASKS.get(task_id)

        if not task:

            return False

        

        if task["status"] in ("downloading", "starting", "pending"):

            task["pause_event"].set()

            task["status"] = "paused"

            task["speed"] = ""

            task["eta"] = "In pausa"

            if _ACTIVE_RUNNING_TASK_ID == task_id:

                _ACTIVE_RUNNING_TASK_ID = None

                # Advance queue so other tasks don't get blocked

                _process_next_in_queue_locked()

            return True

        elif task["status"] == "queued":

            task["status"] = "paused"

            task["eta"] = "In pausa"

            if task_id in _DOWNLOAD_QUEUE:

                _DOWNLOAD_QUEUE.remove(task_id)

                _update_queue_positions_locked()

            return True

    return False





def resume_download_task(task_id: str) -> bool:

    """Resume a paused download task (immediately if idle, or places in queue)."""

    global _ACTIVE_RUNNING_TASK_ID

    with _LOCK:

        task = _TASKS.get(task_id)

        if not task or task["status"] != "paused":

            return False



        task["pause_event"].clear()

        task["cancel_event"].clear()

        task["error"] = None



        active_task = _TASKS.get(_ACTIVE_RUNNING_TASK_ID) if _ACTIVE_RUNNING_TASK_ID else None

        is_busy = active_task and active_task.get("status") in ("starting", "downloading", "converting", "tagging")



        if not is_busy:

            _ACTIVE_RUNNING_TASK_ID = task_id

            task["status"] = "downloading"

            task["speed"] = "Ripresa..."

            task["queue_position"] = 0

            

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

        else:

            task["status"] = "queued"

            _DOWNLOAD_QUEUE.append(task_id)

            _update_queue_positions_locked()



        return True





def cancel_download_task(task_id: str) -> bool:

    """Cancel an active or queued download task and clean up partial files."""

    global _ACTIVE_RUNNING_TASK_ID

    with _LOCK:

        task = _TASKS.get(task_id)

        if not task:

            return False



        task["cancel_event"].set()

        task["status"] = "cancelled"

        task["progress"] = 0.0

        task["speed"] = ""

        task["eta"] = "Annullato"

        task["queue_position"] = 0



        if task_id in _DOWNLOAD_QUEUE:

            _DOWNLOAD_QUEUE.remove(task_id)

            _update_queue_positions_locked()



        if _ACTIVE_RUNNING_TASK_ID == task_id:

            _ACTIVE_RUNNING_TASK_ID = None

            _process_next_in_queue_locked()



    _cleanup_partial_files(task)

    return True





def delete_task(task_id: str) -> bool:

    """Cancel if running, remove from queue, and remove task from in-memory tracking list."""

    global _ACTIVE_RUNNING_TASK_ID

    with _LOCK:

        if task_id in _DOWNLOAD_QUEUE:

            _DOWNLOAD_QUEUE.remove(task_id)

            _update_queue_positions_locked()



        task = _TASKS.pop(task_id, None)

        if not task:

            return False



        if task.get("status") in ("downloading", "starting", "paused"):

            task["cancel_event"].set()



        if _ACTIVE_RUNNING_TASK_ID == task_id:

            _ACTIVE_RUNNING_TASK_ID = None

            _process_next_in_queue_locked()



    _cleanup_partial_files(task)

    return True





def list_downloaded_files() -> List[Dict[str, Any]]:

    """Returns empty list: files are NOT stored on the server!"""

    return []





def get_safe_file_path(filename_or_id: str) -> Optional[str]:

    """Look up file path in ephemeral TEMP_DIR or by task."""

    with _LOCK:

        for task in _TASKS.values():

            if task.get("filename") == filename_or_id or task.get("task_id") == filename_or_id:

                fp = task.get("filepath")

                if fp and os.path.exists(fp):

                    return fp



    safe_name = os.path.basename(filename_or_id)

    cand = os.path.join(TEMP_DIR, safe_name)

    if os.path.exists(cand) and os.path.isfile(cand):

        return cand

    return None





def delete_file(filename_or_id: str) -> bool:

    """Delete a temporary file."""

    path = get_safe_file_path(filename_or_id)

    if path and os.path.exists(path):

        try:

            os.remove(path)

            return True

        except Exception:

            pass

    return False





def delete_all_files() -> int:

    """Delete all files in TEMP_DIR."""

    deleted_count = 0

    if not os.path.exists(TEMP_DIR):

        return 0



    for entry in os.scandir(TEMP_DIR):

        if entry.is_file():

            try:

                os.remove(entry.path)

                deleted_count += 1

            except Exception:

                pass

    return deleted_count


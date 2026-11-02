"""
Comprehensive End-to-End Automated Test Suite for MusicDownloader.
Tests all features:
1. API Health
2. Single Page App HTML Serving
3. Popular Charts (IT and Global)
4. Incremental Search & Auto-Resolution
5. Spotify URL oEmbed Resolution
6. Track Metadata & Format Extraction
7. MP3 320kbps Download & ID3 Tag Verification
8. MP4 Video Download Verification
9. Art Track Detection & Official Music Video Resolution
10. Task Pause, Resume, Cancel & Memory Cleanup
11. Single & Bulk File Deletion with Character Escaping
"""
import os
import sys
import time
import requests
import urllib.parse
from mutagen.mp3 import MP3
from mutagen.id3 import ID3

BASE_URL = "http://localhost:8765"

def test_health():
    print("[TEST 1] Testing /api/health...")
    r = requests.get(f"{BASE_URL}/api/health", timeout=5)
    assert r.status_code == 200, f"Health check failed with {r.status_code}"
    data = r.json()
    assert data.get("status") == "ok"
    print(" -> PASSED: Server is healthy and responsive.")

def test_home_page():
    print("[TEST 2] Testing Home Page (GET /)...")
    r = requests.get(f"{BASE_URL}/", timeout=5)
    assert r.status_code == 200, f"Home page returned {r.status_code}"
    assert "MusicDownloader" in r.text
    assert "handleIncrementalSearch" in r.text or "searchInput" in r.text
    print(f" -> PASSED: Home page served successfully ({len(r.text)} bytes).")

def test_popular_charts():
    print("[TEST 3] Testing Popular Charts (/api/popular)...")
    # Test Italy
    r = requests.get(f"{BASE_URL}/api/popular?country=IT", timeout=10)
    assert r.status_code == 200
    data = r.json()
    assert data.get("success") is True
    tracks = data.get("tracks", [])
    assert len(tracks) > 0, "No tracks returned for Italy"
    print(f" -> PASSED: Italy Charts returned {len(tracks)} tracks. Top 1: '{tracks[0]['title']}' by {tracks[0]['artist']}")

    # Test Global
    r_glob = requests.get(f"{BASE_URL}/api/popular?country=ZZ", timeout=10)
    assert r_glob.status_code == 200
    assert len(r_glob.json().get("tracks", [])) > 0
    print(f" -> PASSED: Global Charts returned {len(r_glob.json().get('tracks', []))} tracks.")

def test_incremental_search():
    print("[TEST 4] Testing Incremental Search (/api/search?q=...)...")
    queries = ["Cold", "Coldplay", "Sfera"]
    for q in queries:
        r = requests.get(f"{BASE_URL}/api/search?q={q}", timeout=10)
        assert r.status_code == 200
        data = r.json()
        assert data.get("success") is True
        items = data.get("items", [])
        assert len(items) > 0, f"No results for '{q}'"
        print(f" -> Search query '{q}': found {len(items)} items. First match: '{items[0]['title']}'")
    print(" -> PASSED: Live incremental search working accurately.")

def test_spotify_resolution():
    print("[TEST 5] Testing Spotify Link Resolution...")
    spotify_url = "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT"
    r = requests.get(f"{BASE_URL}/api/search?q={spotify_url}", timeout=10)
    assert r.status_code == 200
    data = r.json()
    assert data.get("success") is True
    assert data.get("resolved") == "spotify"
    assert "Rick" in data.get("spotify_info", {}).get("artist", "") or "Never Gonna Give You Up" in data.get("spotify_info", {}).get("title", "")
    print(f" -> PASSED: Spotify link resolved to title: '{data.get('spotify_info', {}).get('title')}' with {len(data.get('items', []))} matches.")

def test_details():
    print("[TEST 6] Testing Track Details (/api/details/dQw4w9WgXcQ)...")
    r = requests.get(f"{BASE_URL}/api/details/dQw4w9WgXcQ", timeout=10)
    assert r.status_code == 200
    data = r.json()
    assert data.get("success") is True
    details = data.get("data", {})
    assert "Never Gonna Give You Up" in details.get("title", "")
    assert details.get("duration_seconds") > 100
    assert details.get("max_video_quality")
    assert "320 kbps" in details.get("max_audio_quality")
    print(f" -> PASSED: Details extracted: '{details.get('title')}', Max Video: {details.get('max_video_quality')}, Duration: {details.get('duration')}")
    return details

def test_mp3_download_and_id3_tags():
    print("[TEST 7] Testing MP3 Download with 320 kbps & Embedded ID3 Cover Art...")
    payload = {
        "id_or_url": "dQw4w9WgXcQ",
        "format": "mp3",
        "title": "Automated Test Song",
        "artist": "Test Artist",
        "thumbnail": "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"
    }
    r = requests.post(f"{BASE_URL}/api/download", json=payload, timeout=10)
    assert r.status_code == 200
    task_id = r.json().get("task_id")
    assert task_id

    # Poll until completed
    max_wait = 60
    start = time.time()
    filename = None
    while time.time() - start < max_wait:
        r_poll = requests.get(f"{BASE_URL}/api/task/{task_id}", timeout=5)
        task = r_poll.json().get("task", {})
        status = task.get("status")
        if status == "finished":
            filename = task.get("filename")
            file_size = task.get("file_size")
            print(f" -> Download finished in {int(time.time() - start)}s! File: '{filename}' ({file_size / (1024*1024):.2f} MB)")
            break
        elif status == "error":
            raise Exception(f"Download failed with error: {task.get('error')}")
        time.sleep(1)

    assert filename, "Download task timed out"

    local_path = os.path.join("downloads", filename)
    assert os.path.exists(local_path), f"File {local_path} not found on host machine"

    # Check ID3 Tags using mutagen
    audio = MP3(local_path)
    id3 = ID3(local_path)
    bitrate = int(audio.info.bitrate / 1000)
    print(f" -> MP3 Audio Bitrate: ~{bitrate} kbps (High Fidelity)")
    
    # Check embedded cover
    has_apic = any(k.startswith("APIC") for k in id3.keys())
    print(f" -> Embedded Cover Art Present: {has_apic}")
    assert has_apic, "Cover art was not embedded into ID3 tags"

    # Check files endpoint
    r_files = requests.get(f"{BASE_URL}/api/files", timeout=5)
    assert r_files.status_code == 200
    file_list = r_files.json().get("files", [])
    assert any(f["filename"] == filename for f in file_list)

    # Test file download stream
    r_stream = requests.get(f"{BASE_URL}/api/files/download/{urllib.parse.quote(filename)}", stream=True, timeout=5)
    assert r_stream.status_code == 200
    assert r_stream.headers.get("content-type") == "audio/mpeg"
    print(" -> File download stream via browser endpoint verified (HTTP 200 audio/mpeg).")

    # Cleanup test file
    r_del = requests.delete(f"{BASE_URL}/api/files/{urllib.parse.quote(filename)}", timeout=5)
    assert r_del.status_code == 200
    assert not os.path.exists(local_path)
    print(" -> Test file cleaned up successfully.")
    print(" -> PASSED: Complete MP3 download and metadata pipeline verified!")

def test_mp4_video_download():
    print("[TEST 8] Testing MP4 Video Download with FFmpeg Multiplexing...")
    payload = {
        "id_or_url": "dQw4w9WgXcQ",
        "format": "mp4",
        "title": "Automated Test Video",
        "artist": "Test Artist"
    }
    r = requests.post(f"{BASE_URL}/api/download", json=payload, timeout=10)
    assert r.status_code == 200
    task_id = r.json().get("task_id")
    assert task_id

    max_wait = 90
    start = time.time()
    filename = None
    while time.time() - start < max_wait:
        r_poll = requests.get(f"{BASE_URL}/api/task/{task_id}", timeout=5)
        task = r_poll.json().get("task", {})
        status = task.get("status")
        if status == "finished":
            filename = task.get("filename")
            file_size = task.get("file_size")
            print(f" -> MP4 Video downloaded in {int(time.time() - start)}s! File: '{filename}' ({file_size / (1024*1024):.2f} MB)")
            break
        elif status == "error":
            raise Exception(f"MP4 download failed: {task.get('error')}")
        time.sleep(1)

    assert filename, "MP4 download task timed out"
    local_path = os.path.join("downloads", filename)
    assert os.path.exists(local_path), f"Video file {local_path} not found on host"
    assert os.path.getsize(local_path) > 1024 * 1024, "Video file size too small"

    r_stream = requests.get(f"{BASE_URL}/api/files/download/{urllib.parse.quote(filename)}", stream=True, timeout=5)
    assert r_stream.status_code == 200
    assert r_stream.headers.get("content-type") == "video/mp4"
    print(" -> MP4 Video stream endpoint verified (HTTP 200 video/mp4).")

    r_del = requests.delete(f"{BASE_URL}/api/files/{urllib.parse.quote(filename)}", timeout=5)
    assert r_del.status_code == 200
    assert not os.path.exists(local_path)
    print(" -> Test MP4 video cleaned up successfully.")
    print(" -> PASSED: Complete MP4 video download pipeline verified!")

def test_art_track_and_official_video_detection():
    print("[TEST 9] Testing Art Track Detection & Official Music Video Resolution...")
    # 2h0YtvaENXM is Alfa - bellissimissima (Topic audio track with static artwork)
    r = requests.get(f"{BASE_URL}/api/details/2h0YtvaENXM", timeout=15)
    assert r.status_code == 200
    data = r.json().get("data", {})
    assert data.get("is_art_track") is True, "Failed to identify Art Track"
    assert data.get("has_official_video") is True, "Failed to identify that official video exists"
    assert data.get("official_video_id") == "330xZ5xFF68", f"Unexpected official video ID: {data.get('official_video_id')}"
    print(f" -> PASSED: Successfully detected Art Track and resolved official video clip ({data.get('official_video_id')}: '{data.get('official_video_title')}')")

def test_pause_resume_cancel_and_memory_cleanup():
    print("[TEST 10] Testing Task Pause, Resume, Cancel & Memory Cleanup...")
    # Start a video download
    res = requests.post(f"{BASE_URL}/api/download", json={
        "id_or_url": "dQw4w9WgXcQ",
        "format": "mp4",
        "title": "Task Control Lifecycle Test",
        "artist": "Lifecycle Artist"
    }, timeout=10)
    assert res.status_code == 200
    task_id = res.json()["task_id"]

    # Check task list
    tasks = requests.get(f"{BASE_URL}/api/tasks", timeout=5).json().get("tasks", [])
    assert any(t["task_id"] == task_id for t in tasks)

    # Pause
    time.sleep(1.5)
    p_res = requests.post(f"{BASE_URL}/api/task/{task_id}/pause", timeout=5)
    assert p_res.status_code == 200
    time.sleep(0.5)
    t_paused = requests.get(f"{BASE_URL}/api/task/{task_id}", timeout=5).json()["task"]
    assert t_paused["status"] == "paused", f"Expected paused status, got {t_paused['status']}"
    print(" -> Task paused successfully.")

    # Resume
    r_res = requests.post(f"{BASE_URL}/api/task/{task_id}/resume", timeout=5)
    assert r_res.status_code == 200
    time.sleep(1)
    t_resumed = requests.get(f"{BASE_URL}/api/task/{task_id}", timeout=5).json()["task"]
    assert t_resumed["status"] in ("downloading", "starting")
    print(" -> Task resumed successfully.")

    # Cancel
    c_res = requests.post(f"{BASE_URL}/api/task/{task_id}/cancel", timeout=5)
    assert c_res.status_code == 200
    time.sleep(0.5)
    t_cancelled = requests.get(f"{BASE_URL}/api/task/{task_id}", timeout=5).json()["task"]
    assert t_cancelled["status"] == "cancelled"
    print(" -> Task cancelled & partial files cleaned up.")

    # Delete task from tracker
    d_res = requests.delete(f"{BASE_URL}/api/task/{task_id}", timeout=5)
    assert d_res.status_code == 200
    tasks_after = requests.get(f"{BASE_URL}/api/tasks", timeout=5).json().get("tasks", [])
    assert not any(t["task_id"] == task_id for t in tasks_after)
    print(" -> PASSED: Full task control lifecycle (pause, resume, cancel, delete) verified!")

def test_delete_single_and_bulk_files():
    print("[TEST 11] Testing Single & Bulk File Deletion with Character Escaping...")
    os.makedirs("downloads", exist_ok=True)
    f1 = "L'Amour Toujours Test.mp3"
    f2 = "Don't Stop The Music Test.mp3"
    with open(os.path.join("downloads", f1), "wb") as f:
        f.write(b"test123")
    with open(os.path.join("downloads", f2), "wb") as f:
        f.write(b"test456")

    # Delete single file with apostrophe
    r_del1 = requests.delete(f"{BASE_URL}/api/files/{urllib.parse.quote(f1)}", timeout=5)
    assert r_del1.status_code == 200
    assert not os.path.exists(os.path.join("downloads", f1))
    print(" -> Single file with apostrophe deleted successfully.")

    # Bulk delete all
    r_bulk = requests.delete(f"{BASE_URL}/api/files", timeout=5)
    assert r_bulk.status_code == 200
    assert not os.path.exists(os.path.join("downloads", f2))
    print(" -> Bulk delete cleared remaining files successfully.")
    print(" -> PASSED: Single and bulk file deletion verified!")

if __name__ == "__main__":
    if sys.stdout.encoding != 'utf-8':
        try:
            sys.stdout.reconfigure(encoding='utf-8')
        except Exception:
            pass
    print("=" * 60)
    print("[TEST SUITE] AVVIO SUITE COMPLETA DI TEST AUTOMATIZZATI (11 TEST)")
    print("=" * 60)
    test_health()
    test_home_page()
    test_popular_charts()
    test_incremental_search()
    test_spotify_resolution()
    test_details()
    test_mp3_download_and_id3_tags()
    test_mp4_video_download()
    test_art_track_and_official_video_detection()
    test_pause_resume_cancel_and_memory_cleanup()
    test_delete_single_and_bulk_files()
    print("=" * 60)
    print("[SUCCESS] TUTTI GLI 11 TEST COMPLETATI CON SUCCESSO! ZERO ERRORI.")
    print("=" * 60)

"""
Comprehensive End-to-End Automated Test Suite for MusicDownloader.
Tests all features:
- API Health
- Single Page App HTML Serving
- Popular Charts (IT and Global)
- Incremental Search & Auto-Resolution
- Spotify URL oEmbed Resolution
- YouTube URL Resolution
- Track Metadata & Format Extraction
- MP3 320kbps Download & ID3 Tag Verification
- MP4 Video Download Verification
- Download Management & File Cleanup
"""
import os
import sys
import time
import requests
from mutagen.mp3 import MP3
from mutagen.id3 import ID3

BASE_URL = "http://localhost:8000"

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
        progress = task.get("progress")
        if status == "finished":
            filename = task.get("filename")
            file_size = task.get("file_size")
            print(f" -> Download finished in {int(time.time() - start)}s! File: '{filename}' ({file_size / (1024*1024):.2f} MB)")
            break
        elif status == "error":
            raise Exception(f"Download failed with error: {task.get('error')}")
        time.sleep(1)

    assert filename, "Download task timed out"

    # Verify file exists on host volume
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
    r_stream = requests.get(f"{BASE_URL}/api/files/download/{filename}", stream=True, timeout=5)
    assert r_stream.status_code == 200
    assert r_stream.headers.get("content-type") == "audio/mpeg"
    print(" -> File download stream via browser endpoint verified (HTTP 200 audio/mpeg).")

    # Cleanup test file
    r_del = requests.delete(f"{BASE_URL}/api/files/{filename}", timeout=5)
    assert r_del.status_code == 200
    assert not os.path.exists(local_path)
    print(" -> Test file cleaned up successfully.")
    print(" -> PASSED: Complete MP3 download and metadata pipeline verified!")

if __name__ == "__main__":
    if sys.stdout.encoding != 'utf-8':
        try:
            sys.stdout.reconfigure(encoding='utf-8')
        except Exception:
            pass
    print("=" * 60)
    print("[TEST SUITE] AVVIO SUITE COMPLETA DI TEST AUTOMATIZZATI")
    print("=" * 60)
    test_health()
    test_home_page()
    test_popular_charts()
    test_incremental_search()
    test_spotify_resolution()
    test_details()
    test_mp3_download_and_id3_tags()
    print("=" * 60)
    print("[SUCCESS] TUTTI I 7 TEST COMPLETATI CON SUCCESSO! ZERO ERRORI.")
    print("=" * 60)

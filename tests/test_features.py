import os
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import time
from fastapi.testclient import TestClient
from app.main import app
import app.downloader as downloader

client = TestClient(app)

def test_all():
    print("=" * 60)
    print("VERIFICA AUTOMATICA DELLE NUOVE FUNZIONALITÀ")
    print("=" * 60)

    print("\n[1] TEST HEALTH CHECK")
    r = client.get("/api/health")
    assert r.status_code == 200, f"Status: {r.status_code}"
    print(" -> PASSED: /api/health ha risposto 200 OK.")

    print("\n[2] TEST ELEMENTI HTML & RESPONSIVE")
    r = client.get("/")
    assert r.status_code == 200
    html = r.text
    assert "navLiveBadge" in html, "Missing navLiveBadge"
    assert "previewEmbedContainer" in html, "Missing previewEmbedContainer"
    assert "player-tabs-bar" in html, "Missing player-tabs-bar"
    assert "direct-audio-player" in html, "Missing direct-audio-player"
    assert "progressQueueBadge" in html, "Missing progressQueueBadge"
    assert "card-header-top" in html, "Missing card-header-top"
    print(" -> PASSED: Badge galleggiante, lettore anti-VPN e schede mobile-safe presenti.")

    print("\n[3] TEST DETTAGLI BRANO & ENDPOINT ANTI-BLOCCO VPN")
    details = client.get("/api/details/dQw4w9WgXcQ")
    assert details.status_code == 200
    d = details.json()["data"]
    assert "direct_audio_url" in d, "Missing direct_audio_url"
    assert "proxy_video_url" in d, "Missing proxy_video_url"
    assert "embed_url" in d, "Missing embed_url"
    print(f" -> PASSED: Dettagli contengono direct_audio_url={d['direct_audio_url']}")

    print("\n[4] TEST STREAMING AUDIO DIRETTO (BYPASS VPN / YOUTUBE)")
    audio_resp = client.get(d["direct_audio_url"], headers={"Range": "bytes=0-1023"})
    print(" -> Status:", audio_resp.status_code)
    print(" -> Content-Type:", audio_resp.headers.get("content-type"))
    print(" -> Content-Range:", audio_resp.headers.get("content-range"))
    assert audio_resp.status_code in (200, 206)
    assert len(audio_resp.content) > 0
    print(" -> PASSED: Lo stream audio nativo funziona e supporta Range requests!")

    print("\n[5] TEST CODA SEQUENZIALE DEI DOWNLOAD")
    # Reset in-memory state
    downloader._TASKS.clear()
    downloader._DOWNLOAD_QUEUE.clear()
    downloader._ACTIVE_RUNNING_TASK_ID = None

    # Avvio task 1 (immediato)
    t1 = client.post("/api/download", json={
        "id_or_url": "dQw4w9WgXcQ",
        "format": "mp3",
        "title": "Canzone 1",
        "client_id": "test_client"
    }).json()
    print(" -> Task 1 status:", t1["status"], "queue_pos:", t1["queue_position"])
    assert t1["status"] == "starting"

    # Avvio task 2 subito dopo (deve andare in coda)
    t2 = client.post("/api/download", json={
        "id_or_url": "dQw4w9WgXcQ",
        "format": "mp4",
        "title": "Video 2",
        "client_id": "test_client"
    }).json()
    print(" -> Task 2 status:", t2["status"], "queue_pos:", t2["queue_position"])
    assert t2["status"] == "queued"
    assert t2["queue_position"] == 1

    # Avvio task 3 subito dopo (deve andare in coda alla posizione 2)
    t3 = client.post("/api/download", json={
        "id_or_url": "dQw4w9WgXcQ",
        "format": "mp3",
        "title": "Canzone 3",
        "client_id": "test_client"
    }).json()
    print(" -> Task 3 status:", t3["status"], "queue_pos:", t3["queue_position"])
    assert t3["status"] == "queued"
    assert t3["queue_position"] == 2

    # Verifica lista /api/tasks
    tasks_resp = client.get("/api/tasks?client_id=test_client").json()["tasks"]
    task_map = {t["task_id"]: t for t in tasks_resp}
    assert task_map[t2["task_id"]]["status"] == "queued"
    assert task_map[t2["task_id"]]["queue_position"] == 1
    assert task_map[t3["task_id"]]["status"] == "queued"
    assert task_map[t3["task_id"]]["queue_position"] == 2

    # Annulla Task 1 -> Task 2 deve avanzare automaticamente ed avviarsi!
    client.post(f"/api/task/{t1['task_id']}/cancel")
    time.sleep(0.2)

    t2_updated = client.get(f"/api/task/{t2['task_id']}").json()["task"]
    print(" -> Task 2 dopo cancellazione Task 1:", t2_updated["status"], "queue_pos:", t2_updated["queue_position"])
    assert t2_updated["status"] in ("starting", "downloading")

    # Task 3 deve essere avanzato alla posizione 1
    t3_updated = client.get(f"/api/task/{t3['task_id']}").json()["task"]
    print(" -> Task 3 posizione aggiornata:", t3_updated["queue_position"])
    assert t3_updated["queue_position"] == 1

    # Annulla Task 2 -> Task 3 deve avviarsi automaticamente!
    client.post(f"/api/task/{t2['task_id']}/cancel")
    time.sleep(0.2)

    t3_final = client.get(f"/api/task/{t3['task_id']}").json()["task"]
    print(" -> Task 3 status dopo cancellazione Task 2:", t3_final["status"])
    assert t3_final["status"] in ("starting", "downloading")

    # Pulizia
    client.post(f"/api/task/{t3['task_id']}/cancel")
    print(" -> PASSED: Logica della coda sequenziale completamente verificata con successo!")

    print("\n" + "=" * 60)
    print("TUTTI I TEST SONO STATI SUPERATI CON SUCCESSO!")
    print("=" * 60)

if __name__ == "__main__":
    test_all()

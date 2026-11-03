const app = {
    currentCountry: 'IT',
    currentView: 'popular',
    previousView: 'popular',
    currentTrack: null,
    currentDetailTaskId: null,
    searchDebounceTimer: null,
    searchAbortController: null,
    searchSeq: 0,
    tasksPollerTimer: null,
    activeTasks: new Map(),
    downloadedTaskIds: new Set(),

    // Preview player state
    activePlayerTab: 'audio',
    currentAudioUrl: null,
    currentEmbedUrl: null,
    currentProxyUrl: null,

    // Identificatore univoco del dispositivo (Client-Side scoping)
    getClientId() {
        let id = localStorage.getItem('md_client_id');
        if (!id) {
            id = 'cli_' + Math.random().toString(36).substring(2, 10) + '_' + Date.now();
            localStorage.setItem('md_client_id', id);
        }
        return id;
    },

    // Task avviati da questo specifico browser/dispositivo
    getMyInitiatedTasks() {
        try {
            const raw = localStorage.getItem('md_my_tasks');
            return raw ? new Set(JSON.parse(raw)) : new Set();
        } catch (e) {
            return new Set();
        }
    },

    addMyInitiatedTask(taskId) {
        const tasks = this.getMyInitiatedTasks();
        tasks.add(taskId);
        const arr = Array.from(tasks).slice(-300);
        localStorage.setItem('md_my_tasks', JSON.stringify(arr));
    },

    // Task già salvati/scaricati nel browser di questo dispositivo
    getDownloadedTasks() {
        try {
            const raw = localStorage.getItem('md_downloaded_tasks');
            return raw ? new Set(JSON.parse(raw)) : new Set();
        } catch (e) {
            return new Set();
        }
    },

    markTaskAsDownloaded(taskId) {
        const tasks = this.getDownloadedTasks();
        tasks.add(taskId);
        const arr = Array.from(tasks).slice(-300);
        localStorage.setItem('md_downloaded_tasks', JSON.stringify(arr));
        this.downloadedTaskIds.add(taskId);
    },

    init() {
        this.loadPopular(this.currentCountry);
        this.updateFilesCount();
        this.startTasksPoller();
        this.initAudioPlayerEvents();

        const searchInput = document.getElementById('searchInput');
        const clearBtn = document.getElementById('clearSearchBtn');

        // Ricerca incrementale in tempo reale (live search su ogni digitazione)
        searchInput.addEventListener('input', () => {
            const val = searchInput.value;
            clearBtn.style.display = val ? 'block' : 'none';
            app.handleIncrementalSearch(val);
        });

        // Tasto Invio per ricerca immediata senza attendere il debounce
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                clearTimeout(app.searchDebounceTimer);
                app.handleSearch(true);
            }
        });
    },

    initAudioPlayerEvents() {
        const audio = document.getElementById('nativeAudioElement');
        if (!audio) return;

        const progressBar = document.getElementById('audioProgressBar');
        const currentTimeSpan = document.getElementById('audioCurrentTime');
        const totalDurationSpan = document.getElementById('audioTotalDuration');
        const playIcon = document.getElementById('audioPlayIcon');
        const pauseIcon = document.getElementById('audioPauseIcon');

        audio.addEventListener('timeupdate', () => {
            if (audio.duration && !isNaN(audio.duration)) {
                const percent = (audio.currentTime / audio.duration) * 100;
                if (progressBar) progressBar.value = percent;
                if (currentTimeSpan) currentTimeSpan.textContent = this.formatSeconds(audio.currentTime);
            }
        });

        audio.addEventListener('loadedmetadata', () => {
            if (totalDurationSpan && audio.duration && !isNaN(audio.duration)) {
                totalDurationSpan.textContent = this.formatSeconds(audio.duration);
            }
        });

        audio.addEventListener('play', () => {
            if (playIcon) playIcon.style.display = 'none';
            if (pauseIcon) pauseIcon.style.display = 'block';
            const eq = document.getElementById('audioEqualizer');
            if (eq) eq.classList.add('playing');
        });

        audio.addEventListener('pause', () => {
            if (playIcon) playIcon.style.display = 'block';
            if (pauseIcon) pauseIcon.style.display = 'none';
            const eq = document.getElementById('audioEqualizer');
            if (eq) eq.classList.remove('playing');
        });

        audio.addEventListener('ended', () => {
            if (playIcon) playIcon.style.display = 'block';
            if (pauseIcon) pauseIcon.style.display = 'none';
            if (progressBar) progressBar.value = 0;
            if (currentTimeSpan) currentTimeSpan.textContent = '0:00';
            const eq = document.getElementById('audioEqualizer');
            if (eq) eq.classList.remove('playing');
        });

        audio.addEventListener('error', (e) => {
            if (!audio.src || audio.src === window.location.href || audio.src.endsWith('/')) return;
            console.warn('Audio stream playback notice:', e);
        });
    },

    formatSeconds(sec) {
        if (!sec || isNaN(sec)) return '0:00';
        const total = Math.floor(sec);
        const m = Math.floor(total / 60);
        const s = total % 60;
        return `${m}:${s < 10 ? '0' : ''}${s}`;
    },

    // TOAST NOTIFICATIONS
    showToast(message, type = 'info') {
        const container = document.getElementById('toastContainer');
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        
        let icon = 'ℹ️';
        if (type === 'success') icon = '✓';
        if (type === 'error') icon = '⚠️';

        toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
        container.appendChild(toast);

        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(10px)';
            setTimeout(() => toast.remove(), 300);
        }, 4000);
    },

    // NAVIGATION VIEW SWITCHING
    switchView(viewName) {
        if (viewName !== 'details') {
            this.previousView = viewName;
        }

        const sections = ['popularSection', 'searchSection', 'detailsSection', 'filesSection'];
        sections.forEach(secId => {
            const el = document.getElementById(secId);
            if (el) el.style.display = 'none';
        });

        const targetEl = document.getElementById(`${viewName}Section`);
        if (targetEl) targetEl.style.display = 'block';

        // Update nav buttons
        document.getElementById('navPopularBtn').classList.toggle('active', viewName === 'popular');
        document.getElementById('navFilesBtn').classList.toggle('active', viewName === 'files');

        this.currentView = viewName;
        window.scrollTo({ top: 0, behavior: 'smooth' });
    },

    showPopular() {
        this.resetPreviewPlayer();
        this.switchView('popular');
    },

    showFiles() {
        this.resetPreviewPlayer();
        this.switchView('files');
        this.renderActiveTasksSection();
    },

    goBackFromDetails() {
        this.resetPreviewPlayer();
        if (this.previousView === 'search') {
            this.switchView('search');
        } else {
            this.showPopular();
        }
    },

    // POPULAR CHARTS
    changeCountry(country) {
        this.currentCountry = country;
        document.querySelectorAll('.pill-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.country === country);
        });
        this.loadPopular(country);
    },

    async loadPopular(country = 'IT') {
        const grid = document.getElementById('popularGrid');
        const loading = document.getElementById('popularLoading');

        grid.innerHTML = '';
        loading.style.display = 'block';

        try {
            const res = await fetch(`/api/popular?country=${country}`);
            const data = await res.json();

            loading.style.display = 'none';
            if (data.success && data.tracks && data.tracks.length > 0) {
                this.renderCards(grid, data.tracks);
            } else {
                grid.innerHTML = `<div class="empty-state"><p>Nessuna canzone popolare trovata al momento.</p></div>`;
            }
        } catch (err) {
            loading.style.display = 'none';
            grid.innerHTML = `<div class="empty-state"><p>Errore nel caricamento delle classifiche.</p></div>`;
            this.showToast('Errore di connessione al server', 'error');
        }
    },

    // SEARCH & INCREMENTAL SEARCH
    clearSearch() {
        clearTimeout(this.searchDebounceTimer);
        if (this.searchAbortController) {
            this.searchAbortController.abort();
        }
        const input = document.getElementById('searchInput');
        input.value = '';
        document.getElementById('clearSearchBtn').style.display = 'none';
        const spinner = document.getElementById('searchSpinner');
        if (spinner) spinner.style.display = 'none';
        this.showPopular();
        input.focus();
    },

    quickSearch(term) {
        clearTimeout(this.searchDebounceTimer);
        const input = document.getElementById('searchInput');
        input.value = term;
        document.getElementById('clearSearchBtn').style.display = 'block';
        this.handleSearch(true);
    },

    handleIncrementalSearch(val) {
        clearTimeout(this.searchDebounceTimer);
        const query = val.trim();

        if (!query) {
            if (this.searchAbortController) {
                this.searchAbortController.abort();
            }
            const spinner = document.getElementById('searchSpinner');
            if (spinner) spinner.style.display = 'none';
            if (this.currentView === 'search') {
                this.showPopular();
            }
            return;
        }

        if (query.length >= 3 || query.startsWith('http')) {
            const spinner = document.getElementById('searchSpinner');
            if (spinner) spinner.style.display = 'block';

            this.searchDebounceTimer = setTimeout(() => {
                this.handleSearch(false);
            }, 320);
        }
    },

    async handleSearch(isImmediate = false) {
        clearTimeout(this.searchDebounceTimer);
        const query = document.getElementById('searchInput').value.trim();
        if (!query) return;

        if (this.searchAbortController) {
            this.searchAbortController.abort();
        }
        this.searchAbortController = new AbortController();
        const currentSeq = ++this.searchSeq;

        this.switchView('search');
        const grid = document.getElementById('searchResultsGrid');
        const loading = document.getElementById('searchLoading');
        const queryLabel = document.getElementById('searchQueryLabel');
        const countLabel = document.getElementById('searchCountLabel');
        const spinner = document.getElementById('searchSpinner');

        queryLabel.textContent = `"${query}"`;
        countLabel.textContent = 'Ricerca in corso...';

        if (!grid.children.length) {
            loading.style.display = 'block';
        }
        if (spinner) spinner.style.display = 'block';

        try {
            const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
                signal: this.searchAbortController.signal
            });
            const data = await res.json();

            if (currentSeq !== this.searchSeq) return;

            loading.style.display = 'none';
            if (spinner) spinner.style.display = 'none';

            if (data.success && data.items && data.items.length > 0) {
                countLabel.textContent = `${data.items.length} corrispondenze trovate`;
                this.renderCards(grid, data.items);

                if (data.resolved === 'spotify') {
                    this.showToast(`Link Spotify riconosciuto: ${data.spotify_info?.title}`, 'success');
                }
            } else {
                countLabel.textContent = '0 corrispondenze';
                grid.innerHTML = `
                    <div class="empty-state" style="grid-column: 1 / -1;">
                        <h3>Nessun risultato trovato</h3>
                        <p>Prova a cercare con altri termini o incolla direttamente il link di YouTube o Spotify.</p>
                    </div>
                `;
            }
        } catch (err) {
            if (err.name === 'AbortError') return;
            if (currentSeq !== this.searchSeq) return;

            loading.style.display = 'none';
            if (spinner) spinner.style.display = 'none';
            countLabel.textContent = 'Errore di ricerca';
            grid.innerHTML = `<div class="empty-state" style="grid-column: 1 / -1;"><p>Errore durante la ricerca.</p></div>`;
            this.showToast('Errore durante la ricerca', 'error');
        }
    },

    // RENDER SONG CARDS
    renderCards(container, items) {
        container.innerHTML = '';
        items.forEach((item) => {
            const card = document.createElement('div');
            card.className = 'song-card';
            card.onclick = () => this.openDetails(item.id);

            const rankBadge = item.rank ? `<div class="card-rank-badge">#${item.rank}</div>` : '';
            const duration = item.duration ? `<div class="card-duration-badge">${item.duration}</div>` : '';
            const viewsText = item.views ? `<span class="card-views">${item.views}</span>` : '';

            card.innerHTML = `
                <div class="card-thumb-wrapper">
                    <img class="card-thumb" src="${item.thumbnail}" alt="${item.title}" loading="lazy" onerror="this.src='https://i.ytimg.com/vi/${item.id}/hqdefault.jpg'" />
                    ${rankBadge}
                    ${duration}
                    <div class="card-play-overlay">
                        <div class="play-circle">
                            <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                                <polygon points="5 3 19 12 5 21 5 3"></polygon>
                            </svg>
                        </div>
                    </div>
                </div>
                <div class="card-info">
                    <h3 class="card-title" title="${item.title}">${item.title}</h3>
                    <p class="card-artist" title="${item.artist}">${item.artist}</p>
                    ${viewsText}
                </div>
            `;
            container.appendChild(card);
        });
    },

    // SMART MULTI-MODE PREVIEW PLAYER (ANTI-VPN / ZERO RESTRIZIONI)
    resetPreviewPlayer() {
        const container = document.getElementById('previewEmbedContainer');
        const audio = document.getElementById('nativeAudioElement');
        const iframeYt = document.getElementById('previewIframe');
        const iframeProxy = document.getElementById('proxyVideoIframe');
        const btnText = document.getElementById('togglePlayerBtnText');
        const progressBar = document.getElementById('audioProgressBar');
        const currentTimeSpan = document.getElementById('audioCurrentTime');

        if (audio) {
            audio.pause();
            audio.src = '';
        }
        if (iframeYt) iframeYt.src = '';
        if (iframeProxy) iframeProxy.src = '';

        if (progressBar) progressBar.value = 0;
        if (currentTimeSpan) currentTimeSpan.textContent = '0:00';

        if (container) container.style.display = 'none';
        if (btnText) btnText.textContent = 'Ascolta Anteprima';
        const toggleBtn = document.getElementById('togglePlayerBtn');
        if (toggleBtn) toggleBtn.classList.remove('active');
        const eq = document.getElementById('audioEqualizer');
        if (eq) eq.classList.remove('playing');

        this.currentAudioUrl = null;
        this.currentEmbedUrl = null;
        this.currentProxyUrl = null;
    },

    togglePreviewPlayer() {
        const container = document.getElementById('previewEmbedContainer');
        const btnText = document.getElementById('togglePlayerBtnText');
        const toggleBtn = document.getElementById('togglePlayerBtn');
        if (!container) return;

        const isHidden = container.style.display === 'none' || !container.style.display;

        if (isHidden) {
            container.style.display = 'block';
            if (btnText) btnText.textContent = 'Chiudi Anteprima';
            if (toggleBtn) toggleBtn.classList.add('active');
            this.switchPlayerTab(this.activePlayerTab || 'audio');
            container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } else {
            this.resetPreviewPlayer();
        }
    },

    switchPlayerTab(tabName) {
        this.activePlayerTab = tabName;

        const tabs = ['tabAudioDirect', 'tabVideoYt', 'tabVideoProxy'];
        tabs.forEach(id => {
            const btn = document.getElementById(id);
            if (btn) btn.classList.remove('active');
        });

        const panes = ['playerViewAudio', 'playerViewYt', 'playerViewProxy'];
        panes.forEach(id => {
            const p = document.getElementById(id);
            if (p) p.style.display = 'none';
        });

        const audio = document.getElementById('nativeAudioElement');
        const iframeYt = document.getElementById('previewIframe');
        const iframeProxy = document.getElementById('proxyVideoIframe');

        if (tabName === 'audio') {
            const btn = document.getElementById('tabAudioDirect');
            const pane = document.getElementById('playerViewAudio');
            if (btn) btn.classList.add('active');
            if (pane) pane.style.display = 'block';

            // Ferma video se attivi
            if (iframeYt) iframeYt.src = '';
            if (iframeProxy) iframeProxy.src = '';

            // Avvia audio stream se non impostato
            if (audio && this.currentAudioUrl && audio.src !== window.location.origin + this.currentAudioUrl && !audio.src.endsWith(this.currentAudioUrl)) {
                audio.src = this.currentAudioUrl;
                audio.play().catch(e => console.log('Autoplay audio deferred:', e));
            }
        } else if (tabName === 'video-yt') {
            const btn = document.getElementById('tabVideoYt');
            const pane = document.getElementById('playerViewYt');
            if (btn) btn.classList.add('active');
            if (pane) pane.style.display = 'block';

            if (audio) audio.pause();
            if (iframeProxy) iframeProxy.src = '';

            if (iframeYt && this.currentEmbedUrl && iframeYt.src !== this.currentEmbedUrl) {
                iframeYt.src = this.currentEmbedUrl;
            }
        } else if (tabName === 'video-proxy') {
            const btn = document.getElementById('tabVideoProxy');
            const pane = document.getElementById('playerViewProxy');
            if (btn) btn.classList.add('active');
            if (pane) pane.style.display = 'block';

            if (audio) audio.pause();
            if (iframeYt) iframeYt.src = '';

            if (iframeProxy && this.currentProxyUrl && iframeProxy.src !== this.currentProxyUrl) {
                iframeProxy.src = this.currentProxyUrl;
            }
        }
    },

    toggleNativeAudio() {
        const audio = document.getElementById('nativeAudioElement');
        if (!audio) return;

        if (!audio.src && this.currentAudioUrl) {
            audio.src = this.currentAudioUrl;
        }

        if (audio.paused) {
            audio.play().catch(e => {
                console.warn('Playback error:', e);
                this.showToast('Avvio streaming in corso...', 'info');
            });
        } else {
            audio.pause();
        }
    },

    seekNativeAudio(percentVal) {
        const audio = document.getElementById('nativeAudioElement');
        if (!audio || !audio.duration) return;
        audio.currentTime = (parseFloat(percentVal) / 100) * audio.duration;
    },

    // OPEN SONG DETAILS VIEW
    async openDetails(videoId) {
        this.switchView('details');
        const loading = document.getElementById('detailsLoading');
        const card = document.getElementById('detailsCard');
        const progressBox = document.getElementById('downloadProgressBox');

        loading.style.display = 'block';
        card.style.display = 'none';
        progressBox.style.display = 'none';
        document.getElementById('progressSuccessActions').style.display = 'none';

        this.resetPreviewPlayer();
        this.currentDetailTaskId = null;

        try {
            const res = await fetch(`/api/details/${videoId}`);
            const json = await res.json();

            loading.style.display = 'none';

            if (!json.success || !json.data) {
                this.showToast('Impossibile caricare i dettagli del brano', 'error');
                this.goBackFromDetails();
                return;
            }

            const data = json.data;
            this.currentTrack = data;

            // Salva URL player multi-mode
            this.currentAudioUrl = data.direct_audio_url || `/api/preview/audio/${data.id}`;
            this.currentEmbedUrl = data.embed_url || `https://www.youtube.com/embed/${data.id}?autoplay=1&enablejsapi=1&rel=0`;
            this.currentProxyUrl = data.proxy_video_url || `https://yewtu.be/embed/${data.id}`;

            const totalDurationSpan = document.getElementById('audioTotalDuration');
            if (totalDurationSpan) totalDurationSpan.textContent = data.duration || '0:00';
            const audioTrackTitle = document.getElementById('audioTrackTitle');
            if (audioTrackTitle) audioTrackTitle.textContent = data.title;
            const ytExternalLink = document.getElementById('ytExternalLink');
            if (ytExternalLink) ytExternalLink.href = `https://www.youtube.com/watch?v=${data.id}`;

            // Popola i dettagli della scheda
            card.style.display = 'block';
            document.getElementById('detailTitle').textContent = data.title;
            document.getElementById('detailArtistName').textContent = data.artist || data.uploader;
            document.getElementById('detailDuration').textContent = data.duration;
            document.getElementById('detailViews').textContent = data.views || 'Non disponibile';

            // Copertina e bagliore
            const coverImg = document.getElementById('detailCover');
            coverImg.src = data.thumbnail;
            coverImg.onerror = () => { coverImg.src = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`; };
            document.getElementById('detailCoverGlow').style.backgroundImage = `url('${data.thumbnail}')`;

            // Badge risoluzione massima
            document.getElementById('detailMaxVideoRes').textContent = `Massima Risoluzione (${data.max_video_quality})`;

            // Rilevamento Video Ufficiale (Fix copertina statica)
            const offBadgeWrapper = document.getElementById('officialVideoBadgeWrapper');
            const offNote = document.getElementById('officialVideoNote');
            const mp4BtnText = document.getElementById('downloadMp4BtnText');

            if (data.is_art_track && data.has_official_video) {
                offBadgeWrapper.style.display = 'block';
                offNote.style.display = 'block';
                mp4BtnText.textContent = 'Scarica Video Ufficiale (MP4 HD)';
            } else if (!data.is_art_track) {
                offBadgeWrapper.style.display = 'none';
                offNote.style.display = 'none';
                mp4BtnText.textContent = 'Scarica Filmato Video (MP4)';
            } else {
                offBadgeWrapper.style.display = 'none';
                offNote.style.display = 'block';
                offNote.textContent = 'Traccia audio originale fornita con copertina alta risoluzione.';
                mp4BtnText.textContent = 'Scarica Filmato Video (MP4)';
            }

            // Album
            const albumWrapper = document.getElementById('metaAlbumWrapper');
            if (data.album) {
                albumWrapper.style.display = 'flex';
                document.getElementById('detailAlbum').textContent = data.album;
            } else {
                albumWrapper.style.display = 'none';
            }

            // Data pubblicazione
            const dateWrapper = document.getElementById('metaDateWrapper');
            if (data.upload_date) {
                dateWrapper.style.display = 'flex';
                document.getElementById('detailDate').textContent = data.upload_date;
            } else {
                dateWrapper.style.display = 'none';
            }

            // Se c'è già un task attivo o in coda per questa canzone, aggancialo alla barra di avanzamento
            this.syncDetailsTaskWithActive();

        } catch (err) {
            loading.style.display = 'none';
            this.showToast('Errore di connessione durante il recupero dei dettagli', 'error');
            this.goBackFromDetails();
        }
    },

    // START DOWNLOAD (MP3 OR MP4) CON CODA SEQUENZIALE
    async startDownload(format) {
        if (!this.currentTrack) return;

        const mp3Btn = document.getElementById('downloadMp3Btn');
        const mp4Btn = document.getElementById('downloadMp4Btn');
        const progressBox = document.getElementById('downloadProgressBox');
        const progressBar = document.getElementById('progressBarFill');
        const percentText = document.getElementById('progressPercentText');
        const statusText = document.getElementById('progressStatusText');
        const queueBadge = document.getElementById('progressQueueBadge');
        const successActions = document.getElementById('progressSuccessActions');

        mp3Btn.disabled = true;
        mp4Btn.disabled = true;
        progressBox.style.display = 'block';
        successActions.style.display = 'none';
        if (queueBadge) queueBadge.style.display = 'none';

        progressBar.style.width = '5%';
        percentText.textContent = '5%';
        statusText.textContent = format === 'mp3' ? 'Avvio estrazione audio MP3 a 320 kbps...' : 'Avvio download video MP4 in massima qualità...';
        progressBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

        try {
            const clientId = this.getClientId();
            const payload = {
                id_or_url: this.currentTrack.id,
                format: format,
                title: this.currentTrack.title,
                artist: this.currentTrack.artist,
                thumbnail: this.currentTrack.thumbnail,
                official_video_id: this.currentTrack.official_video_id || null,
                client_id: clientId
            };

            const res = await fetch('/api/download', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const data = await res.json();
            if (data.success && data.task_id) {
                this.currentDetailTaskId = data.task_id;
                this.addMyInitiatedTask(data.task_id); // Registra che QUESTO dispositivo ha avviato il download

                if (data.status === 'queued') {
                    this.showToast(`⏳ Messo in coda (posizione #${data.queue_position})! Inizierà in sequenza.`, 'info');
                } else {
                    this.showToast(`Download avviato! Controllalo in "I Miei Download"`, 'info');
                }
                this.pollActiveTasks();
            } else {
                throw new Error('Errore durante l\'avvio dell\'elaborazione');
            }
        } catch (err) {
            mp3Btn.disabled = false;
            mp4Btn.disabled = false;
            statusText.textContent = 'Errore durante l\'avvio del download.';
            this.showToast('Errore avvio download', 'error');
        }
    },

    // GLOBAL TASKS POLLER (IN BACKGROUND PER GESTIRE CODA, DISPOSITIVO E NOTIFICHE)
    startTasksPoller() {
        if (this.tasksPollerTimer) clearInterval(this.tasksPollerTimer);
        this.pollActiveTasks();
        this.tasksPollerTimer = setInterval(() => {
            this.pollActiveTasks();
        }, 1100);
    },

    async pollActiveTasks() {
        try {
            const clientId = this.getClientId();
            const res = await fetch(`/api/tasks?client_id=${encodeURIComponent(clientId)}`);
            const data = await res.json();
            if (!data.success || !data.tasks) return;

            const tasks = data.tasks;
            this.activeTasks.clear();
            tasks.forEach(t => this.activeTasks.set(t.task_id, t));

            // Filtro task attivi o in coda per questo client
            const activeOnly = tasks.filter(t => ['starting', 'downloading', 'converting', 'tagging', 'pending', 'paused', 'queued'].includes(t.status));
            const queuedCount = activeOnly.filter(t => t.status === 'queued').length;
            const inProgressCount = activeOnly.length - queuedCount;

            // 1. Badge mobile compatto galleggiante sull'icona (Nessuna sovrapposizione su smartphone!)
            const liveBadge = document.getElementById('navLiveBadge');
            if (liveBadge) {
                if (activeOnly.length > 0) {
                    liveBadge.style.display = 'flex';
                    liveBadge.textContent = activeOnly.length;
                } else {
                    liveBadge.style.display = 'none';
                }
            }

            // 2. Indicatore esteso Desktop
            const liveIndicatorDesktop = document.getElementById('navLiveIndicatorDesktop');
            const liveTextDesktop = document.getElementById('navLiveTextDesktop');
            if (liveIndicatorDesktop && liveTextDesktop) {
                if (activeOnly.length > 0) {
                    liveIndicatorDesktop.style.display = 'inline-flex';
                    if (queuedCount > 0 && inProgressCount > 0) {
                        liveTextDesktop.textContent = `${inProgressCount} in corso (${queuedCount} in coda)`;
                    } else if (queuedCount > 0) {
                        liveTextDesktop.textContent = `${queuedCount} in coda`;
                    } else {
                        liveTextDesktop.textContent = `${inProgressCount} in corso`;
                    }
                } else {
                    liveIndicatorDesktop.style.display = 'none';
                }
            }

            // Se siamo nella vista "I Miei Download", aggiorna il pannello dei download in corso
            if (this.currentView === 'files') {
                this.renderActiveTasksSection();
            }

            // Sincronizza la vista dettagli se aperta
            if (this.currentView === 'details') {
                this.syncDetailsTaskWithActive();
            }

            // Notifica e trigger download:
            const myInitiated = this.getMyInitiatedTasks();
            const downloaded = this.getDownloadedTasks();

            tasks.forEach(t => {
                if (
                    t.status === 'finished' &&
                    myInitiated.has(t.task_id) &&
                    !downloaded.has(t.task_id) &&
                    !this.downloadedTaskIds.has(t.task_id) &&
                    !t.server_cleaned
                ) {
                    this.markTaskAsDownloaded(t.task_id);
                    this.showToast(`✓ Conversione completata: ${t.filename}`, 'success');

                    // Trigger salvataggio automatico diretto nel browser (Client-Side)
                    const triggerLink = document.createElement('a');
                    triggerLink.href = `/api/download/file/${t.task_id}`;
                    triggerLink.download = t.filename;
                    document.body.appendChild(triggerLink);
                    triggerLink.click();
                    document.body.removeChild(triggerLink);
                    this.showToast(`✓ File inviato al browser e salvato sul tuo dispositivo: ${t.filename}`, 'success');

                    if (this.currentView === 'files') {
                        this.renderActiveTasksSection();
                    }
                }
            });

        } catch (err) {
            console.error('Error polling tasks:', err);
        }
    },

    // RENDER DOWNLOAD E CODA SEQUENZIALE IN "I MIEI DOWNLOAD"
    renderActiveTasksSection() {
        const wrapper = document.getElementById('activeDownloadsWrapper');
        const countSpan = document.getElementById('activeDownloadsCount');
        const container = document.getElementById('activeTasksListContainer');
        if (!wrapper || !container) return;

        const tasks = Array.from(this.activeTasks.values());
        // Mostra task attivi, in coda o in pausa
        const relevantTasks = tasks.filter(t => ['starting', 'downloading', 'converting', 'tagging', 'pending', 'paused', 'queued'].includes(t.status));

        if (!relevantTasks.length) {
            wrapper.style.display = 'none';
            container.innerHTML = '';
            return;
        }

        wrapper.style.display = 'block';
        if (countSpan) countSpan.textContent = relevantTasks.length;
        container.innerHTML = '';

        relevantTasks.forEach(task => {
            const card = document.createElement('div');
            card.className = 'active-task-card';

            const isMp3 = task.format === 'mp3';
            let fmtClass = isMp3 ? 'fmt-mp3' : 'fmt-mp4';
            let fmtLabel = isMp3 ? 'MP3 320K' : 'MP4 VIDEO';
            const progress = Math.round(task.progress || 0);

            let statusLabel = 'In preparazione...';
            let barModifier = '';
            let barWidth = `${progress}%`;

            if (task.status === 'queued') {
                fmtClass = 'fmt-queued';
                fmtLabel = `IN CODA (#${task.queue_position || 1})`;
                statusLabel = `⏳ In coda (Posizione #${task.queue_position || 1}) - Inizierà al termine del file attuale`;
                barModifier = 'bar-queued';
                barWidth = '100%';
            } else if (task.status === 'downloading') {
                statusLabel = `Scaricamento stream (${progress}%)`;
            } else if (task.status === 'paused') {
                statusLabel = `In Pausa (${progress}%)`;
                barModifier = 'bar-paused';
            } else if (task.status === 'converting') {
                statusLabel = isMp3 ? 'Conversione audio a 320 kbps con FFmpeg...' : 'Fusione video HD e audio Hi-Fi...';
            } else if (task.status === 'tagging') {
                statusLabel = 'Applicazione tag ID3 e copertina...';
            }

            const speedEta = task.status === 'queued'
                ? `<span>In attesa del proprio turno in sequenza...</span>`
                : (task.speed || task.eta)
                    ? `<span>Velocità: ${task.speed || '--'} | Tempo: ${task.eta || '--'}</span>`
                    : `<span>${statusLabel}</span>`;

            // Action buttons
            let actionButtonsHtml = '';
            if (task.status === 'queued') {
                actionButtonsHtml += `
                    <button class="task-ctrl-btn cancel-ctrl" onclick="app.cancelTask('${task.task_id}')">
                        ⏹️ Rimuovi dalla Coda
                    </button>
                `;
            } else if (['downloading', 'starting', 'pending'].includes(task.status)) {
                actionButtonsHtml += `
                    <button class="task-ctrl-btn pause-ctrl" onclick="app.pauseTask('${task.task_id}')">
                        ⏸️ Metti in Pausa
                    </button>
                    <button class="task-ctrl-btn cancel-ctrl" onclick="app.cancelTask('${task.task_id}')">
                        ⏹️ Annulla & Libera Memoria
                    </button>
                `;
            } else if (task.status === 'paused') {
                actionButtonsHtml += `
                    <button class="task-ctrl-btn resume-ctrl" onclick="app.resumeTask('${task.task_id}')">
                        ▶️ Riprendi Download
                    </button>
                    <button class="task-ctrl-btn cancel-ctrl" onclick="app.cancelTask('${task.task_id}')">
                        ⏹️ Annulla & Libera Memoria
                    </button>
                `;
            } else if (task.status === 'finished') {
                actionButtonsHtml += `
                    <span class="task-saved-badge">✓ Salvato sul tuo dispositivo</span>
                    <button class="task-ctrl-btn dismiss-ctrl" onclick="app.dismissTask('${task.task_id}')">
                        ✕ Rimuovi
                    </button>
                `;
            } else if (['cancelled', 'error'].includes(task.status)) {
                actionButtonsHtml += `
                    <button class="task-ctrl-btn dismiss-ctrl" onclick="app.dismissTask('${task.task_id}')">
                        ✕ Rimuovi
                    </button>
                `;
            }

            const progressDisplay = task.status === 'queued' ? 'In coda' : `${progress}%`;

            card.innerHTML = `
                <div class="active-task-header">
                    <img class="active-task-thumb" src="${task.thumbnail_url || '/static/icons/logo.png'}" onerror="this.src='/static/icons/logo.png'" />
                    <div class="active-task-info">
                        <div class="active-task-title-row">
                            <span class="active-task-title" title="${task.title}">${task.title}</span>
                            <span class="active-task-fmt ${fmtClass}">${fmtLabel}</span>
                        </div>
                        <span class="active-task-artist">${task.artist || 'Artista'}</span>
                    </div>
                </div>

                <div class="active-task-progress-box">
                    <div class="active-progress-track">
                        <div class="active-progress-bar ${barModifier}" style="width: ${barWidth};"></div>
                    </div>
                    <div class="active-task-meta-row">
                        ${speedEta}
                        <strong>${progressDisplay}</strong>
                    </div>
                </div>

                <div class="active-task-controls">
                    ${actionButtonsHtml}
                </div>
            `;

            container.appendChild(card);
        });
    },

    // SINCRONIZZAZIONE DELLA SCHEDA DETTAGLI CON I CONTROLLI DEL TASK E CODA
    syncDetailsTaskWithActive() {
        if (!this.currentTrack) return;
        const progressBox = document.getElementById('downloadProgressBox');
        if (!progressBox) return;

        let matchingTask = null;
        if (this.currentDetailTaskId && this.activeTasks.has(this.currentDetailTaskId)) {
            matchingTask = this.activeTasks.get(this.currentDetailTaskId);
        } else {
            for (const t of this.activeTasks.values()) {
                if (t.url_or_id === this.currentTrack.id && ['downloading', 'starting', 'paused', 'converting', 'tagging', 'queued'].includes(t.status)) {
                    matchingTask = t;
                    this.currentDetailTaskId = t.task_id;
                    break;
                }
            }
        }

        if (!matchingTask) return;

        progressBox.style.display = 'block';
        const progressBar = document.getElementById('progressBarFill');
        const percentText = document.getElementById('progressPercentText');
        const statusText = document.getElementById('progressStatusText');
        const queueBadge = document.getElementById('progressQueueBadge');
        const speedText = document.getElementById('progressSpeedText');
        const etaText = document.getElementById('progressEtaText');
        const successActions = document.getElementById('progressSuccessActions');
        const mp3Btn = document.getElementById('downloadMp3Btn');
        const mp4Btn = document.getElementById('downloadMp4Btn');
        const pauseBtn = document.getElementById('detailPauseBtn');
        const resumeBtn = document.getElementById('detailResumeBtn');
        const cancelBtn = document.getElementById('detailCancelBtn');

        progressBar.className = 'progress-bar-fill';

        if (matchingTask.status === 'queued') {
            if (queueBadge) {
                queueBadge.style.display = 'inline-flex';
                queueBadge.textContent = `⏳ In Coda (#${matchingTask.queue_position || 1})`;
            }
            statusText.textContent = `In coda: inizierà automaticamente al termine del download attuale.`;
            progressBar.classList.add('bar-queued');
            progressBar.style.width = '100%';
            percentText.textContent = 'In coda';
            speedText.textContent = `Posizione in coda: #${matchingTask.queue_position || 1}`;
            etaText.textContent = `Inizierà in sequenza`;
            pauseBtn.style.display = 'none';
            resumeBtn.style.display = 'none';
            cancelBtn.style.display = 'inline-flex';
            cancelBtn.innerHTML = `⏹️ Rimuovi dalla Coda`;
            mp3Btn.disabled = true;
            mp4Btn.disabled = true;
            return;
        }

        if (queueBadge) queueBadge.style.display = 'none';
        cancelBtn.innerHTML = `⏹️ Annulla & Libera Memoria`;

        const p = Math.round(matchingTask.progress || 0);
        progressBar.style.width = `${p}%`;
        percentText.textContent = `${p}%`;

        if (matchingTask.speed) speedText.textContent = `Velocità: ${matchingTask.speed}`;
        if (matchingTask.eta) etaText.textContent = `Tempo rimasto: ${matchingTask.eta}`;

        if (matchingTask.status === 'paused') {
            statusText.textContent = '⏸️ Download in pausa';
            pauseBtn.style.display = 'none';
            resumeBtn.style.display = 'inline-flex';
            cancelBtn.style.display = 'inline-flex';
            progressBar.classList.add('bar-paused');
        } else if (matchingTask.status === 'downloading') {
            statusText.textContent = 'Scaricamento stream da sorgente...';
            pauseBtn.style.display = 'inline-flex';
            resumeBtn.style.display = 'none';
            cancelBtn.style.display = 'inline-flex';
        } else if (matchingTask.status === 'converting') {
            statusText.textContent = matchingTask.format === 'mp3' ? 'Conversione audio a 320 kbps con FFmpeg...' : 'Fusione stream video e audio HD...';
            pauseBtn.style.display = 'none';
            resumeBtn.style.display = 'none';
        } else if (matchingTask.status === 'tagging') {
            statusText.textContent = 'Incorporamento tag ID3 e copertina nel file...';
            pauseBtn.style.display = 'none';
            resumeBtn.style.display = 'none';
        } else if (matchingTask.status === 'finished') {
            statusText.textContent = '✓ File pronto per l\'ascolto e il salvataggio!';
            successActions.style.display = 'block';
            pauseBtn.style.display = 'none';
            resumeBtn.style.display = 'none';
            cancelBtn.style.display = 'none';
            mp3Btn.disabled = false;
            mp4Btn.disabled = false;

            const browserDownloadBtn = document.getElementById('browserDownloadBtn');
            browserDownloadBtn.href = `/api/download/file/${matchingTask.task_id}`;
            browserDownloadBtn.setAttribute('download', matchingTask.filename);
        } else if (matchingTask.status === 'cancelled') {
            statusText.textContent = '⏹️ Download annullato. Memoria liberata.';
            pauseBtn.style.display = 'none';
            resumeBtn.style.display = 'none';
            cancelBtn.style.display = 'none';
            mp3Btn.disabled = false;
            mp4Btn.disabled = false;
        } else if (matchingTask.status === 'error') {
            statusText.textContent = `⚠️ Errore: ${matchingTask.error || 'Download fallito'}`;
            pauseBtn.style.display = 'none';
            resumeBtn.style.display = 'none';
            cancelBtn.style.display = 'none';
            mp3Btn.disabled = false;
            mp4Btn.disabled = false;
        }
    },

    // CONTROLLI TASK: PAUSA, RIPRENDI, ANNULLA, RIMUOVI
    async pauseTask(taskId) {
        try {
            const res = await fetch(`/api/task/${taskId}/pause`, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                this.showToast('Download messo in pausa', 'info');
                this.pollActiveTasks();
            } else {
                this.showToast(data.detail || 'Impossibile mettere in pausa', 'error');
            }
        } catch (err) {
            this.showToast('Errore di connessione', 'error');
        }
    },

    async resumeTask(taskId) {
        try {
            const res = await fetch(`/api/task/${taskId}/resume`, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                this.showToast('Download ripreso', 'success');
                this.pollActiveTasks();
            } else {
                this.showToast(data.detail || 'Impossibile riprendere', 'error');
            }
        } catch (err) {
            this.showToast('Errore di connessione', 'error');
        }
    },

    async cancelTask(taskId) {
        try {
            const res = await fetch(`/api/task/${taskId}/cancel`, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                this.showToast('Download annullato e memoria liberata', 'info');
                this.pollActiveTasks();
            } else {
                this.showToast(data.detail || 'Impossibile annullare', 'error');
            }
        } catch (err) {
            this.showToast('Errore durante l\'annullamento', 'error');
        }
    },

    async dismissTask(taskId) {
        try {
            await fetch(`/api/task/${taskId}`, { method: 'DELETE' });
            this.activeTasks.delete(taskId);
            this.pollActiveTasks();
        } catch (err) {}
    },

    async clearFinishedTasks() {
        for (const [taskId, task] of this.activeTasks.entries()) {
            if (['finished', 'cancelled', 'error'].includes(task.status)) {
                await this.dismissTask(taskId);
            }
        }
    },

    pauseCurrentTask() {
        if (this.currentDetailTaskId) {
            this.pauseTask(this.currentDetailTaskId);
        }
    },

    resumeCurrentTask() {
        if (this.currentDetailTaskId) {
            this.resumeTask(this.currentDetailTaskId);
        }
    },

    cancelCurrentTask() {
        if (this.currentDetailTaskId) {
            this.cancelTask(this.currentDetailTaskId);
        }
    },

    // DOWNLOADED FILES MANAGER
    async loadFiles() {
        const container = document.getElementById('filesListContainer');
        const loading = document.getElementById('filesLoading');
        const emptyState = document.getElementById('filesEmpty');
        const completedSpan = document.getElementById('completedFilesCount');

        if (!container) return;
        container.innerHTML = '';
        if (loading) loading.style.display = 'block';
        if (emptyState) emptyState.style.display = 'none';

        try {
            const res = await fetch('/api/files');
            const data = await res.json();

            if (loading) loading.style.display = 'none';

            if (data.success && data.files && data.files.length > 0) {
                this.renderFilesList(container, data.files);
                this.updateBadge(data.files.length);
                if (completedSpan) completedSpan.textContent = data.files.length;
            } else {
                if (emptyState) emptyState.style.display = 'block';
                this.updateBadge(0);
                if (completedSpan) completedSpan.textContent = '0';
            }
        } catch (err) {
            if (loading) loading.style.display = 'none';
            this.showToast('Errore recupero file scaricati', 'error');
        }
    },

    renderFilesList(container, files) {
        container.innerHTML = '';
        files.forEach(file => {
            const item = document.createElement('div');
            item.className = 'file-item-card';

            const isMp3 = file.format === 'mp3';
            const typeClass = isMp3 ? 'type-mp3' : 'type-mp4';
            const encodedName = encodeURIComponent(file.filename);

            const infoGroup = document.createElement('div');
            infoGroup.className = 'file-info-group';

            const iconDiv = document.createElement('div');
            iconDiv.className = `file-type-icon ${typeClass}`;
            iconDiv.textContent = file.format.toUpperCase();

            const metaDiv = document.createElement('div');
            metaDiv.className = 'file-meta';

            const titleDiv = document.createElement('div');
            titleDiv.className = 'file-title';
            titleDiv.title = file.filename;
            titleDiv.textContent = file.filename;

            const submetaDiv = document.createElement('div');
            submetaDiv.className = 'file-submeta';
            submetaDiv.innerHTML = `<span>📦 ${file.size_mb} MB</span> <span>🕒 ${file.created_at}</span>`;

            metaDiv.appendChild(titleDiv);
            metaDiv.appendChild(submetaDiv);
            infoGroup.appendChild(iconDiv);
            infoGroup.appendChild(metaDiv);

            const actionsDiv = document.createElement('div');
            actionsDiv.className = 'file-actions';

            const downloadLink = document.createElement('a');
            downloadLink.className = 'file-action-btn';
            downloadLink.href = `/api/files/download/${encodedName}`;
            downloadLink.download = file.filename;
            downloadLink.innerHTML = `
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                </svg>
                <span>Scarica</span>
            `;

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'file-action-btn delete-btn';
            deleteBtn.innerHTML = `
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"></path>
                </svg>
                <span>Elimina</span>
            `;
            deleteBtn.addEventListener('click', () => {
                app.deleteFile(file.filename);
            });

            actionsDiv.appendChild(downloadLink);
            actionsDiv.appendChild(deleteBtn);

            item.appendChild(infoGroup);
            item.appendChild(actionsDiv);
            container.appendChild(item);
        });
    },

    async deleteFile(filename) {
        if (!confirm(`Sei sicuro di voler eliminare "${filename}"?`)) return;

        try {
            const res = await fetch(`/api/files/${encodeURIComponent(filename)}`, { method: 'DELETE' });
            const data = await res.json();

            if (data.success) {
                this.showToast('File eliminato con successo', 'success');
                this.loadFiles();
                this.updateFilesCount();
            } else {
                this.showToast(data.detail || 'Impossibile eliminare il file', 'error');
            }
        } catch (err) {
            this.showToast('Errore durante l\'eliminazione', 'error');
        }
    },

    async deleteAllFiles() {
        if (!confirm('Sei sicuro di voler eliminare TUTTI i file salvati nella cartella download del server? L\'azione è irreversibile.')) return;

        try {
            const res = await fetch('/api/files', { method: 'DELETE' });
            const data = await res.json();

            if (data.success) {
                this.showToast(`Eliminati ${data.deleted_count} file con successo`, 'success');
                this.loadFiles();
                this.updateFilesCount();
            } else {
                this.showToast(data.detail || 'Errore durante la pulizia', 'error');
            }
        } catch (err) {
            this.showToast('Errore di connessione', 'error');
        }
    },

    async updateFilesCount() {
        try {
            const res = await fetch('/api/files');
            const data = await res.json();
            if (data.success) {
                this.updateBadge(data.count || 0);
            }
        } catch (err) {}
    },

    updateBadge(count) {
        const badge = document.getElementById('filesCountBadge');
        if (badge) badge.textContent = count;
    }
};

// Avvio applicazione al caricamento del DOM
document.addEventListener('DOMContentLoaded', () => {
    app.init();
});

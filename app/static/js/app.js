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

    init() {
        this.loadPopular(this.currentCountry);
        this.updateFilesCount();
        this.startTasksPoller();

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
        this.loadFiles();
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

    // RESET PREVIEW PLAYER
    resetPreviewPlayer() {
        const container = document.getElementById('previewEmbedContainer');
        const iframe = document.getElementById('previewIframe');
        const btn = document.getElementById('togglePlayerBtn');

        if (container) {
            container.style.display = 'none';
        }
        if (iframe) {
            iframe.src = '';
            iframe.dataset.embedUrl = '';
        }
        if (btn) {
            btn.innerHTML = `
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <polygon points="5 3 19 12 5 21 5 3"></polygon>
                </svg>
                <span>Ascolta Anteprima</span>
            `;
        }
    },

    // TOGGLE PREVIEW PLAYER
    togglePreviewPlayer() {
        const container = document.getElementById('previewEmbedContainer');
        const iframe = document.getElementById('previewIframe');
        const btn = document.getElementById('togglePlayerBtn');

        if (!container || !iframe || !btn) return;

        const isHidden = container.style.display === 'none' || !container.style.display;

        if (isHidden) {
            container.style.display = 'block';
            if (iframe.dataset.embedUrl) {
                iframe.src = iframe.dataset.embedUrl;
            }
            btn.innerHTML = `
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <rect x="6" y="4" width="4" height="16"/>
                    <rect x="14" y="4" width="4" height="16"/>
                </svg>
                <span>Chiudi Player</span>
            `;
        } else {
            container.style.display = 'none';
            iframe.src = '';
            btn.innerHTML = `
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <polygon points="5 3 19 12 5 21 5 3"></polygon>
                </svg>
                <span>Ascolta Anteprima</span>
            `;
        }
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

            // Assegna il link embed pulito al player
            document.getElementById('previewIframe').dataset.embedUrl = data.embed_url;

            // Se c'è già un task attivo per questa canzone, aggancialo alla barra di avanzamento
            this.syncDetailsTaskWithActive();

        } catch (err) {
            loading.style.display = 'none';
            this.showToast('Errore di connessione durante il recupero dei dettagli', 'error');
            this.goBackFromDetails();
        }
    },

    // START DOWNLOAD (MP3 OR MP4)
    async startDownload(format) {
        if (!this.currentTrack) return;

        const mp3Btn = document.getElementById('downloadMp3Btn');
        const mp4Btn = document.getElementById('downloadMp4Btn');
        const progressBox = document.getElementById('downloadProgressBox');
        const progressBar = document.getElementById('progressBarFill');
        const percentText = document.getElementById('progressPercentText');
        const statusText = document.getElementById('progressStatusText');
        const successActions = document.getElementById('progressSuccessActions');

        mp3Btn.disabled = true;
        mp4Btn.disabled = true;
        progressBox.style.display = 'block';
        successActions.style.display = 'none';
        progressBar.style.width = '5%';
        percentText.textContent = '5%';
        statusText.textContent = format === 'mp3' ? 'Avvio estrazione audio MP3 a 320 kbps...' : 'Avvio download video MP4 in massima qualità...';
        progressBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

        try {
            const payload = {
                id_or_url: this.currentTrack.id,
                format: format,
                title: this.currentTrack.title,
                artist: this.currentTrack.artist,
                thumbnail: this.currentTrack.thumbnail,
                official_video_id: this.currentTrack.official_video_id || null
            };

            const res = await fetch('/api/download', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const data = await res.json();
            if (data.success && data.task_id) {
                this.currentDetailTaskId = data.task_id;
                this.showToast(`Download avviato! Controllalo in "I Miei Download"`, 'info');
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

    // GLOBAL TASKS POLLER (IN BACKGROUND PER SINCRONIZZARE I MIEI DOWNLOAD E I BADGE)
    startTasksPoller() {
        if (this.tasksPollerTimer) clearInterval(this.tasksPollerTimer);
        this.pollActiveTasks();
        this.tasksPollerTimer = setInterval(() => {
            this.pollActiveTasks();
        }, 1100);
    },

    async pollActiveTasks() {
        try {
            const res = await fetch('/api/tasks');
            const data = await res.json();
            if (!data.success || !data.tasks) return;

            const tasks = data.tasks;
            this.activeTasks.clear();
            tasks.forEach(t => this.activeTasks.set(t.task_id, t));

            // Filtro task attivi/in corso
            const activeOnly = tasks.filter(t => ['starting', 'downloading', 'converting', 'tagging', 'pending', 'paused'].includes(t.status));

            // Aggiorna indicatore dinamico "in corso" nella Navbar accanto a "I Miei Download"
            const liveIndicator = document.getElementById('navLiveIndicator');
            const liveText = document.getElementById('navLiveText');
            if (liveIndicator && liveText) {
                if (activeOnly.length > 0) {
                    liveIndicator.style.display = 'inline-flex';
                    liveText.textContent = `${activeOnly.length} in corso`;
                } else {
                    liveIndicator.style.display = 'none';
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

            // Notifica e trigger download per task appena completati
            tasks.forEach(t => {
                if (t.status === 'finished' && !this.downloadedTaskIds.has(t.task_id)) {
                    this.downloadedTaskIds.add(t.task_id);
                    this.showToast(`✓ Download completato: ${t.filename}`, 'success');
                    this.updateFilesCount();

                    // Se siamo nella pagina dei download, aggiorna subito l'elenco dei file scaricati
                    if (this.currentView === 'files') {
                        this.loadFiles();
                    }

                    // Trigger salvataggio automatico nel browser
                    const encodedName = encodeURIComponent(t.filename);
                    const triggerLink = document.createElement('a');
                    triggerLink.href = `/api/files/download/${encodedName}`;
                    triggerLink.download = t.filename;
                    document.body.appendChild(triggerLink);
                    triggerLink.click();
                    document.body.removeChild(triggerLink);
                }
            });

        } catch (err) {
            console.error('Error polling tasks:', err);
        }
    },

    // RENDER DOWNLOAD IN CORSO ALL'INTERNO DELLA SEZIONE "I MIEI DOWNLOAD"
    renderActiveTasksSection() {
        const wrapper = document.getElementById('activeDownloadsWrapper');
        const countSpan = document.getElementById('activeDownloadsCount');
        const container = document.getElementById('activeTasksListContainer');
        if (!wrapper || !container) return;

        const tasks = Array.from(this.activeTasks.values());
        // Mostra task attivi, in pausa o appena completati
        const relevantTasks = tasks.filter(t => ['starting', 'downloading', 'converting', 'tagging', 'pending', 'paused'].includes(t.status));

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
            const fmtClass = isMp3 ? 'fmt-mp3' : 'fmt-mp4';
            const fmtLabel = isMp3 ? 'MP3 320K' : 'MP4 VIDEO';
            const progress = Math.round(task.progress || 0);

            let statusLabel = 'In preparazione...';
            let barModifier = '';
            if (task.status === 'downloading') {
                statusLabel = `Scaricamento stream (${progress}%)`;
            } else if (task.status === 'paused') {
                statusLabel = `In Pausa (${progress}%)`;
                barModifier = 'bar-paused';
            } else if (task.status === 'converting') {
                statusLabel = isMp3 ? 'Conversione audio a 320 kbps con FFmpeg...' : 'Fusione video HD e audio Hi-Fi...';
            } else if (task.status === 'tagging') {
                statusLabel = 'Applicazione tag ID3 e copertina...';
            }

            const speedEta = (task.speed || task.eta) ? `<span>Velocità: ${task.speed || '--'} | Tempo: ${task.eta || '--'}</span>` : `<span>${statusLabel}</span>`;

            // Action buttons
            let actionButtonsHtml = '';
            if (['downloading', 'starting', 'pending'].includes(task.status)) {
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
            }

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
                        <div class="active-progress-bar ${barModifier}" style="width: ${progress}%;"></div>
                    </div>
                    <div class="active-task-meta-row">
                        ${speedEta}
                        <strong>${progress}%</strong>
                    </div>
                </div>

                <div class="active-task-controls">
                    ${actionButtonsHtml}
                </div>
            `;

            container.appendChild(card);
        });
    },

    // SINCRONIZZAZIONE DELLA SCHEDA DETTAGLI CON I CONTROLLI DEL TASK
    syncDetailsTaskWithActive() {
        if (!this.currentTrack) return;
        const progressBox = document.getElementById('downloadProgressBox');
        if (!progressBox) return;

        let matchingTask = null;
        if (this.currentDetailTaskId && this.activeTasks.has(this.currentDetailTaskId)) {
            matchingTask = this.activeTasks.get(this.currentDetailTaskId);
        } else {
            for (const t of this.activeTasks.values()) {
                if (t.url_or_id === this.currentTrack.id && ['downloading', 'starting', 'paused', 'converting', 'tagging'].includes(t.status)) {
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
        const speedText = document.getElementById('progressSpeedText');
        const etaText = document.getElementById('progressEtaText');
        const successActions = document.getElementById('progressSuccessActions');
        const mp3Btn = document.getElementById('downloadMp3Btn');
        const mp4Btn = document.getElementById('downloadMp4Btn');
        const pauseBtn = document.getElementById('detailPauseBtn');
        const resumeBtn = document.getElementById('detailResumeBtn');
        const cancelBtn = document.getElementById('detailCancelBtn');

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
            const encodedName = encodeURIComponent(matchingTask.filename);
            browserDownloadBtn.href = `/api/files/download/${encodedName}`;
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

        container.innerHTML = '';
        loading.style.display = 'block';
        emptyState.style.display = 'none';

        try {
            const res = await fetch('/api/files');
            const data = await res.json();

            loading.style.display = 'none';

            if (data.success && data.files && data.files.length > 0) {
                this.renderFilesList(container, data.files);
                this.updateBadge(data.files.length);
                if (completedSpan) completedSpan.textContent = data.files.length;
            } else {
                emptyState.style.display = 'block';
                this.updateBadge(0);
                if (completedSpan) completedSpan.textContent = '0';
            }
        } catch (err) {
            loading.style.display = 'none';
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

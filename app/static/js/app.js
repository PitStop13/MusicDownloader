const app = {
    currentCountry: 'IT',
    currentView: 'popular',
    previousView: 'popular',
    currentTrack: null,
    pollInterval: null,
    searchDebounceTimer: null,
    searchAbortController: null,
    searchSeq: 0,

    init() {
        this.loadPopular(this.currentCountry);
        this.updateFilesCount();

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

        // Se la barra è vuota, torna automaticamente alla vista dei brani popolari
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

        // Se l'utente ha scritto almeno 3 caratteri (o ha incollato un link http)
        if (query.length >= 3 || query.startsWith('http')) {
            const spinner = document.getElementById('searchSpinner');
            if (spinner) spinner.style.display = 'block';

            // Debounce di 320ms per digitazione fluida senza sovraccaricare il server
            this.searchDebounceTimer = setTimeout(() => {
                this.handleSearch(false);
            }, 320);
        }
    },

    async handleSearch(isImmediate = false) {
        clearTimeout(this.searchDebounceTimer);
        const query = document.getElementById('searchInput').value.trim();
        if (!query) return;

        // Annulla eventuali chiamate precedenti ancora in volo
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

            // Ignora risposte di vecchie digitazioni superate
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
        items.forEach((item, index) => {
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

    // RESET PREVIEW PLAYER (FIX STATO E DOPPIO CLICK)
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
            iframe.src = ''; // stop immediato dell'audio
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

        // Reset completo dello stato e del player
        loading.style.display = 'block';
        card.style.display = 'none';
        progressBox.style.display = 'none';
        document.getElementById('progressSuccessActions').style.display = 'none';

        // Ripristina pulito il player anteprima (chiuso e tasto su 'Ascolta Anteprima')
        this.resetPreviewPlayer();

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

        // Disabilita pulsanti durante l'elaborazione
        mp3Btn.disabled = true;
        mp4Btn.disabled = true;
        progressBox.style.display = 'block';
        successActions.style.display = 'none';
        progressBar.style.width = '5%';
        percentText.textContent = '5%';
        statusText.textContent = format === 'mp3' ? 'Avvio estrazione audio MP3 a 320 kbps...' : 'Avvio download video MP4 in massima qualità...';
        progressBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

        try {
            const res = await fetch('/api/download', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id_or_url: this.currentTrack.id,
                    format: format,
                    title: this.currentTrack.title,
                    artist: this.currentTrack.artist,
                    thumbnail: this.currentTrack.thumbnail
                })
            });

            const data = await res.json();
            if (data.success && data.task_id) {
                this.pollTask(data.task_id, format);
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

    // POLL DOWNLOAD PROGRESS
    pollTask(taskId, format) {
        if (this.pollInterval) clearInterval(this.pollInterval);

        const mp3Btn = document.getElementById('downloadMp3Btn');
        const mp4Btn = document.getElementById('downloadMp4Btn');
        const progressBar = document.getElementById('progressBarFill');
        const percentText = document.getElementById('progressPercentText');
        const statusText = document.getElementById('progressStatusText');
        const speedText = document.getElementById('progressSpeedText');
        const etaText = document.getElementById('progressEtaText');
        const successActions = document.getElementById('progressSuccessActions');
        const browserDownloadBtn = document.getElementById('browserDownloadBtn');

        this.pollInterval = setInterval(async () => {
            try {
                const res = await fetch(`/api/task/${taskId}`);
                const data = await res.json();

                if (!data.success || !data.task) return;

                const task = data.task;
                const progress = task.progress || 0;
                progressBar.style.width = `${progress}%`;
                percentText.textContent = `${Math.round(progress)}%`;

                if (task.speed) speedText.textContent = `Velocità: ${task.speed}`;
                if (task.eta) etaText.textContent = `Tempo rimasto: ${task.eta}`;

                if (task.status === 'downloading') {
                    statusText.textContent = `Scaricamento stream da sorgente...`;
                } else if (task.status === 'converting') {
                    statusText.textContent = format === 'mp3' 
                        ? `Conversione audio a 320 kbps con FFmpeg...` 
                        : `Fusione video HD e traccia audio ad alta fedeltà...`;
                } else if (task.status === 'tagging') {
                    statusText.textContent = `Incorporamento tag ID3 e copertina nel file...`;
                } else if (task.status === 'finished') {
                    clearInterval(this.pollInterval);
                    progressBar.style.width = '100%';
                    percentText.textContent = '100%';
                    statusText.textContent = 'File pronto per l\'ascolto e il salvataggio!';
                    speedText.textContent = `Dimensione: ${(task.file_size / (1024 * 1024)).toFixed(2)} MB`;
                    etaText.textContent = `Completato`;

                    const encodedName = encodeURIComponent(task.filename);
                    const fileUrl = `/api/files/download/${encodedName}`;
                    browserDownloadBtn.href = fileUrl;
                    browserDownloadBtn.setAttribute('download', task.filename);

                    successActions.style.display = 'block';
                    mp3Btn.disabled = false;
                    mp4Btn.disabled = false;

                    this.showToast(`Download completato: ${task.filename}`, 'success');
                    this.updateFilesCount();

                    // Trigger salvataggio automatico nel browser
                    const triggerLink = document.createElement('a');
                    triggerLink.href = fileUrl;
                    triggerLink.download = task.filename;
                    document.body.appendChild(triggerLink);
                    triggerLink.click();
                    document.body.removeChild(triggerLink);
                } else if (task.status === 'error') {
                    clearInterval(this.pollInterval);
                    statusText.textContent = `Errore: ${task.error || 'Download fallito'}`;
                    mp3Btn.disabled = false;
                    mp4Btn.disabled = false;
                    this.showToast('Errore durante il download', 'error');
                }
            } catch (err) {
                console.error(err);
            }
        }, 900);
    },

    // DOWNLOADED FILES MANAGER
    async loadFiles() {
        const container = document.getElementById('filesListContainer');
        const loading = document.getElementById('filesLoading');
        const emptyState = document.getElementById('filesEmpty');

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
            } else {
                emptyState.style.display = 'block';
                this.updateBadge(0);
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

            item.innerHTML = `
                <div class="file-info-group">
                    <div class="file-type-icon ${typeClass}">
                        ${file.format.toUpperCase()}
                    </div>
                    <div class="file-meta">
                        <div class="file-title" title="${file.filename}">${file.filename}</div>
                        <div class="file-submeta">
                            <span>📦 ${file.size_mb} MB</span>
                            <span>🕒 ${file.created_at}</span>
                        </div>
                    </div>
                </div>
                <div class="file-actions">
                    <a class="file-action-btn" href="/api/files/download/${encodedName}" download="${file.filename}">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                        </svg>
                        <span>Scarica</span>
                    </a>
                    <button class="file-action-btn delete-btn" onclick="app.deleteFile('${file.filename}')">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                        <span>Elimina</span>
                    </button>
                </div>
            `;
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
            } else {
                this.showToast(data.detail || 'Impossibile eliminare il file', 'error');
            }
        } catch (err) {
            this.showToast('Errore durante l\'eliminazione', 'error');
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

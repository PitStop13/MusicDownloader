@echo off
title MusicDownloader - Docker App
echo ========================================================
echo        MusicDownloader - Avvio Applicazione Docker
echo ========================================================
echo.

REM Verifica se il comando docker esiste
where docker >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERRORE] Il comando 'docker' non e' installato o non e' nel PATH di sistema.
    echo Assicurati di aver installato Docker Desktop.
    pause
    exit /b 1
)

REM Verifica se il demone Docker e' attivo
docker info >nul 2>&1
if %ERRORLEVEL% EQU 0 goto DOCKER_READY

echo [!] Docker non sembra ancora attivo.
echo [*] Avvio di Docker Desktop in corso...

if exist "%LOCALAPPDATA%\Programs\DockerDesktop\Docker Desktop.exe" (
    start "" "%LOCALAPPDATA%\Programs\DockerDesktop\Docker Desktop.exe"
) else if exist "C:\Program Files\Docker\Docker\Docker Desktop.exe" (
    start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
)

echo [*] Attendo che Docker completi l'avvio...

:WAIT_LOOP
ping 127.0.0.1 -n 4 >nul
docker info >nul 2>&1
if %ERRORLEVEL% EQU 0 goto DOCKER_READY
echo [...] Ancora in attesa del servizio Docker...
goto WAIT_LOOP

:DOCKER_READY
echo [OK] Docker e' attivo e pronto!
echo [*] Costruzione e avvio del container MusicDownloader...
echo.

docker compose up --build -d

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERRORE] Impossibile avviare il container Docker.
    echo Controlla i log con: docker compose logs
    pause
    exit /b 1
)

echo.
echo ========================================================
echo  [OK] Applicazione avviata con successo!
echo  [*] Interfaccia Web: http://localhost:8000
echo  [*] Cartella download: .\downloads
echo ========================================================
echo.
echo Apertura del browser in corso...
ping 127.0.0.1 -n 3 >nul
start http://localhost:8000

echo.
echo Premi un tasto per chiudere questa finestra (il container continuera' a girare).
pause >nul

@echo off
title BrickFig Manager PRO - Server
echo ========================================
echo  BrickFig Manager PRO - Gestionale Lego
echo  Minifigure + Sfuso - AVG Usato BrickLink
echo ========================================
echo.
cd /d "C:\Users\gsimo\OneDrive\Documenti\Default Project"
echo Avvio server locale su http://localhost:3000 ...
start /min C:\Users\gsimo\AppData\Local\hermes\node\node.exe server.js
timeout /t 3 /nobreak >nul
echo Apertura gestionale in Google Chrome...
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" "http://localhost:3000"
echo.
echo Gestionale aperto in Chrome! NON chiudere questa finestra.
echo Il server rimane attivo per il gestionale.
echo Premi un tasto per FERMARE il server e chiudere.
echo.
pause
taskkill /f /im node.exe >nul 2>&1

@echo off
title BrickFig Manager PRO
echo Avvio server...
cd /d "C:\Users\gsimo\OneDrive\Documenti\Default Project"
start /min C:\Users\gsimo\AppData\Local\hermes\node\node.exe server.js
timeout /t 2 /nobreak >nul
echo Apro in Chrome...
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --app=http://localhost:3000
echo Fatto! Non chiudere questa finestra.
pause
taskkill /f /im node.exe >nul 2>&1

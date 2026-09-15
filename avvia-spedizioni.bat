@echo off
echo Avvio Spedizioni USA-Italia Express (sito separato)...
cd /d "%~dp0"
echo  - Sito spedizioni: http://localhost:3000/spedizioni
echo  - Gestionale LEGO: http://localhost:3000 (invariato)
echo.
if exist "C:\Users\gsimo\AppData\Local\hermes\node\node.exe" (
  C:\Users\gsimo\AppData\Local\hermes\node\node.exe server.js
) else (
  node server.js
)
pause

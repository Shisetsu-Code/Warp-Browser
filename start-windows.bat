@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 20+ es necesario. Instalar desde https://nodejs.org/ & pause & exit /b 1)
if not exist "node_modules\playwright" (
  echo Instalando Playwright...
  call npm install --no-audit --no-fund || (pause & exit /b 1)
)
echo Verificando Chromium...
call npx playwright install chromium || (pause & exit /b 1)
node src\index.js %*
if errorlevel 1 pause

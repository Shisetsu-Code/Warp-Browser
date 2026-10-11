@echo off
setlocal
cd /d "%~dp0"
node src\index.js --recover
if errorlevel 1 pause

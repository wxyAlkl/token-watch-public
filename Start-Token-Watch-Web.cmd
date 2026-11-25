@echo off
setlocal
cd /d "%~dp0"
if not defined TOKEN_WATCH_WEB_DATA_DIR set "TOKEN_WATCH_WEB_DATA_DIR=%USERPROFILE%\token-watch-data"
title Token Watch Web
node launcher.js --web --open
if errorlevel 1 pause

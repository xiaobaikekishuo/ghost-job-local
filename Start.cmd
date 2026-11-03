@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" server.mjs --open
) else (
  node server.mjs --open
)
if errorlevel 1 pause

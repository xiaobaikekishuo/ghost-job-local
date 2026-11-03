@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" server.mjs --simulate --open
) else (
  node server.mjs --simulate --open
)
if errorlevel 1 pause

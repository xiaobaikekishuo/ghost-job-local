@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" lib\stop.mjs
) else (
  node lib\stop.mjs
)
if errorlevel 1 pause

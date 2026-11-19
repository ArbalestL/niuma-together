@echo off
setlocal
"%~dp0runtime\node.exe" "%~dp0launch.mjs" --local
if errorlevel 1 pause

@echo off
rem Launches the Audio to text desktop app without showing a console window.
cd /d "%~dp0app"
if not exist node_modules\electron (
  echo Installing the app for the first time...
  call npm install
)
start "" /b "%~dp0app\node_modules\electron\dist\electron.exe" "%~dp0app"

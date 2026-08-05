@echo off
rem Fired by the "Ducat nightly backup" Windows scheduled task (DEPLOY.md,
rem "Scheduled local backups"). Runs from any working directory: the repo
rem root is this file's parent. The script does its own logging to
rem data\backups\backup.log, so nothing here needs redirecting.
set "PATH=C:\Program Files\nodejs;%PATH%"
cd /d "%~dp0.."
call npx tsx scripts/backup-scheduled.ts
exit /b %errorlevel%

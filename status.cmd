@echo off
REM KUDBEE one-command status (operator verify + AWS cost). Read-only, no secrets.
node "%~dp0os-agent\kudbee-status.mjs"

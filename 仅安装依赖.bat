@echo off
title Bakery System - Install Requirements
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 (
    set "PY_CMD=py -3"
) else (
    set "PY_CMD=python"
)

echo Installing requirements...
%PY_CMD% -m pip install --upgrade pip
%PY_CMD% -m pip install -r requirements.txt

echo.
echo Done.
pause

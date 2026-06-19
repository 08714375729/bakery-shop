@echo off
title Bakery System - Install and Start
cd /d "%~dp0"

echo ======================================
echo Bakery System - Install and Start
echo ======================================
echo Current folder:
echo %cd%
echo.

where py >nul 2>nul
if %errorlevel%==0 (
    set "PY_CMD=py -3"
) else (
    set "PY_CMD=python"
)

echo [1/3] Upgrade pip...
%PY_CMD% -m pip install --upgrade pip

echo.
echo [2/3] Install requirements...
%PY_CMD% -m pip install -r requirements.txt
if errorlevel 1 (
    echo.
    echo Failed to install requirements.
    echo Please check Python or network.
    pause
    exit /b 1
)

echo.
echo [3/3] Initialize DB and start server...
%PY_CMD% app.py initdb
if errorlevel 1 (
    echo.
    echo Failed to initialize database.
    pause
    exit /b 1
)

echo.
echo Open in browser:
echo http://127.0.0.1:5001/
echo.
%PY_CMD% app.py
pause

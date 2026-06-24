@echo off
REM Setup script for reputation system database (Windows)

echo ==========================================
echo VeriNode Reputation System - DB Setup
echo ==========================================
echo.

REM Database configuration
set DB_HOST=%TEST_DB_HOST%
if "%DB_HOST%"=="" set DB_HOST=localhost

set DB_PORT=%TEST_DB_PORT%
if "%DB_PORT%"=="" set DB_PORT=5432

set DB_USER=%TEST_DB_USER%
if "%DB_USER%"=="" set DB_USER=postgres

set DB_NAME=%TEST_DB_NAME%
if "%DB_NAME%"=="" set DB_NAME=verinode_test

echo Database Configuration:
echo   Host: %DB_HOST%
echo   Port: %DB_PORT%
echo   User: %DB_USER%
echo   Database: %DB_NAME%
echo.

echo Creating database if not exists...
psql -h %DB_HOST% -p %DB_PORT% -U %DB_USER% -c "CREATE DATABASE %DB_NAME%;" 2>nul
if errorlevel 1 (
    echo Database already exists or connection failed
) else (
    echo Database created successfully
)

echo.
echo Running reputation schema migration...
psql -h %DB_HOST% -p %DB_PORT% -U %DB_USER% -d %DB_NAME% -f src\database\migrations\005_reputation_schema.sql

if errorlevel 1 (
    echo Migration failed!
    exit /b 1
)

echo.
echo Verifying tables...
psql -h %DB_HOST% -p %DB_PORT% -U %DB_USER% -d %DB_NAME% -c "\dt reputation*"

echo.
echo ==========================================
echo Setup Complete!
echo ==========================================
echo.
echo Run tests with:
echo   npm run test:reputation
echo.
echo Or directly (after fixing execution policy):
echo   npx ts-node tests/reputation_scoreService.test.ts
echo.
echo To fix PowerShell execution policy:
echo   Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
echo.

pause

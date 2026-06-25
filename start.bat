@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [エラー] Node.js が見つかりません。
  echo https://nodejs.org/ja から LTS版をインストールしてから、もう一度このファイルをダブルクリックしてください。
  echo.
  pause
  exit /b 1
)

if not exist ".env" (
  echo.
  echo [初回設定] .env がありません。.env.example をコピーして .env を作り、API情報を記入してください。
  echo.
  copy ".env.example" ".env" >nul
  echo .env を作成しました。メモ帳で開いて値を埋めてから、もう一度起動してください。
  notepad ".env"
  pause
  exit /b 0
)

echo ブラウザを開きます...
start "" "http://localhost:7700"
node --use-system-ca server.js
pause

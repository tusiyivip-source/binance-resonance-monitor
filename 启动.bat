@echo off
chcp 65001 >nul
title 币安多级别共振盯盘系统
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装 Node 22 或更高版本。
  pause
  exit /b 1
)

echo ============================================
echo   币安多级别共振盯盘系统
echo   面板地址： http://127.0.0.1:8848
echo   关闭本窗口即停止服务
echo ============================================
echo.

start "" http://127.0.0.1:8848
node server.js

echo.
echo 服务已退出。
pause

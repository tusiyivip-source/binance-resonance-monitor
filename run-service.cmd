@echo off
cd /d "K:\±Ò\binance-monitor"
if not exist "data" mkdir "data"
echo. >> "data\service.log"
echo ================ %date% %time% start ================ >> "data\service.log"
"K:\NODEÈí¼þ\node.exe" server.js >> "data\service.log" 2>&1
echo [%date% %time%] exit code %errorlevel% >> "data\service.log"
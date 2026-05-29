@echo off
setlocal EnableDelayedExpansion
title Global Thought Stream - Installer
chcp 65001 >nul 2>&1

cls
echo.
echo  =====================================================
echo    Global Thought Stream(TM)
echo    Sphinx Global Enterprises Corp
echo    One Thought. Every Language. Continuity Preserved.
echo  =====================================================
echo.

:: ── Check Node.js ──────────────────────────────────────────
echo [1/5] Checking Node.js...
where node >nul 2>&1
if %errorlevel% neq 0 (
  echo.
  echo  ERROR: Node.js not found.
  echo.
  echo  Download and install from: https://nodejs.org
  echo  Choose the LTS version, run the installer,
  echo  then double-click install.bat again.
  echo.
  pause
  exit /b 1
)
for /f "usebackq tokens=*" %%v in (`node --version`) do set NODE_FULL=%%v
echo  OK %NODE_FULL% found

:: ── Resolve script directory ───────────────────────────────
set "SCRIPT_DIR=%~dp0"
:: Remove trailing backslash
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "INSTALL_DIR=%SCRIPT_DIR%\gts-app"

:: ── Set up folder ──────────────────────────────────────────
echo.
echo [2/5] Setting up app folder...
if not exist "%INSTALL_DIR%" (
  mkdir "%INSTALL_DIR%"
  if %errorlevel% neq 0 (
    echo  ERROR: Cannot create folder: %INSTALL_DIR%
    echo  Try running as Administrator or choose a different location.
    pause
    exit /b 1
  )
)

:: Copy app files
if exist "%SCRIPT_DIR%\sphinx_global_unified_v2.html" (
  copy /Y "%SCRIPT_DIR%\sphinx_global_unified_v2.html" "%INSTALL_DIR%\" >nul
) else (
  echo  ERROR: Cannot find sphinx_global_unified_v2.html
  echo  Make sure install.bat is in the same folder as all app files.
  pause
  exit /b 1
)

if exist "%SCRIPT_DIR%\proxy-server-v2.js" (
  copy /Y "%SCRIPT_DIR%\proxy-server-v2.js" "%INSTALL_DIR%\" >nul
) else (
  echo  ERROR: Cannot find proxy-server-v2.js
  pause
  exit /b 1
)

:: Copy optional files if present
if exist "%SCRIPT_DIR%\setup.html"    copy /Y "%SCRIPT_DIR%\setup.html"    "%INSTALL_DIR%\" >nul 2>&1
if exist "%SCRIPT_DIR%\.env.example"  copy /Y "%SCRIPT_DIR%\.env.example"  "%INSTALL_DIR%\" >nul 2>&1

echo  OK App files copied to: %INSTALL_DIR%

:: ── Write package.json via Node (avoids cmd echo quirks) ────
echo.
echo [3/5] Installing dependencies...
echo  This takes 30-90 seconds on first run.
echo.

cd /d "%INSTALL_DIR%"

:: Use node to write package.json cleanly -- no cmd quoting issues
node -e "var fs=require('fs');fs.writeFileSync('package.json',JSON.stringify({name:'global-thought-stream',version:'1.0.0',description:'Global Thought Stream - Sphinx Global Enterprises Corp',main:'proxy-server-v2.js',scripts:{start:'node proxy-server-v2.js'},dependencies:{'better-sqlite3':'^9.4.3',cors:'^2.8.5',dotenv:'^16.4.5',express:'^4.21.1','form-data':'^4.0.0',multer:'^1.4.5-lts.1','node-fetch':'^3.3.2',stripe:'^16.3.0'}},null,2));"
if %errorlevel% neq 0 (
  echo  ERROR: Could not write package.json
  pause
  exit /b 1
)

:: Run npm install (show output so errors are visible)
call npm install
if %errorlevel% neq 0 (
  echo.
  echo  ERROR: npm install failed.
  echo.
  echo  Common causes:
  echo    - No internet connection
  echo    - Firewall or proxy blocking npm
  echo    - Antivirus blocking node_modules creation
  echo.
  echo  Try running: npm install
  echo  in folder:   %INSTALL_DIR%
  echo  If it works manually, re-run this installer.
  echo.
  pause
  exit /b 1
)
echo.
echo  OK Dependencies installed

:: ── Generate admin secret via Node ────────────────────────
for /f "usebackq tokens=*" %%s in (`node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`) do set "ADMIN_SECRET=%%s"

:: ── Collect API keys ───────────────────────────────────────
echo.
echo [4/5] Configuring API keys...
echo.
echo  Keys are saved in .env on your computer only.
echo  Press Enter to skip any key (you can edit .env later).
echo.

echo  --- ANTHROPIC_API_KEY (required for chat) ---
echo  Get yours at: https://console.anthropic.com
set "ANTHROPIC_KEY="
set /p "ANTHROPIC_KEY=  Enter key (or press Enter to skip): "
echo.

echo  --- GEMINI_API_KEY (audio transcription, free tier) ---
echo  Get yours at: https://aistudio.google.com
set "GEMINI_KEY="
set /p "GEMINI_KEY=  Enter key (or press Enter to skip): "
echo.

echo  --- ELEVENLABS_API_KEY (voice synthesis, optional) ---
echo  Get yours at: https://elevenlabs.io
set "EL_KEY="
set /p "EL_KEY=  Enter key (or press Enter to skip): "
echo.

:: Write .env via Node to avoid cmd special-character issues
node -e "^
var fs=require('fs');^
var lines=['# Global Thought Stream - Configuration','# Edit this file to update your API keys','','PORT=3000','APP_URL=http://localhost:3000','DB_PATH=./gts_audit.db','CLAUDE_MODEL=claude-sonnet-4-20250514','GEMINI_MODEL=gemini-1.5-flash','ELEVENLABS_VOICE_ID=1DC6VAfJKAscIyFOOTRa','ELEVENLABS_MODEL=eleven_multilingual_v2','ADMIN_SECRET=%ADMIN_SECRET%',''];^
if('%ANTHROPIC_KEY%'!='') lines.push('ANTHROPIC_API_KEY=%ANTHROPIC_KEY%'); else lines.push('# ANTHROPIC_API_KEY=sk-ant-...');^
if('%GEMINI_KEY%'!='') lines.push('GEMINI_API_KEY=%GEMINI_KEY%'); else lines.push('# GEMINI_API_KEY=AIza...');^
if('%EL_KEY%'!='') lines.push('ELEVENLABS_API_KEY=%EL_KEY%'); else lines.push('# ELEVENLABS_API_KEY=...');^
fs.writeFileSync('.env',lines.join('\n'));"

if %errorlevel% neq 0 (
  echo  WARNING: Could not write .env automatically.
  echo  Copy .env.example to .env and fill in your keys manually.
) else (
  echo  OK Configuration saved to .env
  echo  Admin secret: %ADMIN_SECRET%
)

:: ── Admin account setup ────────────────────────────────────
echo.
echo [5/5] Creating your admin account...
echo.
set "ADMIN_EMAIL="
set "ADMIN_NAME="
set /p "ADMIN_EMAIL=  Your email: "
set /p "ADMIN_NAME=  Your name:  "

:: ── Write launch.bat ────────────────────────────────────────
(
echo @echo off
echo setlocal
echo title Global Thought Stream
echo cd /d "%%~dp0"
echo echo.
echo echo  Starting Global Thought Stream...
echo echo  Opening browser...
echo echo.
echo start "" /B node proxy-server-v2.js
echo timeout /t 3 /nobreak ^>nul
echo :: Create admin account
echo node -e "const h=require('http');const d=JSON.stringify({email:'%ADMIN_EMAIL%',name:'%ADMIN_NAME%'});const o={hostname:'localhost',port:3000,path:'/api/admin/bootstrap',method:'POST',headers:{'Content-Type':'application/json','X-Admin-Secret':'%ADMIN_SECRET%','Content-Length':d.length}};const r=h.request(o,res=^>{let b='';res.on('data',c=^>b+=c);res.on('end',()=^>{try{const j=JSON.parse(b);if(j.token){console.log('Admin token: '+j.token);require('fs').writeFileSync('admin_token.txt',j.token);console.log('Token saved to admin_token.txt');}}catch(e){}});});r.write(d);r.end();" 2^>nul
echo start http://localhost:3000/sphinx_global_unified_v2.html
echo echo  App is running at http://localhost:3000/sphinx_global_unified_v2.html
echo echo  Setup wizard at  http://localhost:3000/setup
echo echo.
echo echo  Press Ctrl+C to stop the server.
echo echo.
echo node proxy-server-v2.js
) > launch.bat

echo.
echo  =====================================================
echo    Installation complete!
echo.
echo    To start the app:
echo    Double-click  gts-app\launch.bat
echo.
echo    To add or change API keys:
echo    Edit  gts-app\.env
echo.
echo    Setup wizard (after launching):
echo    http://localhost:3000/setup
echo  =====================================================
echo.

set "LAUNCH_NOW="
set /p "LAUNCH_NOW=Launch the app now? [Y/n]: "
if /i "!LAUNCH_NOW!" neq "n" (
  call launch.bat
)

#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════
#   Sphinx Global Enterprises Corp
#   Global Thought Stream™ — One-Click Installer
#   Mac + Linux
# ══════════════════════════════════════════════════════════════
set -e

# ── Colours ───────────────────────────────────────────────────
GOLD='\033[0;33m'
LAV='\033[0;35m'
GREEN='\033[0;32m'
RED='\033[0;31m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

clear
echo ""
echo -e "${GOLD}╔══════════════════════════════════════════════════════╗${RESET}"
echo -e "${GOLD}║${RESET}   ${BOLD}Global Thought Stream™${RESET}                              ${GOLD}║${RESET}"
echo -e "${GOLD}║${RESET}   ${DIM}Sphinx Global Enterprises Corp${RESET}                      ${GOLD}║${RESET}"
echo -e "${GOLD}║${RESET}   ${LAV}One Thought. Every Language. Continuity Preserved.${RESET}  ${GOLD}║${RESET}"
echo -e "${GOLD}╚══════════════════════════════════════════════════════╝${RESET}"
echo ""

# ── Detect OS ─────────────────────────────────────────────────
OS="$(uname -s)"
INSTALL_DIR="$(pwd)/gts-app"
echo -e "${DIM}Platform: ${OS}${RESET}"
echo -e "${DIM}Install location: ${INSTALL_DIR}${RESET}"
echo ""

# ── Check Node.js ─────────────────────────────────────────────
echo -e "${GOLD}[1/5]${RESET} Checking Node.js..."
if ! command -v node &> /dev/null; then
  echo -e "${RED}✗ Node.js not found.${RESET}"
  echo ""
  if [[ "$OS" == "Darwin" ]]; then
    echo "  Install with Homebrew:  brew install node"
    echo "  Or download from:       https://nodejs.org"
  else
    echo "  Install with apt:  sudo apt install nodejs npm"
    echo "  Or download from:  https://nodejs.org"
  fi
  echo ""
  echo "  After installing Node.js, run this installer again."
  exit 1
fi

NODE_VER=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VER" -lt 18 ]; then
  echo -e "${RED}✗ Node.js v${NODE_VER} is too old. Version 18+ required.${RESET}"
  echo "  Download the latest LTS from https://nodejs.org"
  exit 1
fi
echo -e "${GREEN}✓ Node.js $(node --version)${RESET}"

# ── Create install directory ──────────────────────────────────
echo -e "${GOLD}[2/5]${RESET} Setting up app folder..."
mkdir -p "$INSTALL_DIR"
cp "$(dirname "$0")/sphinx_global_unified_v2.html" "$INSTALL_DIR/" 2>/dev/null || \
  cp "./sphinx_global_unified_v2.html" "$INSTALL_DIR/" 2>/dev/null || \
  { echo -e "${RED}✗ Cannot find sphinx_global_unified_v2.html${RESET}"; exit 1; }

cp "$(dirname "$0")/proxy-server-v2.js" "$INSTALL_DIR/" 2>/dev/null || \
  cp "./proxy-server-v2.js" "$INSTALL_DIR/" 2>/dev/null || \
  { echo -e "${RED}✗ Cannot find proxy-server-v2.js${RESET}"; exit 1; }

echo -e "${GREEN}✓ App files copied${RESET}"

# ── Install npm dependencies ──────────────────────────────────
echo -e "${GOLD}[3/5]${RESET} Installing dependencies (this takes ~30 seconds)..."
cd "$INSTALL_DIR"
cat > package.json << 'PKGJSON'
{
  "name": "global-thought-stream",
  "version": "1.0.0",
  "description": "Global Thought Stream — Sphinx Global Enterprises Corp",
  "main": "proxy-server-v2.js",
  "scripts": {
    "start": "node proxy-server-v2.js",
    "setup": "node setup-wizard.js"
  },
  "dependencies": {
    "better-sqlite3": "^9.4.3",
    "cors": "^2.8.5",
    "dotenv": "^16.4.5",
    "express": "^4.21.1",
    "form-data": "^4.0.0",
    "multer": "^1.4.5-lts.1",
    "node-fetch": "^3.3.2",
    "stripe": "^16.3.0"
  }
}
PKGJSON

npm install --silent
echo -e "${GREEN}✓ Dependencies installed${RESET}"

# ── Collect API keys ──────────────────────────────────────────
echo -e "${GOLD}[4/5]${RESET} Configuring your API keys..."
echo ""
echo -e "${DIM}  Keys are saved locally in .env — never sent anywhere.${RESET}"
echo -e "${DIM}  Press Enter to skip any key (you can add it later).${RESET}"
echo ""

prompt_key() {
  local name=$1
  local hint=$2
  local url=$3
  echo -e "  ${BOLD}${name}${RESET}"
  echo -e "  ${DIM}Get yours at: ${url}${RESET}"
  read -rp "  Enter key (or press Enter to skip): " val
  if [ -n "$val" ]; then
    echo "${name}=${val}" >> .env
    echo -e "  ${GREEN}✓ Saved${RESET}"
  else
    echo -e "  ${DIM}Skipped — add ${name}= to .env later${RESET}"
  fi
  echo ""
}

# Generate admin secret automatically
ADMIN_SECRET=$(node -e "const c=require('crypto');console.log(c.randomBytes(24).toString('hex'))")

cat > .env << ENVHEAD
# Global Thought Stream — Configuration
# Edit this file to update your API keys

PORT=3000
APP_URL=http://localhost:3000
DB_PATH=./gts_audit.db
CLAUDE_MODEL=claude-sonnet-4-20250514
GEMINI_MODEL=gemini-1.5-flash
ELEVENLABS_VOICE_ID=1DC6VAfJKAscIyFOOTRa
ELEVENLABS_MODEL=eleven_multilingual_v2
ADMIN_SECRET=${ADMIN_SECRET}

ENVHEAD

echo -e "  ${GOLD}ANTHROPIC_API_KEY${RESET} ${DIM}(required for chat)${RESET}"
echo -e "  ${DIM}Get yours at: console.anthropic.com → API Keys${RESET}"
read -rp "  Enter key (or press Enter to skip): " ANTHROPIC_KEY_VAL
[ -n "$ANTHROPIC_KEY_VAL" ] && echo "ANTHROPIC_API_KEY=${ANTHROPIC_KEY_VAL}" >> .env || echo "# ANTHROPIC_API_KEY=sk-ant-..." >> .env
echo ""

echo -e "  ${GOLD}GEMINI_API_KEY${RESET} ${DIM}(for audio transcription — free tier available)${RESET}"
echo -e "  ${DIM}Get yours at: aistudio.google.com${RESET}"
read -rp "  Enter key (or press Enter to skip): " GEMINI_KEY_VAL
[ -n "$GEMINI_KEY_VAL" ] && echo "GEMINI_API_KEY=${GEMINI_KEY_VAL}" >> .env || echo "# GEMINI_API_KEY=AIza..." >> .env
echo ""

echo -e "  ${GOLD}ELEVENLABS_API_KEY${RESET} ${DIM}(for voice synthesis — optional)${RESET}"
echo -e "  ${DIM}Get yours at: elevenlabs.io${RESET}"
read -rp "  Enter key (or press Enter to skip): " EL_KEY_VAL
[ -n "$EL_KEY_VAL" ] && echo "ELEVENLABS_API_KEY=${EL_KEY_VAL}" >> .env || echo "# ELEVENLABS_API_KEY=..." >> .env
echo ""

echo -e "${GREEN}✓ Configuration saved to .env${RESET}"
echo -e "${DIM}  Admin secret auto-generated: ${ADMIN_SECRET}${RESET}"

# ── Create your admin account ─────────────────────────────────
echo -e "${GOLD}[5/5]${RESET} Creating your admin account..."
echo ""
read -rp "  Your email: " ADMIN_EMAIL
read -rp "  Your name:  " ADMIN_NAME

# Write launch script
cat > launch.sh << LAUNCHSH
#!/usr/bin/env bash
cd "\$(dirname "\$0")"
echo "Starting Global Thought Stream..."
node proxy-server-v2.js &
SERVER_PID=\$!
sleep 2
# Create admin account on first run
curl -s -X POST http://localhost:3000/api/admin/bootstrap \\
  -H "Content-Type: application/json" \\
  -H "X-Admin-Secret: ${ADMIN_SECRET}" \\
  -d '{"email":"${ADMIN_EMAIL}","name":"${ADMIN_NAME}"}' > /tmp/gts_admin.json 2>/dev/null
TOKEN=\$(cat /tmp/gts_admin.json | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
if [ -n "\$TOKEN" ]; then
  echo "Admin token: \$TOKEN"
fi
# Open browser
if [[ "\$(uname)" == "Darwin" ]]; then
  open "http://localhost:3000/sphinx_global_unified_v2.html"
else
  xdg-open "http://localhost:3000/sphinx_global_unified_v2.html" 2>/dev/null || \\
  firefox "http://localhost:3000/sphinx_global_unified_v2.html" 2>/dev/null || \\
  google-chrome "http://localhost:3000/sphinx_global_unified_v2.html" 2>/dev/null
fi
echo ""
echo "App running at http://localhost:3000/sphinx_global_unified_v2.html"
echo "Press Ctrl+C to stop."
wait \$SERVER_PID
LAUNCHSH
chmod +x launch.sh

echo ""
echo -e "${GOLD}╔══════════════════════════════════════════════════════╗${RESET}"
echo -e "${GOLD}║${RESET}   ${GREEN}✓ Installation complete!${RESET}                            ${GOLD}║${RESET}"
echo -e "${GOLD}╠══════════════════════════════════════════════════════╣${RESET}"
echo -e "${GOLD}║${RESET}                                                      ${GOLD}║${RESET}"
echo -e "${GOLD}║${RESET}   To start the app:                                  ${GOLD}║${RESET}"
echo -e "${GOLD}║${RESET}   ${BOLD}cd gts-app && ./launch.sh${RESET}                           ${GOLD}║${RESET}"
echo -e "${GOLD}║${RESET}                                                      ${GOLD}║${RESET}"
echo -e "${GOLD}║${RESET}   Or just double-click ${BOLD}launch.sh${RESET}                       ${GOLD}║${RESET}"
echo -e "${GOLD}║${RESET}                                                      ${GOLD}║${RESET}"
echo -e "${GOLD}║${RESET}   Admin secret saved in .env                         ${GOLD}║${RESET}"
echo -e "${GOLD}║${RESET}   Edit .env to add/update API keys anytime           ${GOLD}║${RESET}"
echo -e "${GOLD}╚══════════════════════════════════════════════════════╝${RESET}"
echo ""

read -rp "Launch the app now? [Y/n] " LAUNCH_NOW
if [[ "$LAUNCH_NOW" != "n" && "$LAUNCH_NOW" != "N" ]]; then
  ./launch.sh
fi

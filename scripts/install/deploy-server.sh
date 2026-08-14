#!/usr/bin/env bash
# @pattern Command, Template Method
# ============================================================
#  KHY-Quant Server Quick Deploy
#  Target: Ubuntu 20.04+ (4C/4G minimum)
#
#  Usage:
#    curl -sSL <url> | bash
#    # or
#    bash scripts/deploy-server.sh [--lightweight] [--with-ollama]
# ============================================================
set -euo pipefail

# ── Colors ──
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[ OK ]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
fail()  { echo -e "${RED}[FAIL]${NC}  $*"; exit 1; }
step()  { echo -e "\n${BOLD}── $* ──${NC}"; }

# ── Parse args ──
LIGHTWEIGHT=false
WITH_OLLAMA=false
for arg in "$@"; do
  case "$arg" in
    --lightweight) LIGHTWEIGHT=true ;;
    --with-ollama) WITH_OLLAMA=true ;;
    --help|-h)
      echo "Usage: bash deploy-server.sh [--lightweight] [--with-ollama]"
      echo "  --lightweight   Force lightweight mode (skip heavy features)"
      echo "  --with-ollama   Install Ollama for local model inference"
      exit 0
      ;;
  esac
done

# ── System check ──
step "System Detection"

TOTAL_RAM_MB=$(free -m | awk '/^Mem:/{print $2}')
TOTAL_RAM_GB=$((TOTAL_RAM_MB / 1024))
CPU_CORES=$(nproc)
SWAP_MB=$(free -m | awk '/^Swap:/{print $2}')
DISK_AVAIL=$(df -BG / | tail -1 | awk '{print $4}' | tr -d 'G')

info "OS: $(lsb_release -d 2>/dev/null | cut -f2 || cat /etc/os-release | grep PRETTY_NAME | cut -d'"' -f2)"
info "CPU: $CPU_CORES cores ($(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | xargs))"
info "RAM: ${TOTAL_RAM_GB}GB (${TOTAL_RAM_MB}MB)"
info "Swap: ${SWAP_MB}MB"
info "Disk: ${DISK_AVAIL}GB available"

# Auto-detect lightweight mode
if [ "$TOTAL_RAM_GB" -le 4 ]; then
  LIGHTWEIGHT=true
  warn "Detected <=4GB RAM — enabling lightweight mode"
fi

if [ "$TOTAL_RAM_GB" -lt 8 ]; then
  WITH_OLLAMA=false
  warn "Detected <8GB RAM — skipping Ollama (need 8GB+ for local models)"
fi

# ── Swap Configuration ──
step "Swap Configuration"

if [ "$SWAP_MB" -lt 1024 ] && [ "$TOTAL_RAM_GB" -le 8 ]; then
  SWAP_SIZE="2G"
  if [ "$TOTAL_RAM_GB" -le 4 ]; then
    SWAP_SIZE="4G"
  fi

  info "Creating ${SWAP_SIZE} swap file..."
  if [ ! -f /swapfile ]; then
    sudo fallocate -l "$SWAP_SIZE" /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile

    # Make persistent
    if ! grep -q '/swapfile' /etc/fstab; then
      echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab > /dev/null
    fi

    # Optimize swappiness for server
    sudo sysctl vm.swappiness=10
    echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf > /dev/null

    ok "Swap configured: ${SWAP_SIZE}"
  else
    ok "Swap file already exists"
  fi
else
  ok "Swap OK (${SWAP_MB}MB)"
fi

# ── System Dependencies ──
step "System Dependencies"

info "Updating package list..."
sudo apt-get update -qq

# Node.js 18+
if ! command -v node &>/dev/null || [ "$(node -v | sed 's/v//' | cut -d. -f1)" -lt 18 ]; then
  info "Installing Node.js 18..."
  curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
  sudo apt-get install -y nodejs
  ok "Node.js $(node -v) installed"
else
  ok "Node.js $(node -v) already installed"
fi

# Essential tools
info "Installing essential packages..."
sudo apt-get install -y -qq git curl wget build-essential 2>/dev/null
ok "Essential packages installed"

# ── Security Packages ──
step "Security Packages"

# ClamAV
if ! command -v clamscan &>/dev/null; then
  info "Installing ClamAV..."
  sudo apt-get install -y -qq clamav clamav-daemon 2>/dev/null
  sudo systemctl stop clamav-freshclam 2>/dev/null || true
  sudo freshclam 2>/dev/null || warn "freshclam update failed (will retry later)"
  sudo systemctl start clamav-freshclam 2>/dev/null || true
  ok "ClamAV installed"
else
  ok "ClamAV already installed"
fi

# chkrootkit
if ! command -v chkrootkit &>/dev/null; then
  sudo apt-get install -y -qq chkrootkit 2>/dev/null
  ok "chkrootkit installed"
else
  ok "chkrootkit already installed"
fi

# fail2ban
if ! command -v fail2ban-client &>/dev/null; then
  info "Installing fail2ban..."
  sudo apt-get install -y -qq fail2ban 2>/dev/null
  sudo systemctl enable fail2ban
  sudo systemctl start fail2ban
  ok "fail2ban installed and enabled"
else
  ok "fail2ban already installed"
fi

# UFW firewall
if command -v ufw &>/dev/null; then
  info "Configuring firewall..."
  sudo ufw default deny incoming 2>/dev/null || true
  sudo ufw default allow outgoing 2>/dev/null || true
  sudo ufw allow 22/tcp 2>/dev/null || true    # SSH
  sudo ufw allow 3000/tcp 2>/dev/null || true   # Backend API
  sudo ufw --force enable 2>/dev/null || true
  ok "UFW firewall configured (ports: 22, 3000)"
else
  sudo apt-get install -y -qq ufw 2>/dev/null
  sudo ufw default deny incoming
  sudo ufw default allow outgoing
  sudo ufw allow 22/tcp
  sudo ufw allow 3000/tcp
  sudo ufw --force enable
  ok "UFW installed and configured"
fi

# ── Ollama (optional) ──
if [ "$WITH_OLLAMA" = true ]; then
  step "Ollama Installation"
  if ! command -v ollama &>/dev/null; then
    info "Installing Ollama..."
    curl -fsSL https://ollama.com/install.sh | sh
    ok "Ollama installed"

    # Pull lightweight model for server
    if [ "$TOTAL_RAM_GB" -ge 8 ]; then
      info "Pulling qwen2.5:3b (recommended for your hardware)..."
      ollama pull qwen2.5:3b
      ok "Model qwen2.5:3b ready"
    fi
  else
    ok "Ollama already installed"
  fi
fi

# ── System Limits ──
step "System Limits"

# Increase file descriptor limits
if ! grep -q 'khyquant' /etc/security/limits.conf 2>/dev/null; then
  sudo tee -a /etc/security/limits.conf > /dev/null <<EOF

# KHY-Quant limits
* soft nofile 65536
* hard nofile 65536
* soft nproc 4096
* hard nproc 4096
EOF
  ok "File descriptor limits configured"
else
  ok "Limits already configured"
fi

# ── KHY-Quant Installation ──
step "KHY-Quant Installation"

PROJECT_DIR="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)" || PROJECT_DIR="$(pwd)"

if [ -f "$PROJECT_DIR/services/backend/package.json" ]; then
  cd "$PROJECT_DIR/services/backend"
  info "Installing backend dependencies..."
  npm install --no-audit --no-fund --production 2>&1 | tail -3
  ok "Backend dependencies installed"

  info "Registering CLI..."
  npm link 2>&1 | tail -2
  ok "CLI registered"
  cd "$PROJECT_DIR"
else
  warn "Project not found at $PROJECT_DIR — skip npm install"
fi

# ── Environment Configuration ──
step "Environment Configuration"

KHY_ENV="$HOME/.khyquant/server.env"
mkdir -p "$HOME/.khyquant"

cat > "$KHY_ENV" <<EOF
# KHY-Quant Server Configuration
# Generated: $(date '+%Y-%m-%d %H:%M:%S')
# Hardware: ${CPU_CORES}C / ${TOTAL_RAM_GB}GB

# Lightweight mode (reduced memory, fewer features)
KHY_LIGHTWEIGHT=$LIGHTWEIGHT

# Memory limits
KHY_MAX_HEAP_MB=$((TOTAL_RAM_MB / 4))
NODE_OPTIONS="--max-old-space-size=$((TOTAL_RAM_MB / 4))"

# Concurrency
KHY_MAX_CONCURRENCY=$((CPU_CORES > 2 ? 2 : 1))

# Timeouts (shorter on low-resource servers)
KHY_WATCHDOG_MS=$((LIGHTWEIGHT == true ? 60000 : 120000))

# Security
KHY_SECURITY_SCAN=true
KHY_PERIODIC_CLEANUP=true
EOF

ok "Server config saved: $KHY_ENV"

# Source in bashrc
if ! grep -q 'khyquant/server.env' "$HOME/.bashrc" 2>/dev/null; then
  echo "" >> "$HOME/.bashrc"
  echo "# KHY-Quant environment" >> "$HOME/.bashrc"
  echo "[ -f $KHY_ENV ] && set -a && source $KHY_ENV && set +a" >> "$HOME/.bashrc"
  ok "Environment auto-loaded in .bashrc"
fi

# ── Systemd Service ──
step "Systemd Service"

SERVICE_FILE="/etc/systemd/system/khyquant.service"
if [ ! -f "$SERVICE_FILE" ]; then
  sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=KHY-Quant Trading System Backend
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$PROJECT_DIR/services/backend
EnvironmentFile=$KHY_ENV
ExecStart=$(which node) src/server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=khyquant

# Resource limits
MemoryMax=$((TOTAL_RAM_MB / 2))M
CPUQuota=$((CPU_CORES * 50))%
TasksMax=100

[Install]
WantedBy=multi-user.target
EOF

  sudo systemctl daemon-reload
  ok "Systemd service created"
  info "Enable: sudo systemctl enable khyquant"
  info "Start:  sudo systemctl start khyquant"
  info "Logs:   journalctl -u khyquant -f"
else
  ok "Systemd service already exists"
fi

# ── Log Rotation ──
step "Log Rotation"

LOGROTATE_CONF="/etc/logrotate.d/khyquant"
if [ ! -f "$LOGROTATE_CONF" ]; then
  sudo tee "$LOGROTATE_CONF" > /dev/null <<EOF
$HOME/.khyquant/*.log {
    daily
    missingok
    rotate 7
    compress
    delaycompress
    notifempty
    create 640 $(whoami) $(whoami)
}
EOF
  ok "Log rotation configured (7 days)"
else
  ok "Log rotation already configured"
fi

# ── Initial Security Scan ──
step "Initial Security Scan"

if command -v clamscan &>/dev/null && [ -d "$PROJECT_DIR" ]; then
  info "Running quick project scan..."
  SCAN_RESULT=$(clamscan -r --infected --no-summary "$PROJECT_DIR" 2>/dev/null || true)
  if [ -z "$SCAN_RESULT" ]; then
    ok "Project scan clean — no threats found"
  else
    warn "Threats detected:"
    echo "$SCAN_RESULT"
  fi
else
  warn "ClamAV not ready — skipping initial scan"
fi

# ── Summary ──
echo ""
echo -e "${BOLD}══════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}  Server deployment complete!${NC}"
echo -e "${BOLD}══════════════════════════════════════════${NC}"
echo ""
echo -e "  ${BOLD}Hardware:${NC}     ${CPU_CORES}C / ${TOTAL_RAM_GB}GB RAM / ${DISK_AVAIL}GB disk"
echo -e "  ${BOLD}Mode:${NC}         $([ "$LIGHTWEIGHT" = true ] && echo "Lightweight (server-minimal)" || echo "Standard")"
echo -e "  ${BOLD}Security:${NC}     ClamAV + fail2ban + UFW"
echo -e "  ${BOLD}Ollama:${NC}       $([ "$WITH_OLLAMA" = true ] && echo "Installed" || echo "Skipped (use --with-ollama)")"
echo ""
echo -e "  ${BOLD}Quick start:${NC}"
echo -e "    ${CYAN}source ~/.bashrc${NC}              Load environment"
echo -e "    ${CYAN}khy${NC}                            Start CLI"
echo -e "    ${CYAN}khy doctor${NC}                     Health check"
echo -e "    ${CYAN}khy gateway status${NC}             Check AI adapters"
echo -e "    ${CYAN}sudo systemctl start khyquant${NC}  Start as service"
echo ""
echo -e "  ${BOLD}Security commands:${NC}"
echo -e "    ${CYAN}khy scan${NC}                       Quick virus scan"
echo -e "    ${CYAN}khy scan --full${NC}                Full system scan"
echo -e "    ${CYAN}khy security${NC}                   Security status"
echo ""

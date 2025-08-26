#! /bin/sh
set -e

# op25 install script for debian-based systems (Ubuntu/Raspbian)
# Adds optional streaming stack install (FFmpeg, Pulse/PipeWire, Icecast2) and systemd service

if [ ! -d op25/gr-op25 ]; then
  echo "====== error, op25 top level directories not found"
  echo "====== you must run this from the op25 top level directory"
  exit 1
fi

# Defaults / flags
FORCE=false
STREAMING=false           # -S  install ffmpeg + pulseaudio-utils
INSTALL_ICECAST=false     # -I  install/configure icecast2
ICEPASS="${ICEPASS:-op25}"     # -a  source password
MOUNT="${MOUNT:-op25.mp3}"     # -m  mountpoint (no leading slash)
SERVICE_USER=""           # -U  create systemd service as this user
CONFIG_JSON=""            # -C  path to op25 config json (for service)
DEBIAN_FRONTEND=noninteractive

# Parse args
usage() {
  cat <<EOF
Usage: $0 [-f] [-S] [-I] [-a pass] [-m mount] [-U user] [-C /path/config.json]

  -f           Force noninteractive apt (-y)
  -S           Install streaming deps (ffmpeg, pulseaudio-utils)
  -I           Install & enable Icecast2; set source password
  -a <pass>    Icecast source password (default: op25)
  -m <mount>   Icecast mount name (default: op25.mp3)
  -U <user>    Create a systemd service for OP25 running as <user>
  -C <config>  Path to OP25 JSON config used by the service
EOF
}

while getopts ":fSIa:m:U:C:h" opt; do
  case $opt in
    f) FORCE=true ;;
    S) STREAMING=true ;;
    I) INSTALL_ICECAST=true ;;
    a) ICEPASS="$OPTARG" ;;
    m) MOUNT="$OPTARG" ;;
    U) SERVICE_USER="$OPTARG" ;;
    C) CONFIG_JSON="$OPTARG" ;;
    h) usage; exit 0 ;;
    \?) usage; exit 1 ;;
  esac
done

APT_Y=""
[ "$FORCE" = true ] && APT_Y="-y"

# Discover repo dir for service wiring
REPO_DIR="$(pwd)"
APPS_DIR="$REPO_DIR/op25/gr-op25_repeater/apps"
MULTI_RX="$APPS_DIR/multi_rx.py"
[ -z "$CONFIG_JSON" ] && CONFIG_JSON="$REPO_DIR/op25.json"

# ---- Base GNURadio / build (unchanged) ----
GR_VER=$(apt list gnuradio 2>/dev/null | grep -m 1 gnuradio | cut -d' ' -f2 | cut -d'.' -f1,2)
echo "Identified GNURadio version ${GR_VER}"
if [ "${GR_VER}" = "3.10" ]; then
  echo "Installing for GNURadio 3.10"
  sudo sed -i -- 's/^# *deb-src/deb-src/' /etc/apt/sources.list || true
  echo "Updating package lists"
  sudo apt-get update
  echo "Installing dependencies"
  sudo apt-get build-dep gnuradio $APT_Y
  sudo apt-get install $APT_Y \
    gnuradio gnuradio-dev gr-osmosdr librtlsdr-dev libuhd-dev libhackrf-dev \
    libitpp-dev libpcap-dev liborc-dev cmake git build-essential pkg-config \
    doxygen clang-format python3-pybind11 python3-numpy python3-waitress \
    python3-requests gnuplot-x11 libsndfile1-dev libspdlog-dev

  # Tell op25 to use python3
  echo "/usr/bin/python3" > "$APPS_DIR/op25_python"
else
  echo "GNURadio ${GR_VER} not supported by this branch."
  echo 'Use branch "gr38" for GNURadio-3.8 or earlier.'
  exit 1
fi

# ---- Optional: streaming deps ----
if [ "$STREAMING" = true ]; then
  echo "Installing streaming dependencies (ffmpeg + pulseaudio-utils)..."
  sudo apt-get install $APT_Y ffmpeg pulseaudio-utils
  # On some distros pipewire-pulse provides pactl; pulseaudio-utils is safest.
fi

# ---- Optional: Icecast2 ----
if [ "$INSTALL_ICECAST" = true ]; then
  echo "Installing Icecast2..."
  sudo apt-get install $APT_Y icecast2

  # Enable service; Debian uses /etc/default/icecast2 to gate startup
  if [ -f /etc/default/icecast2 ]; then
    sudo sed -i 's/^\s*ENABLE=.*$/ENABLE=true/' /etc/default/icecast2
  fi

  # Set source password + sane hostname; keep a backup
  ICECONF="/etc/icecast2/icecast.xml"
  if [ -f "$ICECONF" ]; then
    echo "Configuring Icecast2 source password and hostname (backup at .bak)..."
    sudo cp -n "$ICECONF" "$ICECONF.bak" || true
    sudo sed -i \
      -e "s|<source-password>.*</source-password>|<source-password>${ICEPASS}</source-password>|" \
      -e "s|<hostname>.*</hostname>|<hostname>localhost</hostname>|" \
      "$ICECONF"
  fi

  echo "Enabling and starting Icecast2..."
  sudo systemctl enable --now icecast2 || sudo systemctl restart icecast2

  # Attempt to open firewall port 8000 if ufw is present (best-effort)
  if command -v ufw >/dev/null 2>&1; then
    sudo ufw allow 8000/tcp || true
  fi
fi

# blacklist rtl dtv drivers (unchanged)
if [ ! -f /etc/modprobe.d/blacklist-rtl.conf ]; then
  echo "====== installing blacklist-rtl.conf"
  echo "====== please reboot before running op25"
  sudo install -m 0644 ./blacklist-rtl.conf /etc/modprobe.d/
fi

# fix borked airspy udev rule (unchanged)
if [ -f /lib/udev/rules.d/60-libairspy0.rules ]; then
  echo "====== fixing libairspy0 udev rule"
  echo "====== please reboot before running op25"
  sudo sed -i 's^TAG+="uaccess"^MODE="660", GROUP="plugdev"^g' /lib/udev/rules.d/60-libairspy0.rules
fi

# Build/install OP25 (unchanged)
rm -rf build
mkdir build
cd build
cmake ../         2>&1 | tee cmake.log
make              2>&1 | tee make.log
sudo make install 2>&1 | tee install.log
sudo ldconfig
cd ..

# ---- Optional: systemd service for OP25 with streaming flags ----
if [ -n "$SERVICE_USER" ]; then
  if [ ! -x "$MULTI_RX" ]; then
    echo "Warning: multi_rx.py not found at $MULTI_RX. Service will still be created but may fail."
  fi

  # Create user if missing (no shell/login)
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    echo "Creating service user: $SERVICE_USER"
    sudo useradd -r -s /usr/sbin/nologin -d "$REPO_DIR" "$SERVICE_USER" || true
  fi

  SERVICE=/etc/systemd/system/op25.service
  echo "Creating systemd unit at $SERVICE"

  sudo /bin/sh -c "cat > '$SERVICE' <<'UNIT'
[Unit]
Description=OP25 with Web UI + optional audio streaming
After=network-online.target sound.target
Wants=network-online.target

[Service]
User=__USER__
Group=__USER__
WorkingDirectory=__REPO__
ExecStart=/usr/bin/python3 __APPS__/multi_rx.py -c __CFG__ \
  --stream-url=icecast://source:${ICECAST_PASS}@127.0.0.1:8000/__MOUNT__ \
  --stream-device=pulse \
  --stream-format=mp3 --stream-bitrate=64k \
  --stream-rate=22050 --stream-channels=1 \
  --stream-restart \
  --stream-log=/var/log/op25-ffmpeg.log
Environment=ICECAST_PASS=__ICEPASS__
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT"

  # Fill placeholders
  sudo sed -i \
    -e "s|__USER__|$SERVICE_USER|g" \
    -e "s|__REPO__|$REPO_DIR|g" \
    -e "s|__APPS__|$APPS_DIR|g" \
    -e "s|__CFG__|$CONFIG_JSON|g" \
    -e "s|__MOUNT__|$MOUNT|g" \
    -e "s|__ICEPASS__|$ICEPASS|g" \
    "$SERVICE"

  # Log dir
  sudo mkdir -p /var/log
  sudo touch /var/log/op25-ffmpeg.log
  sudo chown "$SERVICE_USER:$SERVICE_USER" /var/log/op25-ffmpeg.log || true

  echo "Enabling and starting op25.service ..."
  sudo systemctl daemon-reload
  sudo systemctl enable --now op25.service
fi

echo
echo "Done."
echo "Notes:"
echo " - Streaming stack installed: $STREAMING"
echo " - Icecast installed:         $INSTALL_ICECAST (pass: $ICEPASS, mount: /$MOUNT)"
if [ -n "$SERVICE_USER" ]; then
  echo " - systemd service:           enabled as $SERVICE_USER (config: $CONFIG_JSON)"
  echo "   Edit ExecStart in $SERVICE to tweak flags (e.g., ALSA vs Pulse)."
fi

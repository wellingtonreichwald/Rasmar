#!/bin/bash
# ============================================================================
# Instalador automático do Rasmar — servidor de sincronização
# ============================================================================
# O que esse script faz sozinho, sem você precisar entender nada disso:
#   1. Instala o Node.js (o "motor" que roda o servidor)
#   2. Instala o Caddy (deixa o endereço com https:// automático, sem custo)
#   3. Baixa o server.js do seu GitHub
#   4. Deixa o servidor rodando sempre, mesmo se a máquina reiniciar
#   5. No final, mostra o endereço que você vai colar no Rasmar
#
# Como usar: veja o guia "Como instalar o Rasmar do zero" que acompanha
# esse arquivo. Resumindo: você vai rodar isso assim, trocando a URL:
#
#   bash instalar-rasmar.sh "https://raw.githubusercontent.com/SEU-USUARIO/SEU-REPOSITORIO/main/server.js"
#
# Pode rodar de novo quantas vezes quiser — não quebra nada, só atualiza.
# ============================================================================

set -e  # para tudo se algum passo der errado, em vez de continuar quebrado

URL_SERVER_JS="$1"

if [ -z "$URL_SERVER_JS" ]; then
  echo ""
  echo "❌ Faltou me dizer de onde baixar o server.js."
  echo ""
  echo "Rode de novo assim, trocando pelo link do SEU GitHub:"
  echo '   bash instalar-rasmar.sh "https://raw.githubusercontent.com/SEU-USUARIO/SEU-REPOSITORIO/main/server.js"'
  echo ""
  exit 1
fi

echo ""
echo "=============================================="
echo " Instalando o Rasmar — isso leva uns 2 minutos"
echo "=============================================="
echo ""

# ---------- 1) descobre quem é o usuário atual e onde vai instalar ----------
USUARIO_ATUAL=$(whoami)
PASTA_RASMAR="/home/$USUARIO_ATUAL/rasmar"
echo "👉 Vou instalar em: $PASTA_RASMAR"
mkdir -p "$PASTA_RASMAR"

# ---------- 2) instala o Node.js, se ainda não tiver ----------
if command -v node >/dev/null 2>&1; then
  echo "✅ Node.js já está instalado ($(node --version))"
else
  echo "📦 Instalando o Node.js..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - >/dev/null 2>&1
  sudo apt-get install -y nodejs >/dev/null 2>&1
  echo "✅ Node.js instalado ($(node --version))"
fi

# ---------- 3) instala o Caddy, se ainda não tiver (deixa https:// automático) ----------
if command -v caddy >/dev/null 2>&1; then
  echo "✅ Caddy já está instalado"
else
  echo "📦 Instalando o Caddy (é o que deixa o endereço com cadeado https, de graça)..."
  sudo apt-get update -y >/dev/null 2>&1
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null 2>&1
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg >/dev/null 2>&1
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y >/dev/null 2>&1
  sudo apt-get install -y caddy >/dev/null 2>&1
  echo "✅ Caddy instalado"
fi

# ---------- 4) baixa a versão mais recente do server.js do GitHub ----------
echo "⬇️  Baixando o server.js do seu GitHub..."
curl -fsSL "$URL_SERVER_JS" -o "$PASTA_RASMAR/server.js"
echo "✅ server.js baixado"

# ---------- 5) descobre o endereço público dessa máquina ----------
echo "🌐 Descobrindo o endereço público dessa máquina..."
IP_PUBLICO=$(curl -fsSL -H "Metadata-Flavor: Google" "http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip" 2>/dev/null || curl -fsSL https://api.ipify.org 2>/dev/null || echo "")
if [ -z "$IP_PUBLICO" ]; then
  echo "❌ Não consegui descobrir o endereço público sozinho."
  echo "   Rode 'curl https://api.ipify.org' manualmente, anote o número, e me chame de volta pra eu ajustar."
  exit 1
fi
ENDERECO_NIP="${IP_PUBLICO//./-}.nip.io"
echo "✅ Endereço público: $IP_PUBLICO (vai usar https://$ENDERECO_NIP/)"

# ---------- 6) cria o serviço que mantém o servidor sempre rodando ----------
echo "⚙️  Configurando o serviço (fica rodando mesmo se a máquina reiniciar)..."
sudo tee /etc/systemd/system/rasmar.service > /dev/null << SERVICE_EOF
[Unit]
Description=Servidor Rasmar
After=network.target

[Service]
Type=simple
User=$USUARIO_ATUAL
WorkingDirectory=$PASTA_RASMAR
ExecStart=$(command -v node) $PASTA_RASMAR/server.js
Restart=always
RestartSec=5
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
SERVICE_EOF

sudo systemctl daemon-reload
sudo systemctl enable rasmar >/dev/null 2>&1
sudo systemctl restart rasmar
echo "✅ Servidor rodando"

# ---------- 7) configura o Caddy pra dar https:// automático ----------
echo "🔒 Configurando o https:// automático..."
sudo tee /etc/caddy/Caddyfile > /dev/null << CADDY_EOF
$ENDERECO_NIP {
    reverse_proxy localhost:3000
}
CADDY_EOF
sudo systemctl restart caddy
echo "✅ https:// configurado"

# ---------- 8) confere se está tudo funcionando ----------
sleep 2
echo ""
echo "🔎 Conferindo se o servidor está respondendo..."
if curl -fsSL "http://localhost:3000/" >/dev/null 2>&1; then
  echo "✅ O servidor respondeu certinho"
else
  echo "⚠️  O servidor não respondeu ainda — espera mais 1 minutinho (o https:// leva um tempo pra ativar na primeira vez) e tenta abrir o endereço abaixo no navegador."
fi

echo ""
echo "=================================================================="
echo "🎉 PRONTO! Esse é o endereço que você vai colar no Rasmar:"
echo ""
echo "   https://$ENDERECO_NIP/"
echo ""
echo "Cole esse endereço na primeira tela do Rasmar, em 'endereço do"
echo "servidor', quando for criar o primeiro usuário administrador."
echo "=================================================================="
echo ""

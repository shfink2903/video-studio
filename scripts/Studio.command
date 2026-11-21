#!/bin/zsh
# Double-clic : lance le studio et l'ouvre dans le navigateur.
# Garde cette fenêtre ouverte tant que tu utilises le studio ; ferme-la pour l'arrêter.

STUDIO_DIR="$HOME/video-studio"
URL="http://localhost:4620"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

cd "$STUDIO_DIR" 2>/dev/null || {
  echo "Je ne trouve pas le dossier $STUDIO_DIR."
  echo "Appuie sur Entrée pour fermer."
  read
  exit 1
}

# Déjà lancé : on ouvre juste la page.
if lsof -nP -iTCP:4620 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Le studio tourne déjà, je l'ouvre dans ton navigateur."
  [ -z "$STUDIO_NO_OPEN" ] && open "$URL"
  exit 0
fi

# Ouvre le navigateur dès que le serveur répond.
(
  for i in {1..60}; do
    sleep 0.5
    if curl -s -o /dev/null "$URL/api/health"; then
      [ -z "$STUDIO_NO_OPEN" ] && open "$URL"
      break
    fi
  done
) &

echo "Studio : laisse cette fenêtre ouverte pendant que tu l'utilises."
echo "Pour l'arrêter, ferme la fenêtre ou appuie sur Ctrl+C."
echo
exec node server.mjs

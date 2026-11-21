# Studio

Tu déposes une vidéo, Claude la monte, tu valides, et les fichiers sont exportés prêts à poster.

## Installer

Il faut Node 22+, ffmpeg et whisper-cli (`brew install ffmpeg whisper-cpp`), puis le modèle Whisper multilingue (466 Mo, pas inclus dans le dépôt) :

```bash
mkdir -p models && curl -L -o models/ggml-small.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
```

Le rendu passe par HyperFrames (`npx hyperframes`).

## Lancer

```bash
cd ~/video-studio && npm start
```

Puis ouvre http://localhost:4620. Le serveur n'écoute que sur ton Mac.

Ou double-clique sur `Studio.command` : il lance le studio et ouvre la page. Pour l'avoir sur ton bureau :

```bash
cp ~/video-studio/scripts/Studio.command ~/Desktop/
```

Garde sa fenêtre de Terminal ouverte pendant que tu utilises le studio ; ferme-la pour l'arrêter.

## Ce qui se passe quand tu déposes une vidéo

1. **Transcription** : Whisper (modèle `models/ggml-small.bin`, langue détectée automatiquement), mot par mot.
2. **Accroche** : Claude relit la transcription, choisit la meilleure phrase d'ouverture et la place au début si besoin.
3. **Découpe** : les silences (seuil dans `project.json`) et les prises ratées repérées par Claude sont coupés avec ffmpeg.
4. **Sous-titres et zooms** : posés mot par mot, avec les mots clés en couleur.
5. **Musique** : si un mp3 est présent dans `projects/<projet>/music/`.
6. **Rendu** : HyperFrames sort un fichier par format (`formats` dans `project.json`).
7. **Légendes** : Claude écrit un texte par réseau.
8. **Validation** : rien ne sort sans ton accord. « Corriger » renvoie ta demande à Claude, qui refait le montage.
9. **Export** : les vidéos et `legendes.md` sont copiés dans `exports/<projet>/`. La publication automatique sur les réseaux n'est pas encore branchée.

## Claude

Les décisions de montage passent par le CLI Claude Code (`claude -p`) avec le modèle Claude Fable 5.2 (`claude-fable-5-2`). Pour en changer : `CLAUDE_MODEL=opus npm start`. Le CLI doit être connecté :

```bash
claude -p "ok"
```

Si la réponse est « Not logged in », lance `claude` puis `/login`. Sans connexion, le studio fait un montage de base (silences seulement) et le dit clairement à l'écran.

## Ajouter un projet

Copie `projects/move` vers `projects/<nouveau>` et modifie `project.json` : nom, couleur, ton, réseaux, formats, style des sous-titres.

## Dossiers

- `jobs/` : une vidéo par dossier (source, transcription, plan de montage, rendus).
- `exports/` : ce que tu as validé.
- `mockup/` : les maquettes du design.

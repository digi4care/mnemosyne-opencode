# Mnemosyne + OpenCode (MCP)

Minimale, projectlokale Mnemosyne-integratie voor OpenCode v2. OpenCode kan expliciet `mnemosyne_mnemosyne_remember` en `mnemosyne_mnemosyne_recall` gebruiken en de SQLite-data blijft in deze repository. Automatische recall-injectie en sessie-write-back komen in een latere iteratie.

## Benodigd

- OpenCode v2 met MCP stdio-ondersteuning
- `uv` / `uvx`
- Ollama op `http://localhost:11434` met `nomic-embed-text:latest`
- Bash en Python 3.10+

De MCP-wrapper gebruikt `mnemosyne-memory[mcp]==3.15.1` plus `numpy`. Er is geen Docker of cloud-API-key nodig.

## Configureren

De projectconfiguratie staat in `opencode.jsonc`. Deze voegt alleen `mcp.servers.mnemosyne` toe en verandert je globale OpenCode-configuratie niet.

Optionele lokale overrides:

```bash
cp .env.example .env
```

Pas `.env` aan indien nodig; dit bestand en `.mnemosyne/` staan in `.gitignore`. Sla geen API-sleutels of andere geheimen als memory op.

## Verifiëren

Test eerst Mnemosyne en Ollama zonder OpenCode:

```bash
bash scripts/smoke-direct.sh
```

Daarna test je MCP-connectie en twee onafhankelijke echte OpenCode-runs:

```bash
bash scripts/smoke-opencode.sh
# Of met een ander toegestaan model:
OPENCODE_MODEL=kimi-code-plan-global/k3 bash scripts/smoke-opencode.sh
```

De tweede smoke bewijst dat:

1. run A daadwerkelijk `mnemosyne_mnemosyne_remember` uitvoert;
2. een nieuwe run B daadwerkelijk `mnemosyne_mnemosyne_recall` uitvoert;
3. run B exact de marker uit run A retourneert;
4. de database projectlokaal is en de globale OpenCode-configuratie ongewijzigd bleef.

Traces staan onder `results/opencode-smoke-*/`.

Start daarna OpenCode vanuit deze map. Als een bestaande service de nieuwe projectconfiguratie nog niet ziet, herstart die met `opencode service restart`.

## Gebruik in een sessie

Vraag expliciet om opslag en recall, bijvoorbeeld:

```text
Gebruik mnemosyne_mnemosyne_remember om op te slaan: “Tests horen bij iedere bugfix”, met scope global.
```

In een nieuwe sessie:

```text
Gebruik mnemosyne_mnemosyne_recall om “welke testregels dit project heeft” op te zoeken en pas die toe.
```

Nieuwe memories krijgen standaard `scope=global` binnen de projectbank. Zonder die scope kan een memory alleen binnen dezelfde Mnemosyne-sessie zichtbaar zijn.

## Troubleshooting

- **`opencode mcp list` toont geen verbinding:** start een nieuwe OpenCode-sessie of `opencode service restart` en inspecteer de wrapper met `bash -x scripts/mnemosyne-mcp.sh`.
- **Embedding geeft HTTP/auth-fouten:** gebruik geen API-key voor lokale Ollama. De wrapper verwijdert overgenomen `OPENAI_API_KEY`, `OPENROUTER_API_KEY` en `MNEMOSYNE_EMBEDDING_API_KEY`, omdat Mnemosyne Authorization over HTTP weigert.
- **Recall is leeg terwijl `stats` memories toont:** controleer `scope=global`, de bank en of `MNEMOSYNE_DATA_DIR` op dezelfde plek wijst. Voer `bash scripts/smoke-direct.sh` uit om OpenCode buiten de diagnose te houden.
- **De embeddingdimensie klopt niet:** deze setup verwacht exact 768 voor `nomic-embed-text`. Kies geen ander model zonder `MNEMOSYNE_EMBEDDING_DIM` aan te passen en de store opnieuw op te bouwen.

## Native A/B/C-plugin

De volgende, grotere mijlpaal is inmiddels gebouwd: `plugins/mnemosyne-opencode`. Die native plugin kiest per project een backend en voert recall-injectie en write-back automatisch uit. De vorige MCP-integratie met expliciete tools blijft nuttig als minimale regressietest, maar is niet meer de gewenste dagelijkse workflow.

- `/memory` toont help zonder iets te veranderen.
- `/memory on` en `/memory off` zetten automatisch geheugen per project aan/uit.
- `/memory mnemosyne file` gebruikt Mnemosyne zonder embeddings.
- `/memory mnemosyne embedded` gebruikt Mnemosyne met Ollama.
- `/memory hindsight` gebruikt Hindsight via HTTP.
- `/memory status` toont backend, projectbank, opslag en `last_error`.

Zie `plugins/mnemosyne-opencode/README.md` voor commando's, installatie, backends en tests. De A/B/C-smoke `scripts/smoke-native-abc.sh` bewijst per backend dat een unieke conventie in een nieuwe sessie zonder handmatige remember/recall wordt teruggevonden.

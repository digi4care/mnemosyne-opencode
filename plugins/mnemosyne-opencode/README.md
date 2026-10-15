# `/memory` — native OpenCode memory plugin

Eén native OpenCode v2-plugin met drie verwisselbare backends voor projectgebonden, automatisch geheugen. Activeer per project; standaard staat geheugen uit. Na activatie verrijkt de plugin prompts met relevante oude herinneringen en schrijft nieuwe user/assistant-turns terug naar de projectbank.

## Commando's

```text
/memory                         toon commando help, verandert niets
/memory on                      activeer automatisch geheugen voor dit project
/memory off                     stop toekomstige injectie/write-back; oude data blijft
/memory status                  toon backend, bank, data directory en last_error
/memory mnemosyne file          gebruik Mnemosyne zonder embeddings (SQLite FTS)
/memory mnemosyne embedded      gebruik Mnemosyne met Ollama embeddings
/memory hindsight               gebruik Hindsight via HTTP
```

`/memory stats` toont backendstatistieken. De tool is **niet nodig voor dagelijks gebruik**: na activatie zijn recall en write-back automatisch.

## Installatie

Voeg de absolute directory toe aan de OpenCode v2 `plugins` array in `~/.config/opencode/opencode.jsonc`:

```jsonc
"plugins": [
  "/home/digi4care/projects/opencode-ab-test-Mnemosyne-vs-Hindsight/plugins/mnemosyne-opencode"
]
```

Start daarna `opencode service restart` of start een nieuwe sessie. Deze configuratie verandert bestaande agents of MCP-servers niet.

## Backends

| Backend | Opslag | Extra service |
|---|---|---|
| `mnemosyne-file` | Mnemosyne SQLite + FTS, geen embeddings | geen |
| `mnemosyne-embedded` | Mnemosyne + dense embeddings | Ollama `nomic-embed-text` op `localhost:11434` |
| `hindsight` | Hindsight bank met `chunks` en ruwe recall | Hindsight API op `localhost:8888` |

Projectbanken heten `opencode_<16-hex-hash>` en gebruiken het canonieke projectpad als identiteit. Alles van deze plugin staat onder OpenCode's eigen datamap:

```
~/.local/share/opencode/storage/plugin/mnemosyne-opencode/projects.json
~/.local/share/opencode/storage/plugin/mnemosyne-opencode/data/banks/opencode_<hash>/
```

Er zijn dus geen losse `~/.config/mnemosyne-opencode` of `~/.local/share/mnemosyne-opencode` mappen, en geen bestanden in de repo's zelf. `MNEMOSYNE_STATE_FILE` en `MNEMOSYNE_DATA_DIR` blijven als override bestaan zodat tests een eigen tijdelijke map gebruiken.

`mnemosyne embedded` gebruikt `MNEMOSYNE_EMBEDDING_API_URL` (standaard `http://localhost:11434/v1`), `MNEMOSYNE_EMBEDDING_MODEL` (`nomic-embed-text`) en `MNEMOSYNE_EMBEDDING_DIM` (`768`). `hindsight` gebruikt `HINDSIGHT_API_URL` en optioneel `HINDSIGHT_API_TOKEN` voor authenticatie. De wrapper stuurt geen cloud-API-key naar lokale HTTP-Ollama.

## Gedrag

- `/memory` zonder argumenten toont alleen help, als een zichtbare chatregel zonder modelcall.
- De zichtbare uitvoer van elke `/memory`-subcommand staat in het `description`-veld van het synthetic bericht; de TUI slaat synthetische berichten zonder `description` over. `text` bevat alleen een korte modelnotitie.
- Na activatie zoekt de plugin bij iedere prompt maximaal vier relevante herinneringen en voegt die als historisch bewijs in system context toe.
- Nieuwe user/assistant-tekst wordt precies één keer per sessiecursor opgeslagen. Tooloutput en eerdere memory-injectie worden niet bewaard.
- `/memory off` schakelt toekomstige recall-injectie en write-back uit zonder bestaande memories te verwijderen.
- Fouten in recall/write-back worden gelogd en zijn zichtbaar via `/memory status` onder `last_error`.

## Tests

```bash
cd plugins/mnemosyne-opencode
npm install
npm test
```

De end-to-end-smoke gebruikt echte OpenCode-processen en vereist `OPENCODE_MODEL` met toegestane toolcalls:

```bash
OPENCODE_MODEL=kimi-code-plan-global/k3 bash scripts/smoke-native-abc.sh
```

De test bewijst per backend dat een unieke conventie uit sessie A zonder handmatige remember/recall in sessie B wordt beantwoord. Sla geen geheimen op in prompts; memories zijn onleesbaar voor onbevoegde projectbanken maar staan lokaal in leesbare opslag.

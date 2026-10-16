# PRD — Memory lifecycle en configuratie van de Mnemosyne OpenCode plugin

Status: **besluiten genomen, klaar voor implementatie** · Versie 1.0 · 16 oktober 2026 · auteur: Chris Engelhard

Alle vier de openstaande vragen zijn beantwoord (§8). De persona-vraag is beantwoord met nee (§11.1). De volgorde in §7 staat vast; onderdelen 1, 2 en 3 zijn onafhankelijk en kunnen direct.

---

## 0. Kern

Vier vragen, vier conclusies:

| # | Vraag | Conclusie | Werk |
|---|---|---|---|
| 1 | Configuratie | Plugin heeft géén config-bestand; leest `opencode.jsonc` nergens | medium |
| 2 | Staleness | Plugin doet **niets** aan up-to-date houden; Mnemosyne heeft de machines wél, maar ze staan uit | medium |
| 3 | Tiers en backends | File vs embedded verschilt alleen in ranking, niet in opslag | klein, vooral documentatie |
| 4 | Globale memory | Elke project is een eigen bank. Persoonlijke voorkeuren moet je per project herhalen | klein, hoge waarde |

De twee grootste gaten zijn **1** en **2**. Vraag 3 is grotendeels een documentatiekwestie. Vraag 4 is klein in code maar pijnlijk in gebruik.

---

## 1. Probleemstelling

De plugin doet precies wat de README zegt: per project automatisch memory opslaan en teruglezen. Wat de README **niet** zegt, en wat uit de code blijkt:

- Er is geen manier om iets in te stellen behalve via `/mnemosyne` commando's.
- Er is geen mechanisme dat een memory verouderd verklaart, corrigeert of laat vervallen.
- Er is geen gedeelde memory; alles is per projectbank gedrployd.
- Consolidatie bestaat in Mnemosyne maar wordt nooit aangeroepen.

Gevolg in de praktijk: de plugin onthoudt veel, maar niets van wat hij onthoudt wordt bijgewerkt. Dat is een koelkast, geen geheugen.

---

## 2. Onderbouwing

Metingen staan in `~/projects/opencode-agents/research/2026-10-16-mnemosyne-plugin-memory-lifecycle.md`. Kern:

| Feit | Bron |
|---|---|
| Geen aanroep van `update`, `invalidate`, `sleep`, `reindex` | `index.js` regel 404-463 |
| Elke memory: `importance=0.7`, `scope=global`, geen `valid_until` | `memory_worker.py` regel 47-58 |
| Bank is per project: `opencode_<hash>` | `index.js` regel 56-60 |
| Projectbank: 186 working, **0 episodic**, 89 embeddings | SQLite-inspectie |
| `auto_sleep_enabled: true`, maar plugin roept `sleep` nooit | `config.yaml` + broncode |
| `llm_enabled: false` → geen extractie, geen conflictdetectie | `config.yaml` |

**Niet geverifieerd** (en dus niet als vaststaand te behandelen):
- of `wm_ttl_hours` daadwerkelijk rijen opruimt;
- of `config.yaml` of env-vars wint (indirect bewijs zegt env-vars);
- wat `sleep` oplevert.

---

## 3. Vraag 1 — Configuratie

### Probleem
De plugin kent drie configuratiebronnen die niet met elkaar kunnen praten: `projects.json` (runtime-state, door de plugin geschreven), env-vars (geïnjecteerd, per backend), en Mnemosyne's eigen `config.yaml` (die de plugin niet leest). Alles wat je wilt instellen moet je met de hand in `projects.json` zetten, en de gebruiker weet niet dat dat bestand bestaat.

Extra pijn: configuratie en runtime-state liggen in hetzelfde bestand. Een kapotte `projects.json` kan daardoor je instellingen overschrijven.

### Opties

**A. Niets doen.** Huidige situatie. `/mnemosyne` is de enige bediening.
Kosten: 0. Nadeel: je plugin is niet bruikbaar zonder de commando's te kennen; user-aliases voor je eigen voorkeuren bestaan niet.

**B. `mnemosyne`-blok in `opencode.jsonc`.** Globaal in `~/.config/opencode/opencode.jsonc`, per project in de lokale `opencode.jsonc`.
```jsonc
"mnemosyne": {
  "backend": "mnemosyne-file",
  "recallLimit": 4,
  "enabled": false,
  "globalBank": true
}
```
Kosten: ~1 dag. Voordelen: conventioneel, per project overschrijfbaar, geen nieuw bestandsformaat. Nadeel: plugin moet config-resolutie bouwen (global → project → state).

**C. Eigen `mnemosyne.json` in de OpenCode storage tree.**
Kosten: ~1 dag, zelfde resolutiewerk als B. Nadeel: derde plek naast OpenCode's eigen config, dus minder voorspelbaar voor een gebruiker.

**D. Config via `/mnemosyne set`.**
Kosten: klein. Nadeel: niet inspecteerbaar, niet te reviewen in git, niet deelbaar per project.

### Advies
**B**, plus een harde scheiding: `opencode.jsonc` = wat je wilt; `projects.json` = wat er gebeurd is. Concreet: bij startup neemt de plugin de **config** uit `opencode.jsonc` en neemt hij uit `projects.json` alleen `enabled`, `lastError` en `updatedAt` over. Als `opencode.jsonc` een `mnemosyne`-blok heeft wint dat; anders valt hij terug op de huidige state.

---

## 4. Vraag 2 — Staleness en up-to-date houden

### Probleem
Elke opgeslagen regel is eeuwig geldig. Als je in mei iets veranderde en dat vandaag herhaalt, staan er twee concurrerende memories. De ranking (0,5 vector + 0,3 FTS + 0,2 importance + recency) beslist dan wie wint — niet de waarheid. Bij vier injecties per prompt is het aannemelijk dat een oude regel de nieuwe overstemt.

Mnemosyne levert de middelen, wij gebruiken er geen van:

| Mechanisme | Status in onze plugin |
|---|---|
| `sleep` (consolidatie working → episodic) | nooit aangeroepen |
| `valid_until` per memory | nooit gezet |
| `invalidate` / `superseded_by` | nooit gebruikt |
| `wm_ttl_hours` | niet aangestuurd, werking onbekend |
| conflict-detectie via LLM | uit, `llm_enabled: false` |

### Opties

**A. Niets doen.** ledig opslagbewaarder.
Kosten: 0. Nadeel: het probleem hierboven.

**B. Alleen `sleep` aansluiten.** Na elke N turns (bijvoorbeeld 50) of bij sessie-einde één keer `mnemosyne sleep` draaien.
Kosten: ~2 uur. Wat het oplevert: consolidatie naar episodic, extractie van feiten, eerste vorm van samenvatting. Wat het níét oplost: een individuele memory die een ander tegenspreekt.

**C. `sleep` + recency-weging in de injectie.** Zoals B, plus: memories ouder dan X dagen krijgen een lagere `importance` bij injectie.
Kosten: ~4 uur. Oplost: oude regels overstemmen nieuw niet meer. Niet: een fout geciteerde regel verdwijnt, hij zakt alleen.

**D. Volledig: `sleep` + `valid_until` + `invalidate` bij tegenspraak.**
Kosten: 1-2 weken, plus een ontwerpbesluit over tegenspraakherkenning. Zie de open vraag hieronder.

### Het ontwerpbesluit dat C/D blokkeert
Tegenspraak herkennen is een LLM-stap. Met `llm_enabled: false` kan het alleen heuristisch (dezelfde sleutel, verschillende inhoud), en dat is zwak.

- **LLM aan**: goede conflictdetectie, maar netwerkafhankelijkheid in de write-back. Je had die afhankelijkheid juist niet willen.
- **LLM uit, heuristisch**: geen extra afhankelijkheid, maar fout-positieven markeren goede memories als verouderd.

### ⚠ Correctie na literatuuronderzoek (16 oktober 2026)

Mijn eerdere advies "**C nu, D later**" was te stellig en wordt ingetrokken. Zie §11.

arXiv **2605.12978** ("Useful Memories Become Faulty When Continuously Updated by LLMs") laat zien dat continue consolidatie het nut eerst laat stijgen en daarna laat degraderen, tot onder de no-memory-baseline; consolideren uit ground truth faalt bij 54% van eerder opgeloste ARC-AGI-problemen, en een episodisch-only controle blijft concurrerend. Agents die ruwe episodes bewaren verdubbelen hun accuracy tegenover geforceerde consolidatie.

Twee wijzigingen:
1. **B vervalt als default.** `sleep` wordt geen automatische stap in de write-back, maar een expliciet commando dat je zelf kiest. `episodic_memory = 0` is dan geen defect maar een toestand.
2. **C vervalt als oplossing voor staleness.** Recency-weging is één penalty voor alles. arXiv **2608.04746** (ScrubJay-MEM) pleit voor **per-memory, type-geconditioneerde vervalbaarheid** — een `π_i` per memory op basis van contenttype — en toont dat een ablatie van die decay de GenGap met 5,7× collapseert. Dat is een andere, grotere ingreep dan een recency-penalty.

---

## 5. Vraag 3 — working_memory, episodic_memory, file versus embedded

### Probleem
Dit is geen defect, maar een kennislek: de README legt de twee backends uit alsof het twee soorten geheugen zijn. Dat is misleidend.

Feiten:
- Beide backends gebruiken **dezelfde tabellen** en dezelfde `recall`.
- File = FTS5 + importance + recency. Embedded = idem plus dense vectors (50% van de ranking).
- In de projectbank: 186 working, 0 episodic. De episodic-laag is leeg omdat `sleep` nooit draaide, niet omdat de backend file is.
- `memory_embeddings`: 89. Die embeddings bestaan ook in een file-bank als eerder embedded gedraaid heeft — embeddings zijn per opgeslagen rij, niet per backend-keuze.

De echte tiers: `working_memory` (ruwe turns) → `episodic_memory` (samengevat door `sleep`) → `memories`/`facts` (geëxtraheerd, duurzaam).

### Opties

**A. Alleen documenteren.** Tiers en deJuiste backend-beschrijving in de README.
Kosten: ~1 uur. lost het lek, niet het probleem.

**B. Documenteren plus tiers zichtbaar maken.** `/mnemosyne stats` toont per tier wat erin zit.
Kosten: ~2 uur. Dan zie je in één oogopslag waaróm een recall iets vond of niets.

### Advies
**B**. Kleine wijziging, en het maakt vraag 2 zichtbaar: zodra `episodic_memory` groeit, zie je of `sleep` werkt.

---

## 6. Vraag 4 — Globale memory, en Mnemosyne versus Hindsight

### Het ontwerpgat
`scope="global"` klinkt als cross-project. Het is dat niet: het betekent global binnen één bank. Elke project krijgt zijn eigen bank, dus je persoonlijke voorkeuren — taal, antwoordstijl, commit-conventies, "noem me Chris" — moet je per project opnieuw in de projectbank krijgen.

Dat is een echte lacune, geen cosmetiek.

### Opties voor global memory

**A. Niets doen.** Per project uitsluitend.
Kosten: 0. Nadeel: het probleem hierboven.

**B. Gedeelde bank `opencode_global`, naast de projectbank.**
Bij recall: twee instanties (projectbank + globalbank), resultaten mergen, global dempen zodat project altijd wint. Bij write-back: alleen naar de projectbank, tenzij het een `global`-markering heeft.
Kosten: ~4 uur. Werkt, maar de merge- en dempingslogica moet je ontwerpen en testen.

**C. B + een `/mnemosyne global on`-schakelaar** om te kiezen of global meeleest.
Kosten: ~5 uur. Voordeel: projecten waar global irrelevant is kunnen het uitzetten.

**D. Persona-laag.** Mnemosyne heeft `persona_enabled: true` en een persona-tier.
Kosten: n.v.t. — **deze optie is afgevallen**, zie §11.1. De laag is niet bruikbaar in 3.15.1 en het ontwerppatroon wordt in de literatuur bekritiseerd.

**E. Per-type vervalbaarheid** (uit het literatuuronderzoek, niet oorspronkelijk mijn idee).
Elke memory krijgt een houdbaarheidscoefficient op basis van contenttype: een adres veroudert snel, een taalvoorkeur vrijwel nooit. Bij injectie weegt een memory met lage houdbaarheid zwaarder naar voren als hij níét verouderd is.
Kosten: ~3 dagen. Onderbouwd door 2608.04746, wel scoped tot temporal reasoning over perishable facts. Lost het echte probleem (§4) beter aan dan C.

### Mnemosyne versus Hindsight

Correctie vooraf, want die is belangrijk: de 422 Hindsight-documenten waren ruwe gesprekskoppen met nul geëxtraheerde feiten. Dat is **geen** bewijs dat Hindsight slecht is. Wij hadden het zelf zo geconfigureerd (`retain_extraction_mode: "chunks"`, observaties uit). Het is een configuratie-observatie, geen productoordeel. Ik had dat eerder te sterk geformuleerd.

Wat ik daadwerkelijk heb waargenomen:

| | Mnemosyne | Hindsight |
|---|---|---|
| Vorm | lokale SQLite, optioneel Ollama | HTTP-dienst in een container |
| Kosten per recall | ~0,08 s, geen euro | netwerk + container + 3,5 GB volume |
| Lifecycle-machines | `sleep`, tiers, TTL, persona | niet door ons gebruikt |
| Delen tussen agents | via export/sync | inherent, één gedeelde dienst |
| Extra onderhoud | geen | container, volume, backup, versies |

**Advies: blijf bij Mnemosyne.** Niet omdat Hindsight minderwaardig is, maar omdat de drie klachten die je hier hebt — recallscore, staleness, global memory — alle drie al in Mnemosyne bestaan en alleen nog niet zijn aangesloten. Van vendor wisselen koopt die drie niet; het koopt ze opnieuw, in een ander formaat, zonder de drie.

Mijn mening over de vraag "is dit de juiste vendor": het verschil zit niet in de database, het zit in of iemand de lifecycle aansluit. Wij hebben dat niet gedaan. Dat is ons werk, niet hun product.

---

## 7. Voorgestelde volgorde

| # | Wat | Afhankelijkheid | Grove inschatting |
|---|---|---|---|
| 1 | Scheid config (`opencode.jsonc`) van state (`projects.json`) | geen | 1 dag |
| 2 | Gedeelde global bank + schakelaar | geen | 0,5 dag |
| 3 | `/mnemosyne stats` per tier | geen | 2 uur |
| 4 | `/mnemosyne sleep` als **expliciet** commando (geen auto-trigger) | 3 | 2 uur |
| 5 | Per-type vervalbaarheid (optie E) | 3 | 3 dagen |
| 6 | Tegenspraak-invalidate | 5, plus besluit over LLM | 1-2 weken |

Onderdelen 1, 2 en 3 zijn onafhankelijk van elkaar. 4 en 5 willen 3 eerst, zodat het effect zichtbaar is. 6 is bewust uitgesteld.

### Documentatie als leverbaar

Naast de code hoort één gebruikersdocument: **`docs/working-with-memory.md`**.

Doelgroep: een ontwikkelaar die OpenCode en code kan lezen, maar nog nooit met agent
memory heeft gewerkt. Omvang: compact, één tot twee pagina's. Inhoud: wat de plugin doet,
vijf regels voor het gebruik, wat hij bewust níét doet, en kort waarom hij zo werkt.

De README linkt ernaar met een **relatieve markdown-link**, niet met een symlink. Een
symlink met absoluut pad breekt zodra het pakket op npm staat, en een symlink naar een
pad buiten de repository werkt dan sowieso niet voor andere gebruikers.

Dat document beschrijft uitsluitend wat **gedrployd** is. Geplande features worden daar
niet als bestaand gepresenteerd; waar een regel verandert door D1–D4 moet het document
mee.

---

## 8. Open beslissingen

Deze vier moet jij kiezen. Ik bouw niets tot ze beantwoord zijn.

| # | Vraag | Besluit | Status |
|---|---|---|---|
| D1 | Waar komt configuratie? | `mnemosyne`-blok in `opencode.jsonc`, globaal + per project | **besloten 16-10-2026** |
| D2 | `sleep`: in de write-back of als expliciet commando? | **Expliciet commando**, nooit automatisch | **besloten 16-10-2026** |
| D3 | Per-type vervalbaarheid bouwen of niet? | **Bouwen** (optie E, ~3 dagen) | **besloten 16-10-2026** |
| D4 | Global memory: altijd aan of schakelbaar? | **Schakelbaar per project, default aan** | **besloten 16-10-2026** |
| D5 | Is de persona-laag beter dan een handmatige bank? | **Nee** — §11.1 | **besloten 16-10-2026** |

Alle openstaande beslissingen zijn genomen. De persona-vraag is beantwoord: nee.

### Consequenties van de besluiten

- **D1** betekent dat `projects.json` geen config meer bevat. Wat de gebruiker wil komt uit `opencode.jsonc`; wat er gebeurd is blijft in `projects.json` (`enabled`, `lastError`, `updatedAt`).
- **D2** betekent dat `episodic_memory = 0` geen bug is en niet meer als zodanig gerapporteerd hoeft te worden.
- **D3** is de grootste ingreep in de volgorde. Het is bewust vóór item 6 (tegenspraak-invalidate) gepland, omdat het meeste van dat probleem oplost zonder LLM.
- **D4** betekent dat recall twee banken raadplegt. De projectbank wint altijd; global wordt gedempt.

---

## 9. Wat níét in scope is

- Vendorkeuze. Die staat in §6 en het advies is: geen wijziging.
- Migratie van de 422 Hindsight-documenten. Blijft testmateriaal.
- Benchmarkcampagne tussen backends. De snelheidsmeting in het research-bestand is voldoende voor de keuze.
- Cross-backend migratie van bestaande memories. Nog niet gevraagd, wel een logisch gevolg van vraag 2.

## 10. Acceptatiecriteria voor dit document

- [x] Persona-vs-global-bank is onderzocht en beslist (§11.1: persona afgevallen)
- [x] D1 t/m D4 zijn beantwoord (16 oktober 2026)
- [x] De volgorde in §7 is goedgekeurd, met de correctie uit §11.2
- [ ] Implementatie van de volgorde in §7, per stuk afzonderlijk geverifieerd
- [ ] De blokkades in §12 opgelost — **vereist vóór een deepwork-opdracht**

---

## 11. Onderzoeksresultaten 16 oktober 2026

Onderbouwing in `~/projects/opencode-agents/research/2026-10-16-persona-laag-en-agent-memory-literatuur.md`.

### 11.1 Persona-laag: afgevallen

Twee onafhankelijke redenen.

**Reden 1 — de code is dood in 3.15.1.** `PersonaExtractor`, `PersonaTriggers` en `write_persona_file` hebben nul callers binnen het package. De SDK-klasse `Mnemosyne` heeft geen enkele persona-methode. Het enige dat `persona.md` leest is een Hermes-integratie, en onze OpenCode-plugin injecteert het niet eens.

Bovendien een ontwerpconflict los van de dode code: de bron (`memoria_persona`) is per bank, het doelbestand is globaal (`~/.hermes/memory/persona.md`). Bij meerdere projecten overschrijft elke projectbank hetzelfde bestand.

**Reden 2 — het patroon wordt in de literatuur bekritiseerd.** arXiv **2608.01708** (PGMem): bestaande systemen *"store personas as flat profiles detached from the events that justify them"*, wat de **memory-persona validity gap** veroorzaakt. Hun oplossing koppelt persona-noden aan events via typed provenance- en evidence-edges. Onze persona-aanpak is precies het bekritiseerde patroon.

**Gevolg:** optie D is geschrapt. Global memory gaat via optie B (gedeelde bank).

### 11.2 Consolidatie: mijn advies was te stellig, ingetrokken

arXiv **2605.12978** ("Useful Memories Become Faulty When Continuously Updated by LLMs"):

- consolidatie: nut stijgt eerst, daalt daarna tot onder de no-memory-baseline;
- consolideren uit ground-truth oplossingen faalt bij 54% van eerder opgeloste ARC-AGI-problemen;
- episodisch-only controle blijft concurrerend met de geteste consolidators;
- agents die ruwe episodes bewaren verdubbelen hun accuracy tegenover geforceerde consolidatie.

**Gevolg:** `episodic_memory = 0` is geen defect maar een mogelijk verstandige toestand. `sleep` wordt een expliciet commando, niet een stap in de write-back. Dit haalt mijn eerdere "C nu, D later" eruit.

### 11.3 Wat wél onderbouwd is

| Onderwerp | Bevinding | Ons |
|---|---|---|
| Staleness | **2608.04746** (ScrubJay-MEM): bestaande architecturen behandelen alle memories even persistent en "systematically contaminate retrieved context with outdated facts". Oplossing is per-memory, type-geconditioneerde vervalbaarheid (`π_i`), niet één recency-penalty. Ablatie collapseert de GenGap met 5,7×. | wordt optie E |
| Global memory | **2601.21545** (ShardMemo): harde admissibiliteit (scope) moet vóór relevantie-ranking komen, anders verspilt retrieval budget. +6,8 F1 op LoCoMo. | bevestigt optie B |
| File vs embedded | **2602.23368**: agentic keyword search haat >90% van de RAG-metrics zonder vector database. Ons eigen: 0,083 s per embedding. | file blijft default |

### 11.4 naamverwarring, expliciet

Er bestaat een arXiv-paper "Mnemosyne" (**2510.08601**, *Unsupervised, Human-Inspired Long-Term Memory Architecture for Edge-Based LLMs*, 2025-10-07, health-care-dialogen, edge-devices). Dat is **niet** ons pakket: het onze is van auteur Abdias J, repo `AxDSan/mnemosyne**. De paper is een naamcollisie en geen ruggensteun voor de software die je draait.

Wel gerelateerd: `core/persona.py` in het pakket verwijst naar een "Hy-Memory PersonaTrigger pattern". Hy-Memory heeft een eigen paper (**2610.22196**, 2026-10-15) waarvan de kernclaim is dat de kwaliteit van extern geheugen zit in **de write path** — wat bewaren, hoe representeren, hoe nieuw bewijs bijwerken. Dat is exact ons zwakste punt, en het is een aanwijzing dat de winst in de write path zit, niet in de opslag.
---

## 12. Blokkades vóór implementatie

Review van 16 oktober 2026 op het eigen document. Zes punten; de eerste twee
blokkeren een deepwork-opdracht, de overige moeten opgelost of expliciet
geaccepteerd zijn.

### B1 — De statusregel is niet meer waar

Regel 3 zegt "klaar voor implementatie". Dat klopt niet: `RELEASE-READINESS.md`
vraagt nog een beslissing die hier staat — bouwen we de PRD-werk vóór of ná de
release-readiness-testladder — en het werkvlak D3 heeft nog een ontwerpbesluit
(B2). Zie B2.

### B2 — D3 is niet implementeerbaar zoals beschreven (blokkerend)

"Per-type vervalbaarheid" is een besluit, geen specificatie. Er ontbreken drie
ontwerpbesluiten:

1. **Hoe wordt het type bepaald?** Prompt-pattern, metadata, of een LLM-stap. Een
   LLM-stap is uitgesloten (zie §4). Pattern-matching is zwak maar gratis.
2. **Waar wordt `π_i` opgeslagen?** De `remember`-signature heeft geen veld daarvoor:
   `content, source, importance, metadata, valid_until, scope, extract_entities,
   extract, veracity, trust_tier`. Dus `π_i` moet in `metadata` of in een eigen
   tabel. Of metadata de recall overleeft is **niet geverifieerd**.
3. **Wat doen we met de 186 bestaande memories?** Krijgen ze een π, of laten we ze
   buiten de weging? Dat maakt migratie van bestaande data wél in scope, terwijl §9
   cross-backend migratie juist buiten scope plaatst. Tegenspraak binnen dit
   document.

Zonder deze drie uitkomsten is D3 niet uitvoerbaar en niet te reviewen.

### B3 — Tegenstrijdigheden in §4 en §5

- §5 zegt "de episodic-laag is leeg omdat `sleep` nooit draaide". §4 zegt juist dat
  `episodic_memory = 0` géén defect is. Beide kunnen niet waar zijn.
- §4 annuleert opties B en C, maar ze staan nog als levende opties in de lijst.
- §5 Advies verwijst nog naar het effect van B ("zodra `episodic_memory` groeit").
- §4 verwijst naar "de open vraag hieronder" die niet meer bestaat.

### B4 — "Automatisch" versus "gebruiker markeert globals" (ontwerpbesluit)

§6 optie B zegt: write-back gaat alleen naar de projectbank, "tenzij het een
`global`-markering heeft". Maar de plugin belooft volledig automatisch geheugen. Een
markering die de gebruiker zelf moet aanbrengen, maakt de belofte untrue. Er is geen
besluit genomen over: detecteert de plugin dit zelf, of wordt expliciet markeren een
uitdrukkelijk onderdeel van het contract?

### B5 — Geen gate per onderdeel in §7

De volgorde heeft tijdsinschattingen maar geen exit criteria. Deepwork heeft per stap
een verificatiepoort nodig. Zonder die is "klaar" niet aantoonbaar.

### B6 — De onafhankelijkheidsclaim klopt niet

Regel 5 en §7 noemen onderdelen 1, 2 en 3 onafhankelijk. Dat is te sterk:

- onderdeel 1 voegt `globalBank` en `recallLimit` toe aan de config;
- onderdeel 2 gebruikt precies die `globalBank`;
- onderdeel 3 toont de uitkomst van onderdeel 2 in `/mnemosyne stats`.

De volgorde 1 → 2 → 3 is dus reëel, ook al is de volgorde 1, 2, 3 ook toegestaan is.

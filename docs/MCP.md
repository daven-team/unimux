# Agenci i lokalny MCP

Integracja jest opcjonalna. Nowy grid domyślnie ma **Bez MCP**: uruchamia zwykłe terminale i agentów, zachowując oryginalne prompty startowe. Istniejące gridy nie dostają automatycznie ról ani integracji.

## Włączenie

W oknie „Nowy grid” wybierz rolę dla wybranych komórek:

- **Bez MCP** - zwykły agent, bez połączenia z serwerem Unimux.
- **Wykonawca** - własne zadania, raportowanie wyników, wiadomości do agentów projektu i snippety.
- **Koordynator** - dodatkowo tworzenie gridów, presetów i przydzielanie zadań innym agentom.

Można mieszać wszystkie warianty w jednym gridzie. Role zapisują się w presetach. PowerShell i inne zwykłe powłoki nie korzystają z MCP.

Claude Code i Codex otrzymują konfigurację lokalnego serwera przy uruchamianiu komórki z rolą. Rolę można później zmienić w panelu **AI → Agenci** albo menu komórki. Aplikacja proponuje zastosowanie roli i restart w jednym kroku, ze wznowieniem zapisanej sesji. Jeśli sesja nie jest jeszcze znana, informuje o rozpoczęciu nowej rozmowy. Można też odłożyć restart. Wybranie „Bez MCP” odbiera dostęp do narzędzi; restart usuwa konfigurację z klienta.

Panel rozróżnia wymagany restart, skonfigurowane MCP oczekujące na agenta i faktyczne połączenie. Sam działający serwer nie oznacza, że agent już załadował narzędzia: „MCP działa” pojawia się dopiero, gdy klient agenta pobrał listę narzędzi albo wywołał narzędzie, i znika po 10 minutach bez takiego żądania. Gdy serwer MCP nie wystartował (np. przez oprogramowanie zabezpieczające), aplikacja ponawia start dwa razy, a w panelu jest przycisk **Spróbuj ponownie**.

## Praca z zespołem

Przycisk **AI** otwiera panel agentów, zadań, wiadomości i aktywności. Zadania mają statusy kolejki, pracy, blokady, ukończenia i anulowania. Wynik może zawierać podsumowanie, pliki, gałąź, commit i informacje o testach. Wiadomości mają potwierdzenie przeczytania. Dane zapisują się razem ze stanem aplikacji.

Zadania i wiadomości trafiają do trwałej skrzynki MCP. `read_inbox` odczytuje własne zadania i nieprzeczytane wiadomości razem; `acknowledge: true` zbiorczo potwierdza zwrócone wiadomości. Domyślnie zwraca tylko otwarte zadania (`closed: true` dodaje zamknięte). Wiadomość dłuższa niż 8000 znaków wraca przycięta, ze znacznikiem, i pozostaje nieprzeczytana; całą pobiera się z `full: true` (to ją potwierdza). Gdy nie ma pracy, agent używa `wait_for` zamiast odpytywać serwer: wywołanie czeka do `timeoutSec` (maks. 45 s) i wraca od razu, gdy pojawi się nieprzeczytana wiadomość albo zadanie gotowe do startu, których agent jeszcze nie widział (elementy zwrócone przez `read_inbox` lub wcześniejsze `wait_for` nie budzą ponownie, więc `read_inbox` i `wait_for` nie tworzą pętli; zablokowane zadanie liczy się jako nowe, gdy jego zależności się ukończą; restart komórki zapomina, co pokazano). Z `taskIds` koordynator czeka na ukończenie, zablokowanie lub anulowanie któregokolwiek (`all: true` - wszystkich) z podanych zadań, więc nie musi w pętli wywoływać `get_tasks`; wykonawca może podać tylko własne zadania. Sam serwer nie gwarantuje obudzenia modelu. Potwierdzona, uruchomiona sesja Codexa może dodatkowo otrzymać treść przez `codex queue`. Potwierdzenie wymaga wybrania sesji z historii - dopasowanie pliku rozmowy na podstawie czasu nie wystarcza. Wersja Codexa musi obsługiwać tę komendę.

Dla Claude oraz niepotwierdzonych sesji Codexa dostępne jest **Kopiuj prompt** i ręczne wklejenie do terminala. Błąd dostarczenia nie usuwa zadania. Można ponowić dostarczenie. Anulowanie zadania zmienia jego stan, ale nie przerywa pracy modelu.

Każdy projekt mieści do 500 zadań i 500 wiadomości. Zakończone zadania (ukończone i anulowane) oraz przeczytane wiadomości starsze niż 7 dni są usuwane automatycznie, a gdy projekt jest pełny, miejsce robią najpierw najstarsze z nich. Otwarte zadania, nieprzeczytane wiadomości i ukończone zadania, od których zależy otwarte zadanie, zostają zawsze. Usunięcie projektu usuwa też jego zadania, wiadomości i aktywność. W zakładkach **Zadania** i **Wiadomości** można usunąć pojedynczy zakończony element albo wszystkie naraz (**Usuń zakończone**, **Usuń przeczytane**).

Prompt startowy komórki z rolą tworzy śledzone zadanie i zawiera instrukcję raportowania wyniku. Bez roli prompt pozostaje zwykłym tekstem. Grid utworzony przez agenta działa w tle, bez zmiany aktywnej zakładki. Tworzenie agentów może zużywać limity modeli; instrukcje MCP wymagają wyraźnego polecenia użytkownika dotyczącego delegowania.

**Wstrzymaj automatyzację** blokuje nowe operacje agentów oraz automatyczne dostarczanie. Nadal można odczytywać skrzynki i raportować wyniki trwających zadań. Bezpośrednie utworzenie gridu przez użytkownika pozostaje dostępne.

## Narzędzia

Koordynator może rozbudować bieżący grid przez `create_grid` z `gridId` albo utworzyć nowy zespół w tle przez `create_grid` z `name`. Narzędzie przyjmuje nazwy, kolory, profile, modele i prompty komórek. Cały zespół powstaje jednym wywołaniem `create_grid`, bez `get_context`, `create_task` i `get_tasks`: domyślne profile to `claude` i `codex`, komórka z `count: N` powtarza się N razy (nazwy dostają numer), a `after: [pozycje wcześniejszych komórek]` łączy zadania startowe zależnością (komórka z `role` i `prompt`, odwołanie tylko do wcześniejszych). Wynik zawiera `cellIds` i `tasks` (`{cellId: taskId}`), które można od razu podać do `wait_for`. Przykład: trzech wykonawców i recenzent, którego zadanie czeka na całą trójkę: `cells: [{profileId: "codex", role: "worker", name: "Dev", count: 3, prompt: "..."}, {profileId: "claude", role: "worker", name: "Review", prompt: "...", after: [0, 1, 2]}]`. `update_grid` zmienia nazwę gridu (jego kolor jest tylko zapisywany, pasek kart pokazuje kolor projektu), a `update_agent` nazwę, kolor, profil i model agenta. Modele muszą być obsługiwane przez zainstalowane CLI; zmiana profilu lub modelu obowiązuje przy następnym uruchomieniu. Wynik zawiera `needsRestart` i przyczynę. Opcja `restart` próbuje wznowienia tylko wtedy, gdy środowisko ma potwierdzoną sesję.

Zadania mogą mieć `dependsOn` z identyfikatorami wcześniejszych zadań. `get_tasks` zwraca `ready` i `blockedBy`, a `readyOnly: true` filtruje kolejkę do pracy gotowej do rozpoczęcia. Zadania nie można rozpocząć ani dostarczyć przed ukończeniem zależności. Wyniki z listą plików, kontraktem API i testami stanowią trwałe przekazanie pracy kolejnemu agentowi.

`close_grid` zatrzymuje agentów innego gridu i przenosi go do Historii, zachowując rozmowy i worktree. Niezakończone zadania wymagają `cancelTasks: true` i zostaną anulowane. Koordynator nie może zamknąć własnego gridu przez MCP.

Przykład polecenia: „Dodaj Backend i Reviewer do tego gridu, nadaj im różne kolory. Przydziel zmianę walidacji Backendowi, a zadanie przeglądu uzależnij od jego ukończenia. Wymagaj listy plików i wyników testów. Nie twórz kolejnego gridu”. Przy wspólnym checkoutcie uzgodnij odpowiedzialność za pliki; przy niezależnych gałęziach wybierz worktree.

| Narzędzia | Zastosowanie | Kto |
| --- | --- | --- |
| `get_context`, `list_agents` | Tożsamość komórki i liczniki skrzynki; zwięzła lista agentów (`verbose` dodaje szczegóły) | wszyscy |
| `read_inbox`, `wait_for` | Otwarte zadania i wiadomości razem; ograniczone w czasie oczekiwanie zamiast odpytywania | wszyscy |
| `update_task`, `send_message` | Wynik zadania; wiadomość do agenta | wszyscy |
| `snippets` | `action`: `list`, `get`, `save`, `apply` - biblioteka promptów i presetów | wszyscy |
| `update_agent`, `help` | Nazwa i kolor (własne; wykonawca), profil, model, restart i cudzy agenci (tylko koordynator); dłuższe wyjaśnienia na żądanie | wszyscy |
| `create_task`, `get_tasks`, `deliver` | Przydział zadań, widok zadań projektu (strony, `next`), ponowienie dostarczenia | koordynator |
| `create_grid`, `update_grid`, `close_grid`, `save_preset` | Zespoły w tle (z `gridId` dopisuje komórki), nazwa gridu (kolor tylko zapisywany), archiwizacja, presety | koordynator |

Lista narzędzi zależy od roli: wykonawca nie dostaje narzędzi koordynatora (`create_task`, `get_tasks`, `deliver`, `create_grid`, `update_grid`, `close_grid`, `save_preset`) ani ich schematów, a jego `update_agent` oferuje tylko nazwę i kolor. Koordynator widzi wszystkie. Dawne nazwy (`list_library`, `get_snippet`, `save_snippet`, `apply_snippet`, `add_agents`, `get_messages`, `acknowledge_message`, `deliver_task`, `deliver_message`) nigdy nie są wypisywane, ale pozostają wywoływalne z dawnymi parametrami i pełnymi rekordami w odpowiedzi - tak samo jak narzędzia koordynatora wywołane przez wykonawcę (wtedy rolę egzekwuje usługa). Niewypisane nazwy nie kosztują tokenów. Uprawnienia sprawdza usługa, a nie lista narzędzi; profil, model i restart agenta, także własnego, zmienia wyłącznie koordynator.

Wyniki są zwięzłe: tworzenie zadania i wiadomości zwraca tylko `id` i stan dostarczenia, `update_task` - `id` i status, długie teksty kończą się znacznikiem `...[truncated N chars; full:true for all]`, a listy mają `next`. Odpowiedź to jeden blok tekstu JSON bez `structuredContent`, żeby klient nie liczył jej dwa razy.

## Koszt w tokenach

Każdy agent z włączonym MCP płaci za definicje narzędzi i instrukcje w każdej rozmowie. Szacunek (znaki / 3,6): koordynator ok. 2200 tokenów (było 4425), wykonawca ok. 1190 (było 4425). Pomiar i opóźnienia: `node scripts/mcp-bench.mjs`.

Agent ma dostęp wyłącznie do swojego projektu. Wykonawca widzi własne zadania i wiadomości; koordynator widzi zadania projektu. Snippety globalne są do odczytu, a zapis przez agenta dotyczy projektu. Zmiany ról i pauza są dostępne wyłącznie użytkownikowi.

Serwer Streamable HTTP nasłuchuje tylko na `127.0.0.1`, na losowym porcie. Każda komórka ma osobny token, unieważniany po zakończeniu lub restarcie komórki albo utracie roli; unieważnienie przerywa też trwające żądania tego tokenu (oczekujące `wait_for` kończy się komunikatem "Agent connection has expired."). Token nie trafia do argumentów procesu ani zapisanego stanu aplikacji. Claude dostaje go wyłącznie w prywatnym pliku `--mcp-config` komórki (`mcp/<komórka>.json` w folderze danych aplikacji, zapisywanym atomowo, z uprawnieniami 0600 w folderze 0700 na macOS i Linuksie, a na Windows w profilu użytkownika), a nie w środowisku, więc procesy uruchamiane przez agenta (narzędzia powłoki, skrypty, serwery deweloperskie, pakiety npm) go nie dziedziczą. Plik zostaje, dopóki działa proces komórki (Claude może go przeczytać ponownie przy ponownym połączeniu), i znika razem z tokenem: po zakończeniu lub zatrzymaniu procesu, przy nieudanym starcie, przy starcie bez MCP lub jako Codex oraz przy usunięciu komórki; pozostałości usuwa następne uruchomienie aplikacji. Przy folderze danych podanym przez `MC_DATA_DIR` (tylko do rozwoju i testów) plik chronią uprawnienia tego folderu. Codex potrafi wziąć token serwera HTTP tylko ze zmiennej środowiskowej (`bearer_token_env_var`) albo z `http_headers` w konfiguracji, co wpisałoby token do polecenia w powłoce komórki i jej historii, dlatego komórki Codex nadal dostają `UNIMUX_MCP_TOKEN`; domyślna polityka `shell_environment_policy` Codex pomija zmienne z `TOKEN` w nazwie w poleceniach, które uruchamia, chyba że użytkownik zmienił ją w swojej konfiguracji. Proces tego samego użytkownika, który celowo przeczyta pliki aplikacji, nadal może znaleźć token; ochrona dotyczy przypadkowego dziedziczenia. Komórki uruchomione przez 0.9.3 działają ze starym tokenem ze środowiska do restartu. Serwer odrzuca obce nagłówki Host i Origin (ochrona przed DNS rebinding). Liczbę żądań na token ogranicza koszyk żetonów na zegarze monotonicznym (serie do 120, 60 na sekundę, potem 429 z Retry-After) oraz liczba jednoczesnych żądań (8 na token, 256 łącznie, także 429; odrzucone żądania nie zużywają limitu). Żądania mają limit 256 KiB, a grid do 20 komórek. Gridy tworzone przez agentów ograniczono do 100 komórek w projekcie; skrzynki do 500 zadań i 500 wiadomości na projekt (z automatycznym usuwaniem zakończonych, zob. wyżej), dziennik do 200 zdarzeń. Wynik dłuższy niż 60 000 znaków wraca jako poprawny JSON `{truncated, hint, partial}`. Ponowione wywołanie `create_grid`, `add_agents` lub `close_grid` tego samego agenta (te same argumenty), gdy pierwsze jeszcze trwa albo klient zrezygnował przed odpowiedzią (do 5 minut), dostaje pierwszą odpowiedź zamiast tworzyć drugi zespół; wywołanie, którego odpowiedź dotarła, nigdy nie jest powtarzane; `create_grid` przerwany przez klienta (rozłączenie) w trakcie tworzenia worktree cofa utworzone worktree i niczego nie zapisuje.

## Claude Code i Codex

Claude dostaje `--mcp-config` z plikiem komórki (`type: http`, nagłówek `Authorization: Bearer <token komórki>` wpisany dosłownie), Codex - `-c mcp_servers.unimux.url=...`, `bearer_token_env_var="UNIMUX_MCP_TOKEN"` i `tool_timeout_sec=180` (domyślne 60 s nie wystarcza na `create_grid` z wieloma worktree). Oba klienty łączą się z lokalnym serwerem i widzą te same narzędzia; schematy są płaskie (bez `$ref`, `anyOf` i typów `null`), bo Codex przekazuje je modelowi bez zmian.

Wskazówki narzędzi uwzględnia tylko Codex: pyta użytkownika przed wywołaniem, chyba że narzędzie ma `readOnlyHint` albo `destructiveHint` i `openWorldHint` są fałszywe (Claude Code pyta według własnych reguł uprawnień). Ustawienia:

| Wskazówki | Narzędzia |
| --- | --- |
| tylko odczyt, nie pyta | `get_context`, `list_agents`, `wait_for`, `get_tasks`, `help` |
| zapis własnej pracy, nie pyta | `read_inbox` (z potwierdzeniem), `update_task` wykonawcy, `update_grid`, `save_preset` |
| pyta (`openWorldHint: true`) | `send_message`, `create_task`, `deliver` (docierają do sesji innych agentów), `snippets` (zapisany snippet może być wysyłany automatycznie; `list` i `get` także pytają, bo wskazówka dotyczy całego narzędzia), `update_agent` (nazwa, kolor; koordynator także profil, model, restart), `create_grid` (uruchamia agentów i zużywa limity modeli) |
| pyta (`destructiveHint: true`) | `close_grid` oraz `update_task` koordynatora (może anulować zadania innych komórek) |

Użytkownik, który ufa zespołowi, może zatwierdzić narzędzia z góry w Codexie przez `default_tools_approval_mode` lub `tools.<nazwa>.approval_mode` w `[mcp_servers.unimux]`.

Połączenie można sprawdzić bez modelu: `node scripts/mcp-serve.mjs` uruchamia serwer z atrapami, a `claude mcp add --transport http ...` / `codex mcp add --url ... --bearer-token-env-var ...` z tymczasowym `CLAUDE_CONFIG_DIR` / `CODEX_HOME` oraz `claude mcp list` pokazują stan połączenia.

## Migracja z 0.6.7

Zamierzone zmiany dla klientów wywołujących dawne narzędzia po nazwie:

- Odpowiedź to jeden blok tekstu JSON; `structuredContent` (`{ "result": ... }`) zniknęło.
- Wypisane narzędzia zwracają zwięzłe kształty: `get_context` (`cellId`, `name`, `role`, `project`, liczniki `inbox`; profile tylko z `profiles: true`), `list_agents` (`{ agents, grids }` zamiast tablicy; szczegóły z `verbose`), `read_inbox` (tylko otwarte zadania bez `closed: true`, zamiast `hasMoreTasks`/`hasMoreMessages` jest `more`, brak `createdAt`/`projectId`; `acknowledgedMessageIds` zostaje), `get_tasks` (koordynator: `{ tasks, next }`, wiersze bez promptów bez `verbose`), `create_task`, `send_message`, `update_task`, `update_agent`, `create_grid`, `close_grid`, `update_grid`, `save_preset`, `snippets` (zwięzłe potwierdzenia zamiast zapisanego rekordu).
- `read_inbox` przyjmuje dawne parametry (`limit` do 100, `offset`, `openOnly`); `get_tasks` przyjmuje `limit` do 100; domyślna strona to 20 i 25 zamiast 50.
- `read_inbox` z `acknowledge: true` zostawia przycięte długie wiadomości jako nieprzeczytane.
- Wykonawca nie zmienia już własnego profilu, modelu ani nie restartuje się; `wait_for` dotyczy tylko jego własnych zadań.
- Niewypisane nazwy (`list_library`, `get_snippet`, `save_snippet`, `apply_snippet`, `add_agents`, `get_messages`, `acknowledge_message`, `deliver_task`, `deliver_message` oraz narzędzia koordynatora wywołane przez wykonawcę) zachowują dawne parametry i odpowiedzi.

## Sprawdzenie zmian

```sh
npm run typecheck
npm test
npm run test:automation
```

Test aplikacji używa osobnego katalogu tymczasowego i atrap Claude/Codexa, bez wywoływania modeli. Sprawdza prawdziwe połączenie MCP, formularze, zadania, wyniki, wiadomości, pauzę, tworzenie zwykłego gridu bez MCP i zapis danych. Zrzuty ekranu pozostawia w katalogu wskazanym w wyniku testu. Wymaga Node.js 22 lub nowszego oraz środowiska graficznego Electron.

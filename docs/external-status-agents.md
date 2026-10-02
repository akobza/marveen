# Külső ügynökök állapotsora az Ügynökök nézetben

## Mit tud

Az Ügynökök nézet a flottán KÍVÜLI ügynököknek is mutathat egy **csak állapotot** jelző kártyát: fut-e, mióta van ebben
az állapotban, mikor volt utoljára tevékeny, és mikor frissült az állapot. Ilyen ügynök például egy külön Linux-felhasználóval,
saját homokozóban futó szolgáltatás, amely nem a flotta tagja, a dashboard-tokent nem ismeri, és nem is ismerheti.

A kártyán **nincs vezérlés**: se üzenet, se újraindítás, se más gomb. A dashboard csak olvassa az állapotot.

## Beállítás

1. A gépen egy feladat (például egy percenként futó systemd-időzítő) írja az ügynök állapotfájlját, a dashboard
   felhasználója által olvasható helyre, atomikus cserével. A mezők (JSON):
   `active_state`, `sub_state`, `active_since`, `last_activity`, `last_report`, `updated_at` (UTC ISO-idők) és
   `errors` (az olvashatatlan források NÉVVEL, nem csendes null).
2. A telepítés `store/external-status-agents.json` fájlja sorolja fel az ügynököket (minta:
   `config-examples/external-status-agents.example.json`): `id` (kisbetűs slug), `label` (a kártya felirata),
   `statusFile` (abszolút út), `staleAfterSeconds` (alapérték 120).

A fájl a telepítés `store/` mappájában él, nem a kódban: a név és az út telepítésenként más.

## Megjelenés

- `active_state = active`: **fut**; `inactive`, `failed`, `deactivating`: **áll**; más érték: **ismeretlen állapot**.
- Ha az `updated_at` régebbi, mint a `staleAfterSeconds`, vagy hiányzik: **állapot elavult** (egy régi fájl nem
  látszhat élő állapotnak).
- Hiányzó, olvashatatlan vagy rossz alakú fájl: **az állapot nem olvasható**, hibaoldal nélkül.
- A nem üres `errors` lista a kártyán felsorolva jelenik meg.

A végpont: `GET /api/external-agents` (csak olvasás; írásra, vezérlésre nincs útvonal).

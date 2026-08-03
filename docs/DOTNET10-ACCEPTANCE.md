# SIRK Central .NET 10 — acceptance tests

## Zakres

Docelowy runtime to wyłącznie ASP.NET Core / .NET 10. Testy nie mogą uruchamiać ani proxy'ować backendu Node.js.

## Przygotowanie

1. Zbuduj obraz z `Dockerfile.dotnet10`.
2. Zamontuj trwały katalog `/var/lib/sirk-central`.
3. Ustaw publiczny HTTPS origin i reverse proxy.
4. Utwórz jednorazowy bootstrap secret dla Break Glass.
5. Zachowaj kopię bootstrap secret poza serwerem do czasu ukończenia pierwszego logowania.

## Scenariusze krytyczne

### Break Glass

- pierwsze uruchomienie tworzy identity store;
- poprawny access code i hasło tworzą sesję;
- błędny access code lub hasło nie ujawniają przyczyny;
- rate limit blokuje brute force;
- zmiana hasła wykonuje rewrap backup key bez rotacji identity;
- logout i zmiana identity natychmiast unieważniają sesję.

### Entra ID

- Authorization Code + PKCE;
- allowlist tenant:object ID;
- Auditor/L1/L2/L3 aktywują sesję zgodnie z app role;
- Admin i SecAdmin przechodzą do `pending`;
- approval aktywuje rolę dopiero przy następnym logowaniu;
- konflikt wielu app roles blokuje logowanie;
- disabled identity unieważnia istniejącą sesję.

### WebAuthn / YubiKey

- rejestracja wielu credentials;
- `userVerification=required`;
- challenge jest jednorazowy i wygasa;
- assertion tworzy sesję z `amr=webauthn`;
- counter rollback jest blokowany;
- credential innego użytkownika nie może zostać użyty.

### RBAC i access-control

- Admin nie nadaje ani nie modyfikuje SecAdmin;
- SecAdmin nie nadaje Admin i nie zatwierdza własnej roli;
- Break Glass może utworzyć pierwszy Admin/SecAdmin;
- effective capability jest najbardziej restrykcyjnym wynikiem role/team/Portal policy;
- `approval` nie jest traktowane jak `allow`;
- wyłączenie konta natychmiast blokuje sesję i dostęp do Portali.

### Tenant / Customer / Site

- kody są unikalne w swoim zakresie;
- Site musi należeć do Customer i Tenant;
- Portal może być przypisany tylko do aktywnego Tenant/Customer/Site;
- nie można usunąć obiektu zawierającego aktywne dzieci;
- assignment pozostaje po restarcie.

### Portal protocol i tunnel

- enrollment i token rotation;
- heartbeat HMAC, timestamp i nonce replay protection;
- polling tunnel wymaga credential Portalu;
- response może zakończyć wyłącznie request należący do tego samego Portalu;
- request body powyżej 8 MiB jest odrzucany;
- timeout zwraca 504;
- central session cookie nie jest przekazywane do Portalu;
- `Location` i `Set-Cookie Path` są przepisywane do `/connect/<portalId>/`;
- team/Portal policy `deny` i `approval` blokują połączenie.

### Tickets i Approvals

- event replay jest idempotentny;
- stale update i konflikt tego samego timestampu są odrzucane;
- command queue zachowuje stan po restarcie;
- ACK jest idempotentny;
- approval quorum, reject, cancel, expiry i self-approval guard;
- execution używa idempotency key i nie wykonuje zatwierdzenia drugi raz.

### Backup i restore

- klucz prywatny jest przechowywany zaszyfrowany;
- błędne hasło fail-closed;
- backup: tar.gz + age + SHA-256 metadata;
- restore wymaga wyłącznie hasła Break Glass i confirmation phrase;
- path traversal, symlinki, hardlinki, devices i FIFO są odrzucane;
- safety copy i rollback działają po wymuszonym błędzie;
- staging i plaintext są usuwane;
- restore unieważnia wszystkie sesje.

### Maintenance i release catalog

- policy przeżywa restart i plik ma mode 0600;
- jednocześnie może istnieć tylko jeden aktywny update job;
- update wymaga `UPDATE SIRK CENTRAL`;
- release metadata akceptuje wyłącznie HTTPS i trusted GitHub hosts;
- SHA-256 ma 64 znaki hex;
- stable nie może wskazywać metadata channel `dev`;
- package kończy się `-win-x64.zip`.

## Testy końcowe

- wszystkie workflow PR mają status `success`;
- `SIRK Central .NET 10 Rewrite` przechodzi publish, HTTP smoke, container build i container health;
- UI E2E i Security Audit są zielone;
- cold start, restart i restore testowane na pustym VPS;
- minimum 24 h endurance z cyklicznym heartbeat, ticket sync i tunnel requests;
- test utraty Portalu, restartu Central i ponownego połączenia;
- test pełnego backup → reinstall → password-only restore.

## Kryterium gotowości

Wersja jest gotowa do pełnych testów, gdy wszystkie powyższe scenariusze mają wynik PASS, nie ma otwartych blockerów P0/P1, a obraz `.NET 10` działa bez procesu Node.js.

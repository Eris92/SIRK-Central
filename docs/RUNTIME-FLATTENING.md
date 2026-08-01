# SIRK Central flat runtime

## Status

Migracja runtime została zakończona. Central nie utrzymuje wersjonowanych warstw serwera ani alternatywnych entrypointów.

## Architektura

- `src/server.js` jest jedynym entrypointem Central.
- `src/application.js` tworzy kontekst aplikacji i dokładnie jeden serwer HTTP.
- `src/http/router.js` wykonuje płaski dispatcher tras.
- `src/http/transport.js` jest jedynym źródłem obsługi JSON, body, cookies, CSRF, adresu klienta i nagłówków bezpieczeństwa.
- Moduły domenowe znajdują się w `src/modules/` i rejestrują handlery bez tworzenia własnych serwerów.
- WebSocket tunnel ma jeden handler `upgrade`.
- `src/version.js` jest jedynym źródłem wersji Central.

## Reguły rozwoju

1. Nowa funkcja trafia do istniejącego lub nowego nazwanego modułu domenowego.
2. Moduł nie może tworzyć serwera HTTP ani być samodzielnym entrypointem.
3. Nie wolno dodawać aliasów nazw plików, endpointów, pól lub zmiennych środowiskowych.
4. Zmiana schematu danych wymaga jawnej migracji offline; runtime nie wykonuje cichej migracji.
5. `scripts/validate-runtime-architecture.js` musi pozostać zielony.

## Kryterium CI

CI wymaga jednego entrypointu, jednego `http.createServer()`, osiągalności wszystkich źródeł produkcyjnych oraz braku wycofanych plików i kontraktów.

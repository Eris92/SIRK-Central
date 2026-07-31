# Protokół SIRK Central ↔ Portal

Dokument opisuje kontrakt przygotowany po stronie Central. Repozytorium SIRK Portal nie zostało zmienione w ramach tej pracy.

## Uwierzytelnianie

```text
Authorization: SIRK-Portal <base64url(portalId:token)>
```

Token jest sekretem. Nie wolno umieszczać go w URL, logach ani telemetryce.

## Konfiguracja i heartbeat

```text
GET  /api/portal/v1/config
POST /api/portal/v1/heartbeat
```

Heartbeat wymaga:

```text
X-SIRK-Timestamp: <unix milliseconds>
X-SIRK-Nonce: <unikalny nonce>
X-SIRK-Signature: <HMAC podpis body i metadanych>
```

Central sprawdza credential, HMAC, clock skew, nonce replay, body limit, schema telemetryki i rate limits.

## Polecenia

### Polling

```text
GET /api/portal/v1/commands?limit=20
```

Typy:

```text
backup
update
restart
reconnect
sync
diagnostics
```

Stany:

```text
queued
delivered
running
cancel_requested
completed
failed
cancelled
expired
```

### Standardowy ACK

```text
POST /api/portal/v1/commands/:commandId/ack
Content-Type: application/json
```

```json
{
  "state": "running",
  "progress": 30,
  "message": "Preparing backup"
}
```

Końcowy ACK:

```json
{
  "state": "completed",
  "progress": 100,
  "result": {
    "archive": "created"
  }
}
```

Terminalne ACK są idempotentne wyłącznie dla tego samego stanu. Próba zmiany `completed` na `failed` zwraca `409 COMMAND_ACK_CONFLICT`.

## Cooperative cancellation

Anulowanie queued command jest natychmiastowe. Dla `delivered` lub `running` Central nie udaje, że proces został zatrzymany. Komenda przechodzi w:

```text
cancel_requested
```

Portal dostaje ją ponownie podczas pollingu:

```json
{
  "id": "cmd-...",
  "state": "cancel_requested",
  "control": "cancel",
  "cancelRequestedAtUtc": "2026-07-31T14:00:00.000Z"
}
```

Wymagany algorytm Portalu:

1. odszukaj lokalną operację po `commandId`;
2. rozpocznij bezpieczne zatrzymanie;
3. jeżeli zatrzymanie trwa, możesz wysłać ACK `running` z aktualnym postępem — Central utrzyma `cancel_requested`;
4. po faktycznym zatrzymaniu wyślij ACK `cancelled`;
5. jeżeli operacja zakończyła się przed anulowaniem, wyślij rzeczywisty `completed` lub `failed`.

ACK anulowania:

```json
{
  "state": "cancelled",
  "progress": 55,
  "message": "Stopped safely",
  "result": {
    "rollback": "completed"
  }
}
```

Portal nie może wysłać `cancelled`, jeżeli Central nie ustawił `cancel_requested`; taka próba zwraca `409 COMMAND_CANCEL_NOT_REQUESTED`.

Control message ma lease i jest ponawiany, dlatego implementacja Portalu musi być idempotentna.

## Zgłoszenia

### Polityka

```text
GET /api/portal/v1/ticket-policy
```

Domyślna polityka jest fail-closed:

```json
{
  "mode": "none",
  "includeDescription": false,
  "includeRequester": false,
  "allowCentralChanges": false
}
```

### Snapshot

```text
POST /api/portal/v1/tickets/snapshot
```

Snapshot może zawierać maksymalnie 5000 zgłoszeń. `generatedAtUtc` i `cursor` są używane do ochrony kolejności i replay.

### Pojedynczy event

```text
POST /api/portal/v1/tickets/events
```

Body jest bezpośrednio eventem:

```json
{
  "eventId": "evt-1001",
  "type": "ticket.status_changed",
  "occurredAtUtc": "2026-07-31T12:10:00Z",
  "ticket": {
    "ticketId": "tck-1001",
    "status": "waiting_for_user",
    "updatedAtUtc": "2026-07-31T12:10:00Z"
  }
}
```

Odpowiedzi pojedynczego eventu zachowują właściwy status HTTP:

```text
202 accepted/duplicate/stale/skipped
400 invalid event/schema
409 replay conflict lub ordering conflict
429 rate limit
5xx transient server error
```

Przykład konfliktu replay:

```json
{
  "ok": false,
  "code": "TICKET_EVENT_REPLAY_CONFLICT",
  "error": "Event ID was already used with a different payload.",
  "retryable": false
}
```

### Batch eventów

Jawny batch wymaga tablicy:

```json
{
  "events": [
    {
      "eventId": "evt-1001",
      "type": "ticket.created",
      "occurredAtUtc": "2026-07-31T12:10:00Z",
      "ticket": {
        "ticketId": "tck-1001",
        "title": "Brak dostępu",
        "status": "new",
        "priority": "high",
        "createdAtUtc": "2026-07-31T12:10:00Z",
        "updatedAtUtc": "2026-07-31T12:10:00Z"
      }
    }
  ]
}
```

`events` o innym typie niż tablica zwraca `400 TICKET_EVENTS_INVALID`. Maksymalny batch to 500 elementów.

HTTP `207 Multi-Status` jest używany wyłącznie, gdy jawny batch zawiera co najmniej jeden odrzucony element. Każdy wynik ma:

```json
{
  "index": 1,
  "rejected": true,
  "status": 409,
  "retryable": false,
  "code": "TICKET_EVENT_REPLAY_CONFLICT",
  "error": "Event ID was already used with a different payload."
}
```

Portal powinien ponawiać wyłącznie elementy z `retryable: true`. Nie wolno ponawiać całego batcha bez sprawdzenia wyników, ponieważ poprawne elementy mogły zostać zapisane.

## Typy eventów

```text
ticket.created
ticket.updated
ticket.status_changed
ticket.assigned
ticket.comment_added
ticket.sla_breached
ticket.closed
ticket.sync_failed
```

## Statusy i priorytety

```text
new
accepted
in_progress
waiting_for_user
waiting_for_external
resolved
closed
cancelled
```

```text
low
normal
high
critical
```

## Synchronizacja i konflikty

Portal pozostaje właścicielem connectora do systemu zewnętrznego. Central przechowuje projekcję. Klucz projekcji to `portalId + ticketId`.

- starsza aktualizacja nie nadpisuje nowszej;
- ten sam timestamp z innym payloadem jest konfliktem;
- ten sam `eventId` lub `cursor` z innym payloadem jest konfliktem replay;
- Tenant/Customer/Site pochodzą z assignment Central, nie z body Portalu;
- Portal nie może modyfikować metadanych `central`.

## Wymagania przyszłej implementacji Portalu

- chroniony storage tokenu;
- podpis heartbeat i ochrona replay;
- trwała lokalna kolejka commands i ACK;
- idempotentne wykonanie `commandId`;
- cooperative cancellation zgodne z powyższym kontraktem;
- per-item retry dla HTTP 207;
- brak sekretów connectorów w danych przesyłanych do Central;
- redakcja PII zgodnie z ticket policy;
- wersjonowanie protokołu i `minimumSupportedVersion`.

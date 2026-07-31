# Protokół SIRK Central ↔ Portal

Dokument opisuje kontrakt przygotowany po stronie Central. Repozytorium SIRK Portal nie zostało zmienione w ramach tej pracy.

## Uwierzytelnianie

```text
Authorization: SIRK-Portal <base64url(portalId:token)>
```

Token musi być traktowany jako sekret. Nie wolno umieszczać go w URL, logach ani telemetryce.

## Konfiguracja

```text
GET /api/portal/v1/config
```

Zwraca między innymi czas serwera oraz parametry heartbeat.

## Heartbeat

```text
POST /api/portal/v1/heartbeat
```

Nagłówki:

```text
X-SIRK-Timestamp: <unix milliseconds>
X-SIRK-Nonce: <unikalny nonce>
X-SIRK-Signature: <HMAC podpis body i metadanych>
```

Central kontroluje:

- poświadczenie Portalu,
- podpis,
- clock skew,
- nonce/replay,
- limit body,
- strukturę telemetryki.

Przykładowe obszary danych:

```json
{
  "portalVersion": "1.0.0",
  "commit": "abcdef1",
  "health": "ok",
  "agentCount": 40,
  "onlineAgents": 37,
  "resources": {
    "cpuPercent": 12,
    "memoryMb": 640
  },
  "backup": {
    "status": "ok",
    "lastSuccessAtUtc": "2026-07-31T10:00:00Z"
  },
  "update": {
    "availableVersion": null
  }
}
```

## Polecenia

### Pobranie

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

### Potwierdzenie

```text
POST /api/portal/v1/commands/:commandId/ack
```

Przykład:

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

Dozwolone stany kolejki:

```text
queued
delivered
running
completed
failed
cancelled
expired
```

## Zgłoszenia

### Pobranie polityki

```text
GET /api/portal/v1/ticket-policy
```

Polityka określa między innymi:

- czy publikować zgłoszenia,
- które statusy i priorytety,
- czy przesyłać opis,
- czy przesyłać dane zgłaszającego,
- czy Central może koordynować status i przypisanie.

### Snapshot

```text
POST /api/portal/v1/tickets/snapshot
```

Snapshot powinien być ograniczony do zgłoszeń zgodnych z polityką Portalu.

Przykład:

```json
{
  "generatedAtUtc": "2026-07-31T12:00:00Z",
  "tickets": [
    {
      "ticketId": "tck-1001",
      "externalSystem": "jira",
      "externalId": "IT-4182",
      "title": "Brak dostępu do ERP",
      "status": "in_progress",
      "priority": "high",
      "updatedAtUtc": "2026-07-31T11:55:00Z",
      "sla": {
        "breached": false
      },
      "sync": {
        "state": "synchronized"
      }
    }
  ]
}
```

### Zdarzenia

```text
POST /api/portal/v1/tickets/events
```

Typy:

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

Przykład:

```json
{
  "events": [
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
  ]
}
```

## Znormalizowane statusy zgłoszeń

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

## Znormalizowane priorytety

```text
low
normal
high
critical
```

## Synchronizacja i konflikty

Portal pozostaje właścicielem integracji z systemem zewnętrznym. Central przechowuje projekcję. Portal powinien przekazywać:

- `updatedAtUtc`,
- stan synchronizacji,
- identyfikator zewnętrzny,
- informację o konflikcie lub błędzie.

Starsza aktualizacja nie może nadpisywać nowszej projekcji.

## Symulator

```bash
export SIRK_SIMULATOR_ORIGIN='https://central.sirkportal.com'
export SIRK_SIMULATOR_PORTAL_ID='<PORTAL_ID>'
export SIRK_SIMULATOR_PORTAL_TOKEN='<PORTAL_TOKEN>'

node scripts/portal-simulator.js
```

Symulator sprawdza heartbeat, konfigurację, politykę zgłoszeń, snapshot, zdarzenia, pobranie komend i ACK.

## Wymagania bezpieczeństwa dla przyszłej implementacji Portalu

- token przechowywany w chronionym magazynie,
- podpis heartbeat z ochroną replay,
- idempotentne ACK,
- trwała lokalna kolejka przy braku Central,
- ograniczenie rozmiaru snapshotów,
- brak sekretów connectorów w danych przesyłanych do Central,
- redakcja opisów i danych osobowych zgodnie z polityką,
- wersjonowanie protokołu i obsługa `minimumSupportedVersion`.

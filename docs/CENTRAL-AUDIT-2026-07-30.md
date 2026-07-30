# SIRK Central — audyt przed domknięciem funkcji

Data: 2026-07-30
Zakres: wyłącznie SIRK Central. Integracja z lokalnym SIRK Portal jest odłożona do następnego etapu.

## Cel etapu

Doprowadzić SIRK Central do stanu, w którym samodzielnie i spójnie obsługuje:

- Entra ID i lokalny break-glass,
- role, zespoły i zakres dostępu,
- Customer, Site i rejestr Portali,
- zatwierdzanie ról uprzywilejowanych,
- sesje, audyt i centrum bezpieczeństwa,
- bezpieczny deployment, aktualizacje, backup i odtwarzanie,
- przygotowane kontrakty API pod późniejszą integrację Portalu.

## Stan potwierdzony w repozytorium

Central ma obecnie:

- aplikację Node.js bez frameworka HTTP,
- SSO ticket z Auth Brokerem,
- lokalne logowanie break-glass ukryte kluczem access,
- role i uprawnienia w `src/rbac.js`,
- użytkowników lokalnych i Entra,
- zatwierdzanie uprzywilejowanych ról Entra,
- zespoły i polityki dostępu,
- rejestr Portali i broker tuneli WSS,
- centrum bezpieczeństwa, incydenty i audyt,
- Caddy, Docker Compose i skrypty wdrożeniowe,
- chronione workspace: `/permissions`, `/security`, `/settings`, `/break-glass`.

## Ustalenia krytyczne

### P0 — przed dalszym rozszerzaniem funkcji

1. **Sesje są przechowywane tylko w pamięci procesu.**
   Restart kontenera wylogowuje wszystkich, nie ma współdzielenia sesji między instancjami i nie ma trwałej listy unieważnień.

2. **Endpoint administracyjny ujawnia pełny token sesji.**
   `publicSessions()` zwraca zarówno skrócone `id`, jak i pełne `token`. Pełny sekret sesyjny nie może być zwracany do interfejsu ani audytu.

3. **Brak pełnego mechanizmu CSRF.**
   Kontrola `Origin` jest używana przy części operacji, ale brak tokenu CSRF powiązanego z sesją. Brak nagłówka `Origin` jest obecnie akceptowany.

4. **Zmiana hasła break-glass i rotacja access key nie unieważnia aktywnych sesji break-glass.**
   Po rotacji stare aktywne sesje pozostają ważne.

5. **Statyczny token Portalu stanowi długotrwałe poświadczenie.**
   Przed integracją należy dodać rotację, status, datę ostatniego użycia, unieważnianie i docelowo certyfikat urządzenia lub podpisane challenge.

6. **Reverse proxy Portalu modyfikuje treść tekstową wyrażeniami regularnymi.**
   Jest to rozwiązanie przejściowe. Nie może być traktowane jako finalna granica bezpieczeństwa dla pełnej integracji aplikacji.

### P1 — wymagane do produkcyjnego Centrala

1. Trwały magazyn sesji i unieważnień.
2. CSRF dla wszystkich operacji modyfikujących.
3. Oddzielne identyfikatory sesji publicznych, bez ujawniania tokenów.
4. Idle timeout oraz absolute timeout.
5. Wymuszenie ponownego uwierzytelnienia dla operacji break-glass i krytycznych zmian.
6. Unieważnianie sesji po zmianie roli, hasła, statusu konta i ustawień bezpieczeństwa.
7. Pełny lifecycle użytkownika: active, pending, disabled, rejected, locked.
8. Customer i Site jako niezależne encje, a Portal przypisany do Site.
9. Spójna polityka Admin/SecAdmin zgodna z zasadą rozdziału obowiązków.
10. Eksport audytu, retencja, filtrowanie, identyfikator korelacji i ochrona przed modyfikacją.
11. Backup oraz restore danych Centrala i danych Caddy.
12. Health/readiness obejmujące magazyn danych i konfigurację.
13. Automatyczne testy negatywne RBAC, CSRF, SSO replay i break-glass.
14. Limity zapytań dla logowania, SSO, API i tunelu.
15. Kontrola nagłówków proxy i zaufanych adresów reverse proxy.

### P2 — przygotowanie do późniejszej integracji Portalu

1. Rejestracja Portalu z enrollment tokenem jednorazowym.
2. Osobne poświadczenie każdego Portalu.
3. Rotacja poświadczenia Portalu.
4. Podpisany krótko żyjący token wejścia do Portalu.
5. Jawny kontrakt mapowania ról Central → Portal.
6. Execution Token dla konkretnej operacji i zakresu.
7. Rejestracja rozpoczęcia, zakończenia i wyniku sesji zdalnej.
8. Brak przechowywania haseł klientów w Centralu.

## Docelowy model danych Centrala

```text
Tenant
└── Customer
    └── Site
        └── Portal

User / Entra identity
└── Team membership
    └── Scope: Tenant / Customer / Site / Portal
        └── Role
            └── Capability policy
```

Minimalne encje:

- tenants,
- customers,
- sites,
- portals,
- identities,
- local users,
- teams,
- memberships,
- role assignments,
- capability policies,
- approvals,
- sessions,
- audit events,
- incidents,
- security policies.

## Docelowe role

- **BreakGlass** — lokalne konto awaryjne, niewidoczne bez access key, pełny dostęp, ścisły audyt.
- **SecAdmin** — bezpieczeństwo, role uprzywilejowane, sesje, audyt, incydenty i polityki.
- **Admin** — tenanty, Customer, Site, Portale, użytkownicy nieuprzywilejowani i operacyjne ustawienia.
- **Auditor** — tylko odczyt konfiguracji i audytu.
- **Operator** — dostęp operacyjny do przypisanych zakresów.

Poziomy L1/L2/L3 powinny być realizowane jako zespoły/capabilities albo jawne role operacyjne, ale nie mogą mieszać się z Admin/SecAdmin.

## Kolejność realizacji

### Faza 1 — fundament bezpieczeństwa

- naprawa ekspozycji tokenów sesji,
- trwałe sesje,
- CSRF,
- unieważnianie sesji,
- timeouty,
- ponowne uwierzytelnienie dla operacji krytycznych,
- testy bezpieczeństwa.

### Faza 2 — pełny RBAC i struktura organizacyjna

- Tenant, Customer, Site,
- zakresy przypisań,
- zespoły,
- rozdział Admin/SecAdmin,
- pending approvals,
- pełny lifecycle kont.

### Faza 3 — operacje i centrum bezpieczeństwa

- trwały i filtrowany audyt,
- incydenty,
- eksport,
- sesje administracyjne,
- tryb awaryjny,
- alerty o użyciu break-glass.

### Faza 4 — deployment i eksploatacja

- backup/restore,
- readiness,
- aktualizacja z rollbackiem,
- test instalacji od zera,
- test odtworzenia,
- dokumentacja runbook.

### Faza 5 — kontrakty pod Portal

- enrollment,
- identity Portalu,
- SSO/portal access token,
- execution token,
- mapowanie ról i capabilities.

## Kryteria ukończenia etapu Central

Central można uznać za gotowy do rozpoczęcia integracji z Portalem, gdy:

- wszystkie testy RBAC i bezpieczeństwa przechodzą,
- żaden sekret sesji nie jest zwracany przez API,
- zmiany ról i poświadczeń natychmiast unieważniają właściwe sesje,
- Customer, Site i Portal mają trwały model oraz zakresy dostępu,
- Admin i SecAdmin mają rozdzielone kompetencje,
- backup i restore są przetestowane,
- instalacja i aktualizacja są powtarzalne,
- audyt zawiera kto, co, gdzie, kiedy i wynik,
- kontrakty integracyjne nie wymagają przechowywania haseł klientów w Centralu.

# sir-k.pl na tym samym VPS co SIRK Portal

Strona `sir-k.pl` jest serwowana przez ten sam kontener Caddy co:

- `sirkportal.com`,
- `central.sirkportal.com`,
- `auth.sirkportal.com`.

Repozytorium strony powinno znajdować się w:

```text
/opt/sir-k.pl
```

Caddy montuje ten katalog tylko do odczytu jako `/srv/sir-k`.

DNS:

```text
sir-k.pl      A/AAAA -> VPS
www.sir-k.pl  A/AAAA -> VPS
```

Aktualizacja strony nie wymaga uruchamiania drugiego reverse proxy. Po aktualizacji plików wystarczy:

```bash
cd /opt/sirk-central
docker compose --profile auth up -d --force-recreate caddy
```

 Cloudflare Workers

Esta carpeta ya deja una base funcional para migrar la app a Cloudflare.

## Qué incluye

- `wrangler.toml`
- `schema.sql`
- `src/worker.js`
- `public/index.html`

## Qué ya funciona

- login
- cerrar sesión
- cambio de contraseña
- alta y consulta de sucursales
- alta, consulta y borrado de productos
- alta y consulta de precios por sucursal

## Qué sigue pendiente

- envíos
- captura diaria de sucursales
- reportes completos
- persistencia avanzada equivalente a la versión Flask

## Pasos

1. Crea la base D1:

```bash
wrangler d1 create bakery-shop-db
```

2. Copia el `database_id` que te devuelva Cloudflare y reemplázalo en `wrangler.toml`.

3. Crea las tablas:

```bash
wrangler d1 execute bakery-shop-db --file=schema.sql
```

4. Agrega un secreto para las sesiones:

```bash
wrangler secret put SECRET_KEY
```

5. Publica:

```bash
wrangler deploy
```

## Cuenta inicial

- usuario: `admin`
- contraseña: `admin123`

El usuario se crea automáticamente en la primera petición si todavía no existe.

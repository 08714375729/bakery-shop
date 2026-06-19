const SESSION_COOKIE = "bakery_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

export default {
  async fetch(request, env) {
    try {
      await ensureSeedData(env);

      const url = new URL(request.url);

      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204 });
      }

      if (url.pathname.startsWith("/api/")) {
        return handleApi(request, env, url);
      }

      if (url.pathname === "/report-print") {
        return handleReportPrint(request, env, url);
      }

      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return new Response("Asset no encontrado", { status: 404 });
    } catch (error) {
      console.error("Worker error:", error);
      return jsonErr("Error interno del servidor", 500);
    }
  },
};

async function handleApi(request, env, url) {
  const { pathname } = url;

  if (pathname === "/api/me" && request.method === "GET") {
    const account = await getCurrentAccount(request, env);
    if (!account) {
      return jsonOk(null, { authenticated: false });
    }
    return jsonOk(accountPayload(account), { authenticated: true });
  }

  if (pathname === "/api/login" && request.method === "POST") {
    const body = await safeJson(request);
    const username = String(body.username || "").trim();
    const password = String(body.password || "").trim();

    if (!username || !password) {
      return jsonErr("Usuario y contraseña son obligatorios");
    }

    const account = await env.DB.prepare(
      `SELECT u.*, s.name AS store_name
       FROM users u
       LEFT JOIN stores s ON s.id = u.store_id
       WHERE u.username = ?1
       LIMIT 1`
    )
      .bind(username)
      .first();

    if (!account || Number(account.active) !== 1) {
      return jsonErr("Usuario o contraseña incorrectos", 401);
    }

    const passwordHash = await hashPassword(password);
    if (passwordHash !== account.password_hash) {
      return jsonErr("Usuario o contraseña incorrectos", 401);
    }

    const token = await createSessionToken(account.id, getSecret(env));
    return jsonOk(accountPayload(account), {}, {
      headers: {
        "Set-Cookie": serializeCookie(SESSION_COOKIE, token, {
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
          path: "/",
          maxAge: SESSION_TTL_SECONDS,
        }),
      },
    });
  }

  if (pathname === "/api/logout" && request.method === "POST") {
    return jsonOk(null, {}, {
      headers: {
        "Set-Cookie": serializeCookie(SESSION_COOKIE, "", {
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
          path: "/",
          maxAge: 0,
        }),
      },
    });
  }

  if (pathname === "/api/change-password" && request.method === "POST") {
    const account = await requireLogin(request, env);
    if (account.error) return account.error;

    const body = await safeJson(request);
    const currentPassword = String(body.current_password || "").trim();
    const newPassword = String(body.new_password || "").trim();
    const confirmPassword = String(body.confirm_password || "").trim();

    if (!currentPassword || !newPassword || !confirmPassword) {
      return jsonErr("Completa todos los campos de contraseña");
    }

    const currentHash = await hashPassword(currentPassword);
    if (currentHash !== account.password_hash) {
      return jsonErr("La contraseña actual es incorrecta");
    }

    if (newPassword.length < 6) {
      return jsonErr("La nueva contraseña debe tener al menos 6 caracteres");
    }

    if (newPassword !== confirmPassword) {
      return jsonErr("La confirmación no coincide con la nueva contraseña");
    }

    const newHash = await hashPassword(newPassword);
    await env.DB.prepare("UPDATE users SET password_hash = ?1 WHERE id = ?2")
      .bind(newHash, account.id)
      .run();

    return jsonOk({ message: "Contraseña actualizada" });
  }

  if (pathname === "/api/stores" && request.method === "GET") {
    const account = await requireLogin(request, env);
    if (account.error) return account.error;

    const stmt =
      account.role === "admin"
        ? env.DB.prepare(
            `SELECT s.*
             FROM stores s
             ORDER BY s.id DESC`
          )
        : env.DB.prepare(
            `SELECT s.*
             FROM stores s
             WHERE s.id = ?1
             ORDER BY s.id DESC`
          ).bind(account.store_id);

    const result = await stmt.all();
    const rows = (result.results || []).map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      settlement_type: row.settlement_type,
      username: buildStoreUsername(row.code),
      default_password: account.role === "admin" ? "123456" : null,
    }));

    return jsonOk(rows);
  }

  if (pathname === "/api/stores" && request.method === "POST") {
    const account = await requireAdmin(request, env);
    if (account.error) return account.error;

    const body = await safeJson(request);
    const code = String(body.code || "").trim();
    const name = String(body.name || "").trim();
    const address = String(body.address || "").trim();
    const settlementType = String(body.settlement_type || "cash").trim() || "cash";

    if (!code || !name) {
      return jsonErr("Código y nombre son obligatorios");
    }

    const existing = await env.DB.prepare("SELECT id FROM stores WHERE code = ?1 LIMIT 1")
      .bind(code)
      .first();

    if (existing) {
      return jsonErr("Ese código de sucursal ya existe");
    }

    const insertStore = await env.DB.prepare(
      `INSERT INTO stores (code, name, address, settlement_type)
       VALUES (?1, ?2, ?3, ?4)`
    )
      .bind(code, name, address, settlementType)
      .run();

    const storeId = insertStore.meta.last_row_id;
    const username = buildStoreUsername(code);
    const passwordHash = await hashPassword("123456");

    await env.DB.prepare(
      `INSERT OR REPLACE INTO users (id, username, password_hash, role, display_name, store_id, active, created_at)
       VALUES (
         COALESCE((SELECT id FROM users WHERE username = ?1), NULL),
         ?1, ?2, 'store', ?3, ?4, 1,
         COALESCE((SELECT created_at FROM users WHERE username = ?1), CURRENT_TIMESTAMP)
       )`
    )
      .bind(username, passwordHash, `${name} sucursal`, storeId)
      .run();

    return jsonOk({ id: storeId, username, default_password: "123456" });
  }

  if (pathname === "/api/products" && request.method === "GET") {
    const account = await requireLogin(request, env);
    if (account.error) return account.error;

    const result = await env.DB.prepare(
      `SELECT id, sku, name, category, unit, default_price
       FROM products
       ORDER BY id DESC`
    ).all();

    const rows = (result.results || []).map((row) => ({
      id: row.id,
      sku: row.sku,
      name: row.name,
      category: row.category || "General",
      unit: row.unit || "piece",
      default_price: Number(row.default_price || 0),
    }));

    return jsonOk(rows);
  }

  if (pathname === "/api/products" && request.method === "POST") {
    const account = await requireAdmin(request, env);
    if (account.error) return account.error;

    const body = await safeJson(request);
    const sku = String(body.sku || "").trim();
    const name = String(body.name || "").trim();
    const category = String(body.category || "General").trim() || "General";
    const unit = String(body.unit || "piece").trim() || "piece";
    const defaultPrice = Number(body.default_price || 0);

    if (!sku || !name) {
      return jsonErr("SKU y nombre son obligatorios");
    }

    const existing = await env.DB.prepare("SELECT id FROM products WHERE sku = ?1 LIMIT 1")
      .bind(sku)
      .first();

    if (existing) {
      return jsonErr("Ese SKU ya existe");
    }

    const insertProduct = await env.DB.prepare(
      `INSERT INTO products (sku, name, category, unit, default_price)
       VALUES (?1, ?2, ?3, ?4, ?5)`
    )
      .bind(sku, name, category, unit, defaultPrice)
      .run();

    return jsonOk({ id: insertProduct.meta.last_row_id });
  }

  const deleteMatch = pathname.match(/^\/api\/products\/(\d+)\/delete$/);
  if (deleteMatch && request.method === "POST") {
    const account = await requireAdmin(request, env);
    if (account.error) return account.error;

    const productId = Number(deleteMatch[1]);
    const product = await env.DB.prepare("SELECT id FROM products WHERE id = ?1 LIMIT 1")
      .bind(productId)
      .first();

    if (!product) {
      return jsonErr("El producto no existe", 404);
    }

    await env.DB.prepare("DELETE FROM products WHERE id = ?1").bind(productId).run();
    await env.DB.prepare("DELETE FROM store_product_prices WHERE product_id = ?1").bind(productId).run();
    return jsonOk({ id: productId });
  }

  if (pathname === "/api/prices" && request.method === "GET") {
    const account = await requireLogin(request, env);
    if (account.error) return account.error;

    const baseSql = `
      SELECT spp.id, spp.store_id, spp.product_id, spp.price, spp.effective_from,
             s.name AS store_name, p.name AS product_name
      FROM store_product_prices spp
      JOIN stores s ON s.id = spp.store_id
      JOIN products p ON p.id = spp.product_id
      ${account.role === "admin" ? "" : "WHERE spp.store_id = ?1"}
      ORDER BY spp.id DESC
      LIMIT 200`;

    const result =
      account.role === "admin"
        ? await env.DB.prepare(baseSql).all()
        : await env.DB.prepare(baseSql).bind(account.store_id).all();

    const rows = (result.results || []).map((row) => ({
      id: row.id,
      store_id: row.store_id,
      store_name: row.store_name,
      product_id: row.product_id,
      product_name: row.product_name,
      price: Number(row.price || 0),
      effective_from: row.effective_from,
    }));

    return jsonOk(rows);
  }

  if (pathname === "/api/prices" && request.method === "POST") {
    const account = await requireAdmin(request, env);
    if (account.error) return account.error;

    const body = await safeJson(request);
    const storeId = Number(body.store_id || 0);
    const productId = Number(body.product_id || 0);
    const price = Number(body.price || 0);
    const effectiveFrom = String(body.effective_from || todayStr()).trim();

    if (!storeId || !productId || !price || price <= 0) {
      return jsonErr("store_id, product_id y price deben ser válidos");
    }

    const store = await env.DB.prepare("SELECT id FROM stores WHERE id = ?1 LIMIT 1").bind(storeId).first();
    const product = await env.DB.prepare("SELECT id FROM products WHERE id = ?1 LIMIT 1").bind(productId).first();
    if (!store || !product) {
      return jsonErr("La sucursal o el producto no existen", 404);
    }

    const insertPrice = await env.DB.prepare(
      `INSERT INTO store_product_prices (store_id, product_id, price, effective_from)
       VALUES (?1, ?2, ?3, ?4)`
    )
      .bind(storeId, productId, price, effectiveFrom)
      .run();

    return jsonOk({ id: insertPrice.meta.last_row_id });
  }

  if (pathname === "/api/deliveries" && request.method === "GET") {
    const account = await requireLogin(request, env);
    if (account.error) return account.error;
    return jsonOk([]);
  }

  const deliveryStopsMatch = pathname.match(/^\/api\/deliveries\/(\d+)\/stops$/);
  if (deliveryStopsMatch && request.method === "GET") {
    const account = await requireLogin(request, env);
    if (account.error) return account.error;
    return jsonOk([]);
  }

  const stopDetailMatch = pathname.match(/^\/api\/stops\/(\d+)$/);
  if (stopDetailMatch && request.method === "GET") {
    const account = await requireLogin(request, env);
    if (account.error) return account.error;
    return jsonErr("El módulo de detalle de envíos aún no está migrado a Cloudflare", 501);
  }

  if (pathname === "/api/deliveries/direct" && request.method === "POST") {
    const account = await requireAdmin(request, env);
    if (account.error) return account.error;
    return jsonErr("El módulo de envíos aún no está migrado a Cloudflare", 501);
  }

  if (pathname === "/api/branch-daily" && request.method === "GET") {
    const account = await requireLogin(request, env);
    if (account.error) return account.error;
    return jsonOk([]);
  }

  if (pathname === "/api/branch-daily/form" && request.method === "GET") {
    const account = await requireLogin(request, env);
    if (account.error) return account.error;

    const storeId = Number(url.searchParams.get("store_id") || 0);
    const bizDate = String(url.searchParams.get("biz_date") || todayStr());

    if (storeId && account.role !== "admin" && Number(account.store_id) !== storeId) {
      return jsonErr("No tienes permiso para ver esa sucursal", 403);
    }

    return jsonOk({
      store_id: storeId,
      biz_date: bizDate,
      received_amount: 0,
      loss_amount: 0,
      loss_note: "",
      items: [],
    });
  }

  if (pathname === "/api/branch-daily" && request.method === "POST") {
    const account = await requireLogin(request, env);
    if (account.error) return account.error;
    return jsonErr("El módulo de captura de sucursal aún no está migrado a Cloudflare", 501);
  }

  if (pathname === "/api/reports/branch-daily" && request.method === "GET") {
    const account = await requireLogin(request, env);
    if (account.error) return account.error;
    return jsonOk(buildEmptyReport(String(url.searchParams.get("biz_date") || todayStr())));
  }

  return jsonErr("Ruta no encontrada", 404);
}

async function handleReportPrint(request, env, url) {
  const account = await getCurrentAccount(request, env);
  if (!account) {
    return new Response("Primero inicia sesión", { status: 401 });
  }

  const report = buildEmptyReport(String(url.searchParams.get("biz_date") || todayStr()));
  const html = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <title>Reporte diario ${escapeHtml(report.biz_date)}</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 24px; color: #222; }
      h1 { margin-bottom: 8px; }
      .card { border: 1px solid #ddd; border-radius: 8px; padding: 16px; margin-top: 16px; }
    </style>
  </head>
  <body>
    <h1>Reporte diario</h1>
    <div>Fecha: ${escapeHtml(report.biz_date)}</div>
    <div class="card">
      Esta primera versión en Cloudflare ya incluye login, sucursales, productos y precios.
      Los módulos de envíos, captura diaria y reportes completos siguen en migración.
    </div>
  </body>
</html>`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function ensureSeedData(env) {
  const adminHash = await hashPassword("admin123");
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (username, password_hash, role, display_name, active)
     VALUES (?1, ?2, 'admin', 'Administrador central', 1)`
  )
    .bind("admin", adminHash)
    .run();
}

async function getCurrentAccount(request, env) {
  const userId = await readSessionUserId(request, getSecret(env));
  if (!userId) return null;

  const account = await env.DB.prepare(
    `SELECT u.*, s.name AS store_name
     FROM users u
     LEFT JOIN stores s ON s.id = u.store_id
     WHERE u.id = ?1
     LIMIT 1`
  )
    .bind(userId)
    .first();

  if (!account || Number(account.active) !== 1) {
    return null;
  }

  return account;
}

async function requireLogin(request, env) {
  const account = await getCurrentAccount(request, env);
  if (!account) {
    return { error: jsonErr("Primero inicia sesión", 401) };
  }
  return account;
}

async function requireAdmin(request, env) {
  const account = await requireLogin(request, env);
  if (account.error) return account;
  if (account.role !== "admin") {
    return { error: jsonErr("Solo el administrador puede hacer esta acción", 403) };
  }
  return account;
}

function accountPayload(account) {
  return {
    id: account.id,
    username: account.username,
    role: account.role,
    display_name: account.display_name || account.username,
    store_id: account.store_id,
    store_name: account.store_name || null,
  };
}

function buildStoreUsername(code) {
  return `store_${String(code || "").trim().toLowerCase()}`;
}

function buildEmptyReport(bizDate) {
  return {
    biz_date: bizDate,
    summary: {
      store_count: 0,
      sent_store_count: 0,
      sent_amount: 0,
      received_amount: 0,
      loss_amount: 0,
      balance_amount: 0,
    },
    stores: [],
    loss_details: [],
    delivery_details: [],
  };
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function jsonOk(data = null, extra = {}, init = {}) {
  const payload = { ok: true, ...extra };
  if (data !== null) payload.data = data;

  const headers = new Headers(init.headers || {});
  headers.set("content-type", "application/json; charset=utf-8");

  return new Response(JSON.stringify(payload), {
    status: init.status || 200,
    headers,
  });
}

function jsonErr(message, status = 400, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("content-type", "application/json; charset=utf-8");

  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers,
  });
}

async function hashPassword(password) {
  return sha256Hex(`bakery-password:${password}`);
}

async function createSessionToken(userId, secret) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = `${userId}.${issuedAt}`;
  const signature = await signHmac(payload, secret);
  return `${base64UrlEncode(payload)}.${signature}`;
}

async function readSessionUserId(request, secret) {
  const cookies = parseCookies(request.headers.get("cookie") || "");
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;

  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const payload = base64UrlDecode(parts[0]);
  const signature = parts[1];
  const expected = await signHmac(payload, secret);

  if (signature !== expected) return null;

  const [userIdRaw, issuedAtRaw] = payload.split(".");
  const userId = Number(userIdRaw);
  const issuedAt = Number(issuedAtRaw);
  const now = Math.floor(Date.now() / 1000);

  if (!userId || !issuedAt || now - issuedAt > SESSION_TTL_SECONDS) {
    return null;
  }

  return userId;
}

async function signHmac(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function parseCookies(cookieHeader) {
  const out = {};
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (!name) continue;
    out[name] = decodeURIComponent(rest.join("=") || "");
  }
  return out;
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  return parts.join("; ");
}

function getSecret(env) {
  return env.SECRET_KEY || "bakery-cloudflare-secret";
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function base64UrlEncode(value) {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlEncodeBytes(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return atob(padded);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

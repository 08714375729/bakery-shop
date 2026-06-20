const SESSION_COOKIE = "bakery_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'store',
  display_name TEXT NOT NULL DEFAULT '',
  store_id INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  settlement_type TEXT NOT NULL DEFAULT 'cash',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '默认',
  unit TEXT NOT NULL DEFAULT '个',
  default_price REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS store_product_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  price REAL NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_no TEXT NOT NULL UNIQUE,
  delivery_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS delivery_stops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id INTEGER NOT NULL,
  store_id INTEGER NOT NULL,
  seq INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  signed_at TEXT,
  receiver_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS delivery_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_stop_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  qty_should REAL NOT NULL,
  unit_price REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS branch_daily_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id INTEGER NOT NULL,
  biz_date TEXT NOT NULL,
  received_amount REAL NOT NULL DEFAULT 0,
  loss_amount REAL NOT NULL DEFAULT 0,
  loss_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(store_id, biz_date)
);

CREATE TABLE IF NOT EXISTS branch_daily_loss_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL,
  delivery_item_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  qty_loss REAL NOT NULL DEFAULT 0,
  unit_price REAL NOT NULL DEFAULT 0,
  amount_loss REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_store_id ON users(store_id);
CREATE INDEX IF NOT EXISTS idx_prices_store_product ON store_product_prices(store_id, product_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_date ON deliveries(delivery_date);
CREATE INDEX IF NOT EXISTS idx_delivery_stops_delivery ON delivery_stops(delivery_id);
CREATE INDEX IF NOT EXISTS idx_delivery_stops_store ON delivery_stops(store_id);
CREATE INDEX IF NOT EXISTS idx_delivery_items_stop ON delivery_items(delivery_stop_id);
CREATE INDEX IF NOT EXISTS idx_branch_entry_date ON branch_daily_entries(biz_date);
CREATE INDEX IF NOT EXISTS idx_branch_entry_store ON branch_daily_entries(store_id);
CREATE INDEX IF NOT EXISTS idx_branch_loss_entry ON branch_daily_loss_items(entry_id);
`;

let schemaPromise = null;

export default {
  async fetch(request, env) {
    try {
      await ensureSchema(env);
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
      if (error instanceof HttpError) {
        return jsonErr(error.message, error.status);
      }
      console.error("Worker error:", error);
      return jsonErr("服务器内部错误", 500);
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
      return jsonErr("用户名和密码必填");
    }

    const account = await env.DB.prepare(
      `SELECT u.*, s.name AS store_name
       FROM users u
       LEFT JOIN stores s ON s.id = u.store_id
       WHERE u.username = ?1
       LIMIT 1`
    ).bind(username).first();

    if (!account || Number(account.active) !== 1) {
      return jsonErr("账号或密码错误", 401);
    }

    const passwordHash = await hashPassword(password);
    if (passwordHash !== account.password_hash) {
      return jsonErr("账号或密码错误", 401);
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
      return jsonErr("请填写完整密码信息");
    }
    if (await hashPassword(currentPassword) !== account.password_hash) {
      return jsonErr("当前密码不正确");
    }
    if (newPassword.length < 6) {
      return jsonErr("新密码至少 6 位");
    }
    if (newPassword !== confirmPassword) {
      return jsonErr("两次输入的新密码不一致");
    }

    const newHash = await hashPassword(newPassword);
    await env.DB.prepare("UPDATE users SET password_hash = ?1 WHERE id = ?2")
      .bind(newHash, account.id)
      .run();

    return jsonOk({ message: "密码修改成功" });
  }

  if (pathname === "/api/stores" && request.method === "GET") {
    const account = await requireLogin(request, env);
    if (account.error) return account.error;

    const result = account.role === "admin"
      ? await env.DB.prepare("SELECT * FROM stores ORDER BY id DESC").all()
      : await env.DB.prepare("SELECT * FROM stores WHERE id = ?1 ORDER BY id DESC").bind(account.store_id).all();

    const rows = (result.results || []).map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      address: row.address,
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
      return jsonErr("门店编码和名称必填");
    }

    const existed = await env.DB.prepare("SELECT id FROM stores WHERE code = ?1 LIMIT 1").bind(code).first();
    if (existed) {
      return jsonErr("门店编码已存在");
    }

    const inserted = await env.DB.prepare(
      `INSERT INTO stores (code, name, address, settlement_type)
       VALUES (?1, ?2, ?3, ?4)`
    ).bind(code, name, address, settlementType).run();

    const storeId = inserted.meta.last_row_id;
    await ensureStoreAccount(env, {
      id: storeId,
      code,
      name,
    });

    return jsonOk({
      id: storeId,
      username: buildStoreUsername(code),
      default_password: "123456",
    });
  }

  if (pathname === "/api/products" && request.method === "GET") {
    const account = await requireLogin(request, env);
    if (account.error) return account.error;

    const result = await env.DB.prepare(
      `SELECT id, sku, name, category, unit, default_price
       FROM products
       ORDER BY id DESC`
    ).all();

    return jsonOk((result.results || []).map((row) => ({
      id: row.id,
      sku: row.sku,
      name: row.name,
      category: row.category || "默认",
      unit: row.unit || "个",
      default_price: num(row.default_price),
    })));
  }

  if (pathname === "/api/products" && request.method === "POST") {
    const account = await requireAdmin(request, env);
    if (account.error) return account.error;

    const body = await safeJson(request);
    const sku = String(body.sku || "").trim();
    const name = String(body.name || "").trim();
    const category = String(body.category || "默认").trim() || "默认";
    const unit = String(body.unit || "个").trim() || "个";
    const defaultPrice = num(body.default_price);

    if (!sku || !name) {
      return jsonErr("sku/name 必填");
    }
    const existed = await env.DB.prepare("SELECT id FROM products WHERE sku = ?1 LIMIT 1").bind(sku).first();
    if (existed) {
      return jsonErr("SKU 已存在");
    }

    const inserted = await env.DB.prepare(
      `INSERT INTO products (sku, name, category, unit, default_price)
       VALUES (?1, ?2, ?3, ?4, ?5)`
    ).bind(sku, name, category, unit, defaultPrice).run();

    return jsonOk({ id: inserted.meta.last_row_id });
  }

  const deleteProductMatch = pathname.match(/^\/api\/products\/(\d+)\/delete$/);
  if (deleteProductMatch && request.method === "POST") {
    const account = await requireAdmin(request, env);
    if (account.error) return account.error;

    const productId = Number(deleteProductMatch[1]);
    const product = await env.DB.prepare("SELECT id FROM products WHERE id = ?1 LIMIT 1").bind(productId).first();
    if (!product) {
      return jsonErr("面包不存在", 404);
    }

    const used1 = await env.DB.prepare("SELECT id FROM delivery_items WHERE product_id = ?1 LIMIT 1").bind(productId).first();
    const used2 = await env.DB.prepare("SELECT id FROM branch_daily_loss_items WHERE product_id = ?1 LIMIT 1").bind(productId).first();
    if (used1 || used2) {
      return jsonErr("这个面包已经被送货或日报记录使用，不能删除");
    }

    await env.DB.prepare("DELETE FROM store_product_prices WHERE product_id = ?1").bind(productId).run();
    await env.DB.prepare("DELETE FROM products WHERE id = ?1").bind(productId).run();
    return jsonOk({ id: productId });
  }

  if (pathname === "/api/prices" && request.method === "GET") {
    const account = await requireLogin(request, env);
    if (account.error) return account.error;

    const sql = `
      SELECT spp.id, spp.store_id, spp.product_id, spp.price, spp.effective_from,
             s.name AS store_name, p.name AS product_name
      FROM store_product_prices spp
      JOIN stores s ON s.id = spp.store_id
      JOIN products p ON p.id = spp.product_id
      ${account.role === "admin" ? "" : "WHERE spp.store_id = ?1"}
      ORDER BY spp.id DESC
      LIMIT 200`;

    const result = account.role === "admin"
      ? await env.DB.prepare(sql).all()
      : await env.DB.prepare(sql).bind(account.store_id).all();

    return jsonOk((result.results || []).map((row) => ({
      id: row.id,
      store_id: row.store_id,
      store_name: row.store_name,
      product_id: row.product_id,
      product_name: row.product_name,
      price: num(row.price),
      effective_from: row.effective_from,
    })));
  }

  if (pathname === "/api/prices" && request.method === "POST") {
    const account = await requireAdmin(request, env);
    if (account.error) return account.error;

    const body = await safeJson(request);
    const storeId = Number(body.store_id || 0);
    const productId = Number(body.product_id || 0);
    const price = num(body.price);
    const effectiveFrom = String(body.effective_from || todayStr()).trim();

    if (!storeId || !productId || price <= 0) {
      return jsonErr("参数格式不正确");
    }

    const store = await env.DB.prepare("SELECT id FROM stores WHERE id = ?1 LIMIT 1").bind(storeId).first();
    const product = await env.DB.prepare("SELECT id FROM products WHERE id = ?1 LIMIT 1").bind(productId).first();
    if (!store || !product) {
      return jsonErr("门店或产品不存在", 404);
    }

    const inserted = await env.DB.prepare(
      `INSERT INTO store_product_prices (store_id, product_id, price, effective_from)
       VALUES (?1, ?2, ?3, ?4)`
    ).bind(storeId, productId, price, effectiveFrom).run();

    return jsonOk({ id: inserted.meta.last_row_id });
  }

  if (pathname === "/api/deliveries" && request.method === "GET") {
    const account = await requireLogin(request, env);
    if (account.error) return account.error;
    return jsonOk(await listDeliveries(env, account));
  }

  if (pathname === "/api/deliveries/direct" && request.method === "POST") {
    const account = await requireAdmin(request, env);
    if (account.error) return account.error;

    const body = await safeJson(request);
    const deliveryDate = String(body.delivery_date || "").trim();
    const storeId = Number(body.store_id || 0);
    const items = Array.isArray(body.items) ? body.items : [];

    if (!deliveryDate || !storeId) {
      return jsonErr("delivery_date / store_id 参数不正确");
    }
    if (!items.length) {
      return jsonErr("items 不能为空");
    }

    const store = await env.DB.prepare("SELECT * FROM stores WHERE id = ?1 LIMIT 1").bind(storeId).first();
    if (!store) {
      return jsonErr("门店不存在", 404);
    }

    const deliveryNo = genNo("DL");
    const insertedDelivery = await env.DB.prepare(
      `INSERT INTO deliveries (delivery_no, delivery_date, status)
       VALUES (?1, ?2, 'draft')`
    ).bind(deliveryNo, deliveryDate).run();
    const deliveryId = insertedDelivery.meta.last_row_id;

    const insertedStop = await env.DB.prepare(
      `INSERT INTO delivery_stops (delivery_id, store_id, seq, status)
       VALUES (?1, ?2, 1, 'pending')`
    ).bind(deliveryId, storeId).run();
    const stopId = insertedStop.meta.last_row_id;

    let totalAmount = 0;
    for (const row of items) {
      const productId = Number(row.product_id || 0);
      const qty = num(row.qty);
      if (!productId || qty <= 0) continue;

      const product = await env.DB.prepare("SELECT id FROM products WHERE id = ?1 LIMIT 1").bind(productId).first();
      if (!product) {
        return jsonErr(`产品不存在：${productId}`, 404);
      }

      const unitPrice = await getPrice(env, storeId, productId, deliveryDate);
      totalAmount += qty * unitPrice;
      await env.DB.prepare(
        `INSERT INTO delivery_items (delivery_stop_id, product_id, qty_should, unit_price)
         VALUES (?1, ?2, ?3, ?4)`
      ).bind(stopId, productId, qty, unitPrice).run();
    }

    return jsonOk({
      id: deliveryId,
      delivery_no: deliveryNo,
      store_name: store.name,
      total_amount: round2(totalAmount),
    });
  }

  const deliveryStopsMatch = pathname.match(/^\/api\/deliveries\/(\d+)\/stops$/);
  if (deliveryStopsMatch && request.method === "GET") {
    const account = await requireLogin(request, env);
    if (account.error) return account.error;
    return jsonOk(await listDeliveryStops(env, Number(deliveryStopsMatch[1]), account));
  }

  const stopDetailMatch = pathname.match(/^\/api\/stops\/(\d+)$/);
  if (stopDetailMatch && request.method === "GET") {
    const account = await requireLogin(request, env);
    if (account.error) return account.error;
    return jsonOk(await getStopDetail(env, Number(stopDetailMatch[1]), account));
  }

  if (pathname === "/api/branch-daily" && request.method === "GET") {
    const account = await requireLogin(request, env);
    if (account.error) return account.error;
    const bizDate = String(url.searchParams.get("biz_date") || todayStr());
    return jsonOk(await listBranchDaily(env, bizDate, account));
  }

  if (pathname === "/api/branch-daily/form" && request.method === "GET") {
    const account = await requireLogin(request, env);
    if (account.error) return account.error;

    const storeId = Number(url.searchParams.get("store_id") || 0);
    const bizDate = String(url.searchParams.get("biz_date") || todayStr());
    if (!storeId) {
      return jsonErr("store_id / biz_date 参数不正确");
    }
    if (!accountCanAccessStore(account, storeId)) {
      return jsonErr("无权查看该门店数据", 403);
    }
    return jsonOk(await getBranchDailyForm(env, storeId, bizDate));
  }

  if (pathname === "/api/branch-daily" && request.method === "POST") {
    const account = await requireLogin(request, env);
    if (account.error) return account.error;

    const body = await safeJson(request);
    const storeId = Number(body.store_id || 0);
    const bizDate = String(body.biz_date || todayStr());
    const receivedAmount = num(body.received_amount);
    const lossNote = String(body.loss_note || "").trim();
    const lossItems = Array.isArray(body.loss_items) ? body.loss_items : [];

    if (!storeId || receivedAmount < 0) {
      return jsonErr("参数不正确");
    }
    if (!accountCanAccessStore(account, storeId)) {
      return jsonErr("无权填写该门店数据", 403);
    }

    const store = await env.DB.prepare("SELECT * FROM stores WHERE id = ?1 LIMIT 1").bind(storeId).first();
    if (!store) {
      return jsonErr("门店不存在", 404);
    }

    let entry = await env.DB.prepare(
      "SELECT * FROM branch_daily_entries WHERE store_id = ?1 AND biz_date = ?2 LIMIT 1"
    ).bind(storeId, bizDate).first();

    let entryId;
    if (!entry) {
      const inserted = await env.DB.prepare(
        `INSERT INTO branch_daily_entries (store_id, biz_date, received_amount, loss_amount, loss_note)
         VALUES (?1, ?2, 0, 0, '')`
      ).bind(storeId, bizDate).run();
      entryId = inserted.meta.last_row_id;
    } else {
      entryId = entry.id;
    }

    await env.DB.prepare("DELETE FROM branch_daily_loss_items WHERE entry_id = ?1").bind(entryId).run();

    let totalLossAmount = 0;
    for (const row of lossItems) {
      const deliveryItemId = Number(row.delivery_item_id || 0);
      const qtyLoss = num(row.qty_loss);
      if (!deliveryItemId || qtyLoss <= 0) continue;

      const di = await env.DB.prepare(
        `SELECT di.id, di.product_id, di.qty_should, di.unit_price,
                ds.store_id, d.delivery_date
         FROM delivery_items di
         JOIN delivery_stops ds ON ds.id = di.delivery_stop_id
         JOIN deliveries d ON d.id = ds.delivery_id
         WHERE di.id = ?1
         LIMIT 1`
      ).bind(deliveryItemId).first();

      if (!di) {
        return jsonErr("送货明细不存在", 404);
      }
      if (Number(di.store_id) !== storeId || di.delivery_date !== bizDate) {
        return jsonErr("损失明细不属于该门店当天送货", 400);
      }
      if (qtyLoss > num(di.qty_should)) {
        return jsonErr("烂掉数量不能超过送货数量");
      }

      const amountLoss = round2(qtyLoss * num(di.unit_price));
      totalLossAmount += amountLoss;

      await env.DB.prepare(
        `INSERT INTO branch_daily_loss_items
          (entry_id, delivery_item_id, product_id, qty_loss, unit_price, amount_loss)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
      ).bind(entryId, deliveryItemId, di.product_id, qtyLoss, num(di.unit_price), amountLoss).run();
    }

    await env.DB.prepare(
      `UPDATE branch_daily_entries
       SET received_amount = ?1,
           loss_amount = ?2,
           loss_note = ?3,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?4`
    ).bind(receivedAmount, round2(totalLossAmount), lossNote, entryId).run();

    return jsonOk({
      id: entryId,
      store_name: store.name,
      loss_amount: round2(totalLossAmount),
    });
  }

  if (pathname === "/api/reports/branch-daily" && request.method === "GET") {
    const account = await requireLogin(request, env);
    if (account.error) return account.error;
    const bizDate = String(url.searchParams.get("biz_date") || todayStr());
    return jsonOk(await buildBranchDailyReport(env, bizDate, account));
  }

  return jsonErr("路由不存在", 404);
}

async function handleReportPrint(request, env, url) {
  const account = await getCurrentAccount(request, env);
  if (!account) {
    return new Response("请先登录", { status: 401 });
  }

  const bizDate = String(url.searchParams.get("biz_date") || todayStr());
  const report = await buildBranchDailyReport(env, bizDate, account);
  const summary = report.summary;

  const summaryCards = [
    ["门店数", summary.store_count],
    ["有送货门店", summary.sent_store_count],
    ["送货总金额", money(summary.sent_amount)],
    ["收回总金额", money(summary.received_amount)],
    ["损失总金额", money(summary.loss_amount)],
    ["差额", money(summary.balance_amount)],
  ].map(([label, value]) => `
    <div class="card">
      <div class="label">${escapeHtml(label)}</div>
      <div class="value">${escapeHtml(String(value))}</div>
    </div>
  `).join("");

  const rowsHtml = report.stores.map((row) => `
    <tr>
      <td>${escapeHtml(row.store_name)}</td>
      <td>${row.variety_count}</td>
      <td>${money(row.total_qty)}</td>
      <td>${money(row.sent_amount)}</td>
      <td>${money(row.received_amount)}</td>
      <td>${money(row.loss_amount)}</td>
      <td>${money(row.balance_amount)}</td>
      <td>${escapeHtml(row.loss_note || "")}</td>
    </tr>
  `).join("");

  const deliveryRows = report.delivery_details.map((row) => `
    <tr>
      <td>${escapeHtml(row.store_name)}</td>
      <td>${escapeHtml(row.delivery_no)}</td>
      <td>${escapeHtml(row.product_name)}</td>
      <td>${money(row.qty_should)}</td>
      <td>${money(row.unit_price)}</td>
      <td>${money(row.amount)}</td>
    </tr>
  `).join("");

  const lossRows = report.loss_details.map((row) => `
    <tr>
      <td>${escapeHtml(row.store_name)}</td>
      <td>${escapeHtml(row.product_name)}</td>
      <td>${escapeHtml(row.delivery_no || "")}</td>
      <td>${money(row.qty_loss)}</td>
      <td>${money(row.unit_price)}</td>
      <td>${money(row.amount_loss)}</td>
      <td>${escapeHtml(row.loss_note || "")}</td>
    </tr>
  `).join("");

  const html = `<!doctype html>
<html lang="zh">
  <head>
    <meta charset="utf-8" />
    <title>分门店日报 ${escapeHtml(report.biz_date)}</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 24px; color: #222; }
      h1, h2 { margin: 0 0 12px; }
      .muted { color: #666; margin-bottom: 18px; }
      .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 18px; }
      .card { border: 1px solid #ddd; border-radius: 8px; padding: 12px; }
      .label { font-size: 12px; color: #666; }
      .value { font-size: 22px; font-weight: 700; margin-top: 6px; }
      table { width: 100%; border-collapse: collapse; margin-top: 10px; }
      th, td { border: 1px solid #ddd; padding: 8px; font-size: 12px; text-align: left; }
      th { background: #f5f5f5; }
      .section { margin-top: 24px; }
      @media print { button { display: none; } body { margin: 10px; } }
    </style>
  </head>
  <body>
    <button onclick="window.print()">打印 / 另存为 PDF</button>
    <h1>分门店日报</h1>
    <div class="muted">日期：${escapeHtml(report.biz_date)}</div>
    <div class="grid">${summaryCards}</div>

    <div class="section">
      <h2>分店汇总</h2>
      <table>
        <thead>
          <tr><th>门店</th><th>几款</th><th>总数量</th><th>送货金额</th><th>收回金额</th><th>损失金额</th><th>差额</th><th>损失备注</th></tr>
        </thead>
        <tbody>${rowsHtml || '<tr><td colspan="8">暂无数据</td></tr>'}</tbody>
      </table>
    </div>

    <div class="section">
      <h2>送货明细</h2>
      <table>
        <thead>
          <tr><th>门店</th><th>单号</th><th>面包名称</th><th>送货数量</th><th>单价</th><th>金额</th></tr>
        </thead>
        <tbody>${deliveryRows || '<tr><td colspan="6">暂无数据</td></tr>'}</tbody>
      </table>
    </div>

    <div class="section">
      <h2>烂面包明细</h2>
      <table>
        <thead>
          <tr><th>门店</th><th>面包名称</th><th>单号</th><th>烂了多少</th><th>单价</th><th>损失金额</th><th>损失备注</th></tr>
        </thead>
        <tbody>${lossRows || '<tr><td colspan="7">暂无数据</td></tr>'}</tbody>
      </table>
    </div>
  </body>
</html>`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function ensureSchema(env) {
  if (!schemaPromise) {
    schemaPromise = env.DB.exec(SCHEMA_SQL).catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

async function ensureSeedData(env) {
  const adminHash = await hashPassword("admin123");
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (username, password_hash, role, display_name, active)
     VALUES (?1, ?2, 'admin', '总店管理员', 1)`
  ).bind("admin", adminHash).run();
}

async function ensureStoreAccount(env, store) {
  const username = buildStoreUsername(store.code);
  const existing = await env.DB.prepare("SELECT id FROM users WHERE username = ?1 LIMIT 1").bind(username).first();
  const passwordHash = await hashPassword("123456");

  if (existing) {
    await env.DB.prepare(
      `UPDATE users
       SET role = 'store',
           display_name = ?1,
           store_id = ?2,
           active = 1
       WHERE id = ?3`
    ).bind(`${store.name} 门店账号`, store.id, existing.id).run();
    return;
  }

  await env.DB.prepare(
    `INSERT INTO users (username, password_hash, role, display_name, store_id, active)
     VALUES (?1, ?2, 'store', ?3, ?4, 1)`
  ).bind(username, passwordHash, `${store.name} 门店账号`, store.id).run();
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
  ).bind(userId).first();

  if (!account || Number(account.active) !== 1) {
    return null;
  }

  return account;
}

async function requireLogin(request, env) {
  const account = await getCurrentAccount(request, env);
  if (!account) {
    return { error: jsonErr("请先登录", 401) };
  }
  return account;
}

async function requireAdmin(request, env) {
  const account = await requireLogin(request, env);
  if (account.error) return account;
  if (account.role !== "admin") {
    return { error: jsonErr("只有总店账号可以操作", 403) };
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

function accountCanAccessStore(account, storeId) {
  return account.role === "admin" || Number(account.store_id) === Number(storeId);
}

async function listDeliveries(env, account) {
  const deliveries = await env.DB.prepare(
    `SELECT id, delivery_no, delivery_date, status
     FROM deliveries
     ORDER BY id DESC
     LIMIT 50`
  ).all();

  const rows = [];
  for (const delivery of deliveries.results || []) {
    const stops = await listDeliveryStops(env, delivery.id, account);
    if (!stops.length) continue;

    let totalAmount = 0;
    for (const stop of stops) {
      const amountRow = await env.DB.prepare(
        `SELECT COALESCE(SUM(qty_should * unit_price), 0) AS total_amount
         FROM delivery_items
         WHERE delivery_stop_id = ?1`
      ).bind(stop.id).first();
      totalAmount += num(amountRow?.total_amount);
    }

    rows.push({
      id: delivery.id,
      delivery_no: delivery.delivery_no,
      delivery_date: delivery.delivery_date,
      status: delivery.status,
      store_names: stops.map((stop) => stop.store_name).join("、"),
      stop_count: stops.length,
      signed_count: stops.filter((stop) => stop.status === "signed").length,
      total_amount: round2(totalAmount),
    });
  }
  return rows;
}

async function listDeliveryStops(env, deliveryId, account) {
  const sql = `
    SELECT ds.id, ds.seq, ds.store_id, ds.status, s.name AS store_name
    FROM delivery_stops ds
    JOIN stores s ON s.id = ds.store_id
    WHERE ds.delivery_id = ?1
    ${account.role === "admin" ? "" : "AND ds.store_id = ?2"}
    ORDER BY ds.seq ASC, ds.id ASC`;

  const result = account.role === "admin"
    ? await env.DB.prepare(sql).bind(deliveryId).all()
    : await env.DB.prepare(sql).bind(deliveryId, account.store_id).all();

  return (result.results || []).map((row) => ({
    id: row.id,
    seq: row.seq,
    store_id: row.store_id,
    store_name: row.store_name,
    status: row.status,
  }));
}

async function getStopDetail(env, stopId, account) {
  const stop = await env.DB.prepare(
    `SELECT ds.*, d.delivery_no, d.delivery_date, s.name AS store_name
     FROM delivery_stops ds
     JOIN deliveries d ON d.id = ds.delivery_id
     JOIN stores s ON s.id = ds.store_id
     WHERE ds.id = ?1
     LIMIT 1`
  ).bind(stopId).first();

  if (!stop) {
    throw new HttpError("站点不存在", 404);
  }
  if (!accountCanAccessStore(account, stop.store_id)) {
    throw new HttpError("无权查看该门店数据", 403);
  }

  const items = await env.DB.prepare(
    `SELECT di.id AS delivery_item_id, di.product_id, di.qty_should, di.unit_price, p.name AS product_name
     FROM delivery_items di
     JOIN products p ON p.id = di.product_id
     WHERE di.delivery_stop_id = ?1
     ORDER BY di.id ASC`
  ).bind(stopId).all();

  return {
    id: stop.id,
    delivery_id: stop.delivery_id,
    delivery_no: stop.delivery_no,
    delivery_date: stop.delivery_date,
    store_id: stop.store_id,
    store_name: stop.store_name,
    status: stop.status,
    receiver_name: stop.receiver_name || "",
    items: (items.results || []).map((row) => ({
      delivery_item_id: row.delivery_item_id,
      product_id: row.product_id,
      product_name: row.product_name,
      qty_should: num(row.qty_should),
      unit_price: num(row.unit_price),
      qty_signed: null,
      qty_return: null,
      short_reason: "",
      return_reason: "",
    })),
  };
}

async function listBranchDaily(env, bizDate, account) {
  const sql = `
    SELECT bde.id, bde.store_id, s.name AS store_name, bde.biz_date,
           bde.received_amount, bde.loss_amount, bde.loss_note
    FROM branch_daily_entries bde
    JOIN stores s ON s.id = bde.store_id
    WHERE bde.biz_date = ?1
    ${account.role === "admin" ? "" : "AND bde.store_id = ?2"}
    ORDER BY bde.id DESC`;

  const result = account.role === "admin"
    ? await env.DB.prepare(sql).bind(bizDate).all()
    : await env.DB.prepare(sql).bind(bizDate, account.store_id).all();

  return (result.results || []).map((row) => ({
    id: row.id,
    store_id: row.store_id,
    store_name: row.store_name,
    biz_date: row.biz_date,
    received_amount: num(row.received_amount),
    loss_amount: num(row.loss_amount),
    loss_note: row.loss_note || "",
    loss_item_count: 0,
  }));
}

async function getBranchDailyForm(env, storeId, bizDate) {
  const entry = await env.DB.prepare(
    `SELECT *
     FROM branch_daily_entries
     WHERE store_id = ?1 AND biz_date = ?2
     LIMIT 1`
  ).bind(storeId, bizDate).first();

  const lossRows = entry
    ? await env.DB.prepare(
        `SELECT delivery_item_id, qty_loss, amount_loss
         FROM branch_daily_loss_items
         WHERE entry_id = ?1`
      ).bind(entry.id).all()
    : { results: [] };

  const lossMap = new Map((lossRows.results || []).map((row) => [
    Number(row.delivery_item_id),
    {
      qty_loss: num(row.qty_loss),
      amount_loss: num(row.amount_loss),
    },
  ]));

  const items = await env.DB.prepare(
    `SELECT d.delivery_no, di.id AS delivery_item_id, di.product_id, p.name AS product_name,
            di.qty_should, di.unit_price
     FROM delivery_items di
     JOIN delivery_stops ds ON ds.id = di.delivery_stop_id
     JOIN deliveries d ON d.id = ds.delivery_id
     JOIN products p ON p.id = di.product_id
     WHERE ds.store_id = ?1
       AND d.delivery_date = ?2
     ORDER BY d.id DESC, di.id ASC`
  ).bind(storeId, bizDate).all();

  return {
    store_id: storeId,
    biz_date: bizDate,
    received_amount: entry ? num(entry.received_amount) : 0,
    loss_amount: entry ? num(entry.loss_amount) : 0,
    loss_note: entry?.loss_note || "",
    items: (items.results || []).map((row) => {
      const saved = lossMap.get(Number(row.delivery_item_id)) || {};
      return {
        delivery_no: row.delivery_no,
        delivery_item_id: row.delivery_item_id,
        product_id: row.product_id,
        product_name: row.product_name,
        qty_should: num(row.qty_should),
        unit_price: num(row.unit_price),
        qty_loss: saved.qty_loss || 0,
        amount_loss: saved.amount_loss || 0,
      };
    }),
  };
}

async function buildBranchDailyReport(env, bizDate, account) {
  const deliverySql = `
    SELECT ds.store_id, s.name AS store_name, d.delivery_no,
           di.product_id, p.name AS product_name,
           di.qty_should, di.unit_price
    FROM deliveries d
    JOIN delivery_stops ds ON ds.delivery_id = d.id
    JOIN stores s ON s.id = ds.store_id
    JOIN delivery_items di ON di.delivery_stop_id = ds.id
    JOIN products p ON p.id = di.product_id
    WHERE d.delivery_date = ?1
    ${account.role === "admin" ? "" : "AND ds.store_id = ?2"}
    ORDER BY s.name, d.delivery_no, p.name`;

  const deliveryRows = account.role === "admin"
    ? await env.DB.prepare(deliverySql).bind(bizDate).all()
    : await env.DB.prepare(deliverySql).bind(bizDate, account.store_id).all();

  const entrySql = `
    SELECT bde.id, bde.store_id, s.name AS store_name,
           bde.received_amount, bde.loss_amount, bde.loss_note
    FROM branch_daily_entries bde
    JOIN stores s ON s.id = bde.store_id
    WHERE bde.biz_date = ?1
    ${account.role === "admin" ? "" : "AND bde.store_id = ?2"}
    ORDER BY s.name`;

  const entryRows = account.role === "admin"
    ? await env.DB.prepare(entrySql).bind(bizDate).all()
    : await env.DB.prepare(entrySql).bind(bizDate, account.store_id).all();

  const lossSql = `
    SELECT bde.store_id, s.name AS store_name,
           p.name AS product_name,
           bdli.qty_loss, bdli.unit_price, bdli.amount_loss,
           COALESCE(d.delivery_no, '') AS delivery_no,
           bde.loss_note
    FROM branch_daily_loss_items bdli
    JOIN branch_daily_entries bde ON bde.id = bdli.entry_id
    JOIN stores s ON s.id = bde.store_id
    JOIN products p ON p.id = bdli.product_id
    LEFT JOIN delivery_items di ON di.id = bdli.delivery_item_id
    LEFT JOIN delivery_stops ds ON ds.id = di.delivery_stop_id
    LEFT JOIN deliveries d ON d.id = ds.delivery_id
    WHERE bde.biz_date = ?1
    ${account.role === "admin" ? "" : "AND bde.store_id = ?2"}
    ORDER BY s.name, p.name, d.delivery_no`;

  const lossRows = account.role === "admin"
    ? await env.DB.prepare(lossSql).bind(bizDate).all()
    : await env.DB.prepare(lossSql).bind(bizDate, account.store_id).all();

  const storeMap = new Map();
  const deliveryDetails = [];
  const lossDetails = [];

  function ensureStoreRow(storeId, storeName) {
    if (!storeMap.has(storeId)) {
      storeMap.set(storeId, {
        store_id: storeId,
        store_name: storeName,
        variety_ids: new Set(),
        total_qty: 0,
        sent_amount: 0,
        received_amount: 0,
        loss_amount: 0,
        loss_note: "",
      });
    }
    return storeMap.get(storeId);
  }

  for (const row of deliveryRows.results || []) {
    const item = ensureStoreRow(row.store_id, row.store_name);
    item.variety_ids.add(row.product_id);
    item.total_qty += num(row.qty_should);
    item.sent_amount += num(row.qty_should) * num(row.unit_price);
    deliveryDetails.push({
      store_id: row.store_id,
      store_name: row.store_name,
      delivery_no: row.delivery_no,
      product_name: row.product_name,
      qty_should: num(row.qty_should),
      unit_price: num(row.unit_price),
      amount: round2(num(row.qty_should) * num(row.unit_price)),
    });
  }

  for (const row of entryRows.results || []) {
    const item = ensureStoreRow(row.store_id, row.store_name);
    item.received_amount += num(row.received_amount);
    item.loss_amount += num(row.loss_amount);
    if (row.loss_note) item.loss_note = row.loss_note;
  }

  for (const row of lossRows.results || []) {
    lossDetails.push({
      store_id: row.store_id,
      store_name: row.store_name,
      product_name: row.product_name,
      delivery_no: row.delivery_no || "",
      qty_loss: num(row.qty_loss),
      unit_price: num(row.unit_price),
      amount_loss: num(row.amount_loss),
      loss_note: row.loss_note || "",
    });
  }

  const stores = [];
  let sentStoreCount = 0;
  let totalSentAmount = 0;
  let totalReceivedAmount = 0;
  let totalLossAmount = 0;
  let totalBalanceAmount = 0;

  for (const row of storeMap.values()) {
    const sentAmount = round2(row.sent_amount);
    const receivedAmount = round2(row.received_amount);
    const lossAmount = round2(row.loss_amount);
    const balanceAmount = round2(sentAmount - receivedAmount - lossAmount);

    if (sentAmount > 0) sentStoreCount += 1;
    totalSentAmount += sentAmount;
    totalReceivedAmount += receivedAmount;
    totalLossAmount += lossAmount;
    totalBalanceAmount += balanceAmount;

    stores.push({
      store_id: row.store_id,
      store_name: row.store_name,
      variety_count: row.variety_ids.size,
      total_qty: round2(row.total_qty),
      sent_amount: sentAmount,
      received_amount: receivedAmount,
      loss_amount: lossAmount,
      balance_amount: balanceAmount,
      loss_note: row.loss_note || "",
    });
  }

  stores.sort((a, b) => {
    if (b.sent_amount !== a.sent_amount) return b.sent_amount - a.sent_amount;
    return a.store_name.localeCompare(b.store_name);
  });

  return {
    biz_date: bizDate,
    summary: {
      store_count: stores.length,
      sent_store_count: sentStoreCount,
      sent_amount: round2(totalSentAmount),
      received_amount: round2(totalReceivedAmount),
      loss_amount: round2(totalLossAmount),
      balance_amount: round2(totalBalanceAmount),
    },
    stores,
    loss_details: lossDetails,
    delivery_details: deliveryDetails,
  };
}

async function getPrice(env, storeId, productId, effectiveDate) {
  const priceRow = await env.DB.prepare(
    `SELECT price
     FROM store_product_prices
     WHERE store_id = ?1
       AND product_id = ?2
       AND effective_from <= ?3
     ORDER BY effective_from DESC, id DESC
     LIMIT 1`
  ).bind(storeId, productId, effectiveDate).first();

  if (priceRow) return num(priceRow.price);

  const product = await env.DB.prepare(
    "SELECT default_price FROM products WHERE id = ?1 LIMIT 1"
  ).bind(productId).first();

  return product ? num(product.default_price) : 0;
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

class HttpError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
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

function buildStoreUsername(code) {
  return `store_${String(code || "").trim().toLowerCase()}`;
}

function genNo(prefix) {
  return `${prefix}${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

function num(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function round2(value) {
  return Math.round(num(value) * 100) / 100;
}

function money(value) {
  return round2(value).toFixed(2);
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

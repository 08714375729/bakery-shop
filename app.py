import os
import sys
from datetime import date, datetime
from decimal import Decimal

from flask import Flask, jsonify, request, send_from_directory, session
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import text
from werkzeug.security import check_password_hash, generate_password_hash


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "bakery.db")

app = Flask(__name__, static_folder="static")
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "bakery-secret-change-me")
app.config["SQLALCHEMY_DATABASE_URI"] = f"sqlite:///{DB_PATH}"
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

db = SQLAlchemy(app)


# -----------------------------
# Models（小型MVP）
# -----------------------------

class Store(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    code = db.Column(db.String(50), unique=True, nullable=False)
    name = db.Column(db.String(100), nullable=False)
    address = db.Column(db.String(255), default="", nullable=False)
    settlement_type = db.Column(db.String(20), default="cash", nullable=False)  # cash/transfer/credit
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)


class Product(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    sku = db.Column(db.String(50), unique=True, nullable=False)
    name = db.Column(db.String(100), nullable=False)
    category = db.Column(db.String(50), default="默认", nullable=False)
    unit = db.Column(db.String(20), default="piece", nullable=False)
    allow_return = db.Column(db.Boolean, default=True, nullable=False)
    default_price = db.Column(db.Numeric(12, 2), default=0, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)


class StoreProductPrice(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    store_id = db.Column(db.Integer, db.ForeignKey("store.id"), nullable=False)
    product_id = db.Column(db.Integer, db.ForeignKey("product.id"), nullable=False)
    price = db.Column(db.Numeric(12, 2), nullable=False)
    effective_from = db.Column(db.Date, default=date.today, nullable=False)
    effective_to = db.Column(db.Date, nullable=True)

    store = db.relationship("Store")
    product = db.relationship("Product")


class StoreOrder(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    order_no = db.Column(db.String(50), unique=True, nullable=False)
    store_id = db.Column(db.Integer, db.ForeignKey("store.id"), nullable=False)
    delivery_date = db.Column(db.Date, nullable=False)
    status = db.Column(db.String(20), default="draft", nullable=False)  # draft/confirmed/canceled
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)

    store = db.relationship("Store")


class StoreOrderItem(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    order_id = db.Column(db.Integer, db.ForeignKey("store_order.id"), nullable=False)
    product_id = db.Column(db.Integer, db.ForeignKey("product.id"), nullable=False)
    qty = db.Column(db.Numeric(12, 2), nullable=False)
    confirmed_qty = db.Column(db.Numeric(12, 2), nullable=True)

    order = db.relationship("StoreOrder", backref=db.backref("items", lazy=True, cascade="all, delete-orphan"))
    product = db.relationship("Product")


class Delivery(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    delivery_no = db.Column(db.String(50), unique=True, nullable=False)
    delivery_date = db.Column(db.Date, nullable=False)
    status = db.Column(db.String(20), default="draft", nullable=False)  # draft/completed
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)


class DeliveryStop(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    delivery_id = db.Column(db.Integer, db.ForeignKey("delivery.id"), nullable=False)
    store_id = db.Column(db.Integer, db.ForeignKey("store.id"), nullable=False)
    seq = db.Column(db.Integer, default=1, nullable=False)
    status = db.Column(db.String(20), default="pending", nullable=False)  # pending/signed
    signed_at = db.Column(db.DateTime, nullable=True)
    receiver_name = db.Column(db.String(50), default="", nullable=False)

    delivery = db.relationship("Delivery", backref=db.backref("stops", lazy=True, cascade="all, delete-orphan"))
    store = db.relationship("Store")


class DeliveryItem(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    delivery_stop_id = db.Column(db.Integer, db.ForeignKey("delivery_stop.id"), nullable=False)
    product_id = db.Column(db.Integer, db.ForeignKey("product.id"), nullable=False)
    qty_should = db.Column(db.Numeric(12, 2), nullable=False)
    unit_price = db.Column(db.Numeric(12, 2), nullable=False)  # price snapshot

    stop = db.relationship("DeliveryStop", backref=db.backref("items", lazy=True, cascade="all, delete-orphan"))
    product = db.relationship("Product")


class DeliverySignedItem(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    delivery_item_id = db.Column(db.Integer, db.ForeignKey("delivery_item.id"), unique=True, nullable=False)
    qty_signed = db.Column(db.Numeric(12, 2), default=0, nullable=False)
    qty_return = db.Column(db.Numeric(12, 2), default=0, nullable=False)
    qty_short = db.Column(db.Numeric(12, 2), default=0, nullable=False)
    short_reason = db.Column(db.String(50), default="", nullable=False)
    return_reason = db.Column(db.String(50), default="", nullable=False)

    delivery_item = db.relationship("DeliveryItem", backref=db.backref("signed", uselist=False, cascade="all, delete-orphan"))


class ARInvoice(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    invoice_no = db.Column(db.String(50), unique=True, nullable=False)
    store_id = db.Column(db.Integer, db.ForeignKey("store.id"), nullable=False)
    biz_date = db.Column(db.Date, nullable=False)
    status = db.Column(db.String(20), default="open", nullable=False)  # open/partially_paid/paid
    amount_goods = db.Column(db.Numeric(12, 2), default=0, nullable=False)
    amount_deduction = db.Column(db.Numeric(12, 2), default=0, nullable=False)
    amount_receivable = db.Column(db.Numeric(12, 2), default=0, nullable=False)
    amount_paid = db.Column(db.Numeric(12, 2), default=0, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    store = db.relationship("Store")


class ARInvoiceLine(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    invoice_id = db.Column(db.Integer, db.ForeignKey("ar_invoice.id"), nullable=False)
    product_id = db.Column(db.Integer, db.ForeignKey("product.id"), nullable=False)
    qty_signed = db.Column(db.Numeric(12, 2), default=0, nullable=False)
    unit_price = db.Column(db.Numeric(12, 2), default=0, nullable=False)
    amount_line = db.Column(db.Numeric(12, 2), default=0, nullable=False)
    qty_return = db.Column(db.Numeric(12, 2), default=0, nullable=False)
    amount_return = db.Column(db.Numeric(12, 2), default=0, nullable=False)
    qty_short = db.Column(db.Numeric(12, 2), default=0, nullable=False)
    amount_short = db.Column(db.Numeric(12, 2), default=0, nullable=False)

    invoice = db.relationship("ARInvoice", backref=db.backref("lines", lazy=True, cascade="all, delete-orphan"))
    product = db.relationship("Product")


class Payment(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    payment_no = db.Column(db.String(50), unique=True, nullable=False)
    store_id = db.Column(db.Integer, db.ForeignKey("store.id"), nullable=False)
    pay_date = db.Column(db.Date, nullable=False)
    method = db.Column(db.String(20), default="cash", nullable=False)  # cash/transfer/other
    amount = db.Column(db.Numeric(12, 2), nullable=False)
    reference_no = db.Column(db.String(100), default="", nullable=False)
    received_by = db.Column(db.String(50), default="", nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)

    store = db.relationship("Store")


class PaymentAllocation(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    payment_id = db.Column(db.Integer, db.ForeignKey("payment.id"), nullable=False)
    invoice_id = db.Column(db.Integer, db.ForeignKey("ar_invoice.id"), nullable=False)
    amount_allocated = db.Column(db.Numeric(12, 2), nullable=False)

    payment = db.relationship("Payment", backref=db.backref("allocations", lazy=True, cascade="all, delete-orphan"))
    invoice = db.relationship("ARInvoice", backref=db.backref("allocations", lazy=True, cascade="all, delete-orphan"))


class BranchDailyEntry(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    store_id = db.Column(db.Integer, db.ForeignKey("store.id"), nullable=False)
    biz_date = db.Column(db.Date, nullable=False)
    received_amount = db.Column(db.Numeric(12, 2), default=0, nullable=False)
    loss_amount = db.Column(db.Numeric(12, 2), default=0, nullable=False)
    loss_note = db.Column(db.String(255), default="", nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    store = db.relationship("Store")


class BranchDailyLossItem(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    entry_id = db.Column(db.Integer, db.ForeignKey("branch_daily_entry.id"), nullable=False)
    delivery_item_id = db.Column(db.Integer, db.ForeignKey("delivery_item.id"), nullable=False)
    product_id = db.Column(db.Integer, db.ForeignKey("product.id"), nullable=False)
    qty_loss = db.Column(db.Numeric(12, 2), default=0, nullable=False)
    unit_price = db.Column(db.Numeric(12, 2), default=0, nullable=False)
    amount_loss = db.Column(db.Numeric(12, 2), default=0, nullable=False)

    entry = db.relationship("BranchDailyEntry", backref=db.backref("loss_items", lazy=True, cascade="all, delete-orphan"))
    delivery_item = db.relationship("DeliveryItem")
    product = db.relationship("Product")


class UserAccount(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(50), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    role = db.Column(db.String(20), default="store", nullable=False)  # admin/store
    display_name = db.Column(db.String(100), default="", nullable=False)
    store_id = db.Column(db.Integer, db.ForeignKey("store.id"), nullable=True)
    active = db.Column(db.Boolean, default=True, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)

    store = db.relationship("Store")


# -----------------------------
# Utils
# -----------------------------

def d(v) -> Decimal:
    if v is None or v == "":
        return Decimal("0")
    if isinstance(v, Decimal):
        return v
    return Decimal(str(v))


def gen_no(prefix: str) -> str:
    return f"{prefix}{datetime.now().strftime('%Y%m%d%H%M%S%f')[:20]}"


def parse_date(s: str) -> date:
    return datetime.strptime(s, "%Y-%m-%d").date()


def json_ok(data=None, **extra):
    payload = {"ok": True}
    if data is not None:
        payload["data"] = data
    payload.update(extra)
    return jsonify(payload)


def json_err(message: str, status: int = 400):
    return jsonify({"ok": False, "error": message}), status


def get_price(store_id: int, product_id: int, on_date: date) -> Decimal:
    row = (
        StoreProductPrice.query.filter_by(store_id=store_id, product_id=product_id)
        .filter(StoreProductPrice.effective_from <= on_date)
        .filter((StoreProductPrice.effective_to.is_(None)) | (StoreProductPrice.effective_to >= on_date))
        .order_by(StoreProductPrice.effective_from.desc())
        .first()
    )
    if row:
        return d(row.price)
    product = db.session.get(Product, product_id)
    return d(product.default_price) if product else Decimal("0")


def get_current_account():
    user_id = session.get("user_id")
    if not user_id:
        return None
    return db.session.get(UserAccount, int(user_id))


def require_login():
    account = get_current_account()
    if not account or not account.active:
        return None, json_err("请先登录", 401)
    return account, None


def require_admin():
    account, err = require_login()
    if err:
        return None, err
    if account.role != "admin":
        return None, json_err("只有总店账号可以操作", 403)
    return account, None


def account_can_access_store(account: UserAccount, store_id: int) -> bool:
    if account.role == "admin":
        return True
    return account.store_id == store_id


def account_payload(account: UserAccount):
    return {
        "id": account.id,
        "username": account.username,
        "role": account.role,
        "display_name": account.display_name or account.username,
        "store_id": account.store_id,
        "store_name": account.store.name if account.store else None,
    }


def build_store_username(store: Store) -> str:
    return f"store_{store.code.lower()}"


def ensure_store_account(store: Store):
    username = build_store_username(store)
    account = UserAccount.query.filter_by(username=username).first()
    if not account:
        account = UserAccount(
            username=username,
            password_hash=generate_password_hash("123456"),
            role="store",
            display_name=f"{store.name} 门店账号",
            store_id=store.id,
            active=True,
        )
        db.session.add(account)
    else:
        account.store_id = store.id
        account.role = "store"
        if not account.display_name:
            account.display_name = f"{store.name} 门店账号"
    return account


def migrate_schema():
    product_columns = [row[1] for row in db.session.execute(text("PRAGMA table_info(product)")).fetchall()]
    if "default_price" not in product_columns:
        db.session.execute(text("ALTER TABLE product ADD COLUMN default_price NUMERIC DEFAULT 0 NOT NULL"))
        db.session.commit()
    if "category" not in product_columns:
        db.session.execute(text("ALTER TABLE product ADD COLUMN category VARCHAR(50) DEFAULT '默认' NOT NULL"))
        db.session.commit()


# -----------------------------
# Static HTML entry
# -----------------------------

@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/me")
def api_me():
    account = get_current_account()
    if not account or not account.active:
        return json_ok(None, authenticated=False)
    return json_ok(account_payload(account), authenticated=True)


@app.post("/api/login")
def api_login():
    body = request.get_json(force=True, silent=True) or {}
    username = (body.get("username") or "").strip()
    password = (body.get("password") or "").strip()
    if not username or not password:
        return json_err("用户名和密码必填")

    account = UserAccount.query.filter_by(username=username).first()
    if not account or not account.active or not check_password_hash(account.password_hash, password):
        return json_err("账号或密码错误", 401)

    session["user_id"] = account.id
    return json_ok(account_payload(account))


@app.post("/api/logout")
def api_logout():
    session.pop("user_id", None)
    return json_ok()


@app.post("/api/change-password")
def api_change_password():
    account, err = require_login()
    if err:
        return err
    body = request.get_json(force=True, silent=True) or {}
    current_password = (body.get("current_password") or "").strip()
    new_password = (body.get("new_password") or "").strip()
    confirm_password = (body.get("confirm_password") or "").strip()

    if not current_password or not new_password or not confirm_password:
        return json_err("请填写完整密码信息")
    if not check_password_hash(account.password_hash, current_password):
        return json_err("当前密码不正确")
    if len(new_password) < 6:
        return json_err("新密码至少6位")
    if new_password != confirm_password:
        return json_err("两次输入的新密码不一致")

    account.password_hash = generate_password_hash(new_password)
    db.session.commit()
    return json_ok({"message": "密码修改成功"})


@app.before_request
def protect_api_routes():
    if not request.path.startswith("/api/"):
        return None
    if request.path in ("/api/login", "/api/me"):
        return None
    account = get_current_account()
    if not account or not account.active:
        return json_err("请先登录", 401)
    return None


# -----------------------------
# API: Store / Product / Price
# -----------------------------

@app.get("/api/stores")
def api_stores_list():
    account, err = require_login()
    if err:
        return err
    query = Store.query
    if account.role != "admin":
        query = query.filter_by(id=account.store_id)
    rows = query.order_by(Store.id.desc()).all()
    return json_ok(
        [
            {
                "id": r.id,
                "code": r.code,
                "name": r.name,
                "settlement_type": r.settlement_type,
                "username": build_store_username(r),
                "default_password": "123456" if account.role == "admin" else None,
            }
            for r in rows
        ]
    )


@app.post("/api/stores")
def api_stores_create():
    account, err = require_admin()
    if err:
        return err
    body = request.get_json(force=True, silent=True) or {}
    code = (body.get("code") or "").strip()
    name = (body.get("name") or "").strip()
    if not code or not name:
        return json_err("code/name 必填")
    if Store.query.filter_by(code=code).first():
        return json_err("门店编码已存在")
    s = Store(code=code, name=name, address=(body.get("address") or "").strip(), settlement_type=body.get("settlement_type") or "cash")
    db.session.add(s)
    db.session.flush()
    ensure_store_account(s)
    db.session.commit()
    return json_ok({"id": s.id, "username": build_store_username(s), "default_password": "123456"})


@app.get("/api/products")
def api_products_list():
    account, err = require_login()
    if err:
        return err
    rows = Product.query.order_by(Product.id.desc()).all()
    return json_ok([{"id": r.id, "sku": r.sku, "name": r.name, "category": r.category or "默认", "unit": r.unit, "default_price": float(r.default_price or 0)} for r in rows])


@app.post("/api/products")
def api_products_create():
    account, err = require_admin()
    if err:
        return err
    body = request.get_json(force=True, silent=True) or {}
    sku = (body.get("sku") or "").strip()
    name = (body.get("name") or "").strip()
    category = (body.get("category") or "默认").strip()
    if not sku or not name:
        return json_err("sku/name 必填")
    if Product.query.filter_by(sku=sku).first():
        return json_err("SKU已存在")
    p = Product(
        sku=sku,
        name=name,
        category=category or "默认",
        unit=(body.get("unit") or "个").strip(),
        allow_return=True,
        default_price=d(body.get("default_price")),
    )
    db.session.add(p)
    db.session.commit()
    return json_ok({"id": p.id})


@app.post("/api/products/<int:product_id>/delete")
def api_products_delete(product_id: int):
    account, err = require_admin()
    if err:
        return err
    product = db.session.get(Product, product_id)
    if not product:
        return json_err("面包不存在", 404)
    try:
        db.session.delete(product)
        db.session.commit()
    except Exception:
        db.session.rollback()
        return json_err("这个面包已经被送货或价格记录使用，不能删除")
    return json_ok({"id": product_id})


@app.get("/api/prices")
def api_prices_list():
    account, err = require_login()
    if err:
        return err
    rows = StoreProductPrice.query.order_by(StoreProductPrice.id.desc()).limit(200).all()
    if account.role != "admin":
        rows = [r for r in rows if r.store_id == account.store_id]
    return json_ok(
        [
            {
                "id": r.id,
                "store_id": r.store_id,
                "store_name": r.store.name,
                "product_id": r.product_id,
                "product_name": r.product.name,
                "price": float(r.price),
                "effective_from": r.effective_from.isoformat(),
            }
            for r in rows
        ]
    )


@app.post("/api/prices")
def api_prices_create():
    account, err = require_admin()
    if err:
        return err
    body = request.get_json(force=True, silent=True) or {}
    try:
        store_id = int(body.get("store_id"))
        product_id = int(body.get("product_id"))
        price = d(body.get("price"))
        effective_from = parse_date(body.get("effective_from") or date.today().isoformat())
    except Exception:
        return json_err("参数格式不正确")
    if price <= 0:
        return json_err("price 必须大于0")
    row = StoreProductPrice(store_id=store_id, product_id=product_id, price=price, effective_from=effective_from)
    db.session.add(row)
    db.session.commit()
    return json_ok({"id": row.id})


# -----------------------------
# API: Orders
# -----------------------------

@app.get("/api/orders")
def api_orders_list():
    rows = StoreOrder.query.order_by(StoreOrder.id.desc()).limit(100).all()
    return json_ok(
        [
            {
                "id": r.id,
                "order_no": r.order_no,
                "store_id": r.store_id,
                "store_name": r.store.name,
                "delivery_date": r.delivery_date.isoformat(),
                "status": r.status,
            }
            for r in rows
        ]
    )


@app.post("/api/orders")
def api_orders_create():
    body = request.get_json(force=True, silent=True) or {}
    try:
        store_id = int(body.get("store_id"))
        delivery_date = parse_date(body.get("delivery_date"))
    except Exception:
        return json_err("store_id / delivery_date 参数不正确")
    o = StoreOrder(order_no=gen_no("SO"), store_id=store_id, delivery_date=delivery_date, status="draft")
    db.session.add(o)
    db.session.commit()
    return json_ok({"id": o.id, "order_no": o.order_no})


@app.get("/api/orders/<int:order_id>")
def api_orders_get(order_id: int):
    o = db.session.get(StoreOrder, order_id)
    if not o:
        return json_err("订单不存在", 404)
    return json_ok(
        {
            "id": o.id,
            "order_no": o.order_no,
            "store_id": o.store_id,
            "store_name": o.store.name,
            "delivery_date": o.delivery_date.isoformat(),
            "status": o.status,
            "items": [{"id": it.id, "product_id": it.product_id, "product_name": it.product.name, "qty": float(it.qty), "confirmed_qty": float(it.confirmed_qty or 0)} for it in o.items],
        }
    )


@app.post("/api/orders/<int:order_id>/items")
def api_orders_add_item(order_id: int):
    o = db.session.get(StoreOrder, order_id)
    if not o:
        return json_err("订单不存在", 404)
    if o.status != "draft":
        return json_err("只有草稿订单可加行")
    body = request.get_json(force=True, silent=True) or {}
    try:
        product_id = int(body.get("product_id"))
        qty = d(body.get("qty"))
    except Exception:
        return json_err("参数不正确")
    if qty <= 0:
        return json_err("qty 必须大于0")
    it = StoreOrderItem(order_id=o.id, product_id=product_id, qty=qty, confirmed_qty=None)
    db.session.add(it)
    db.session.commit()
    return json_ok({"id": it.id})


@app.post("/api/orders/<int:order_id>/confirm")
def api_orders_confirm(order_id: int):
    o = db.session.get(StoreOrder, order_id)
    if not o:
        return json_err("订单不存在", 404)
    if o.status != "draft":
        return json_err("只有草稿订单可确认")
    if not o.items:
        return json_err("订单没有明细行")
    for it in o.items:
        it.confirmed_qty = it.qty
    o.status = "confirmed"
    db.session.commit()
    return json_ok()


# -----------------------------
# API: Delivery / Sign / AR
# -----------------------------

@app.get("/api/deliveries")
def api_deliveries_list():
    account, err = require_login()
    if err:
        return err
    rows = Delivery.query.order_by(Delivery.id.desc()).limit(50).all()
    data = []
    for r in rows:
        stops = sorted(r.stops, key=lambda x: x.seq)
        if account.role != "admin":
            stops = [s for s in stops if s.store_id == account.store_id]
            if not stops:
                continue
        total_amount = Decimal("0")
        signed_count = 0
        for stop in stops:
            if stop.status == "signed":
                signed_count += 1
            for item in stop.items:
                total_amount += d(item.qty_should) * d(item.unit_price)
        data.append(
            {
                "id": r.id,
                "delivery_no": r.delivery_no,
                "delivery_date": r.delivery_date.isoformat(),
                "status": r.status,
                "store_names": "、".join([s.store.name for s in stops]),
                "stop_count": len(stops),
                "signed_count": signed_count,
                "total_amount": float(total_amount),
            }
        )
    return json_ok(data)


@app.post("/api/deliveries/generate")
def api_deliveries_generate():
    body = request.get_json(force=True, silent=True) or {}
    try:
        delivery_date = parse_date(body.get("delivery_date"))
    except Exception:
        return json_err("delivery_date 参数不正确")
    orders = StoreOrder.query.filter_by(delivery_date=delivery_date, status="confirmed").all()
    if not orders:
        return json_err("当日没有已确认订单")

    delivery = Delivery(delivery_no=gen_no("DL"), delivery_date=delivery_date, status="draft")
    db.session.add(delivery)
    db.session.flush()

    seq = 1
    for o in orders:
        stop = DeliveryStop(delivery_id=delivery.id, store_id=o.store_id, seq=seq, status="pending")
        db.session.add(stop)
        db.session.flush()
        seq += 1

        for it in o.items:
            qty_should = d(it.confirmed_qty if it.confirmed_qty is not None else it.qty)
            if qty_should <= 0:
                continue
            price = get_price(o.store_id, it.product_id, delivery_date)
            di = DeliveryItem(delivery_stop_id=stop.id, product_id=it.product_id, qty_should=qty_should, unit_price=price)
            db.session.add(di)

    db.session.commit()
    return json_ok({"id": delivery.id, "delivery_no": delivery.delivery_no})


@app.post("/api/deliveries/direct")
def api_deliveries_direct():
    account, err = require_admin()
    if err:
        return err
    body = request.get_json(force=True, silent=True) or {}
    try:
        delivery_date = parse_date(body.get("delivery_date"))
        store_id = int(body.get("store_id"))
    except Exception:
        return json_err("delivery_date / store_id 参数不正确")

    items = body.get("items") or []
    if not isinstance(items, list) or not items:
        return json_err("items 不能为空")

    store = db.session.get(Store, store_id)
    if not store:
        return json_err("门店不存在", 404)

    normalized_items = []
    for row in items:
        try:
            product_id = int(row.get("product_id"))
            qty = d(row.get("qty"))
        except Exception:
            return json_err("items 里有参数格式不正确")
        if qty <= 0:
            return json_err("送货数量必须大于0")
        product = db.session.get(Product, product_id)
        if not product:
            return json_err(f"产品不存在：{product_id}", 404)
        price = get_price(store_id, product_id, delivery_date)
        normalized_items.append({"product_id": product_id, "qty": qty, "price": price, "product_name": product.name})

    delivery = Delivery(delivery_no=gen_no("DL"), delivery_date=delivery_date, status="draft")
    db.session.add(delivery)
    db.session.flush()

    stop = DeliveryStop(delivery_id=delivery.id, store_id=store_id, seq=1, status="pending")
    db.session.add(stop)
    db.session.flush()

    total_amount = Decimal("0")
    for row in normalized_items:
        total_amount += row["qty"] * row["price"]
        db.session.add(
            DeliveryItem(
                delivery_stop_id=stop.id,
                product_id=row["product_id"],
                qty_should=row["qty"],
                unit_price=row["price"],
            )
        )

    db.session.commit()
    return json_ok(
        {
            "id": delivery.id,
            "delivery_no": delivery.delivery_no,
            "store_name": store.name,
            "total_amount": float(total_amount),
        }
    )


@app.get("/api/deliveries/<int:delivery_id>/stops")
def api_delivery_stops(delivery_id: int):
    account, err = require_login()
    if err:
        return err
    dly = db.session.get(Delivery, delivery_id)
    if not dly:
        return json_err("配送单不存在", 404)
    stops = sorted(dly.stops, key=lambda x: x.seq)
    if account.role != "admin":
        stops = [s for s in stops if s.store_id == account.store_id]
    return json_ok([{"id": s.id, "seq": s.seq, "store_id": s.store_id, "store_name": s.store.name, "status": s.status} for s in stops])


@app.get("/api/stops/<int:stop_id>")
def api_stop_detail(stop_id: int):
    account, err = require_login()
    if err:
        return err
    stop = db.session.get(DeliveryStop, stop_id)
    if not stop:
        return json_err("站点不存在", 404)
    if not account_can_access_store(account, stop.store_id):
        return json_err("无权查看该门店数据", 403)
    items = []
    for it in stop.items:
        si = it.signed
        items.append(
            {
                "delivery_item_id": it.id,
                "product_id": it.product_id,
                "product_name": it.product.name,
                "qty_should": float(it.qty_should),
                "unit_price": float(it.unit_price),
                "qty_signed": float(si.qty_signed) if si else None,
                "qty_return": float(si.qty_return) if si else None,
                "short_reason": si.short_reason if si else "",
                "return_reason": si.return_reason if si else "",
            }
        )
    return json_ok(
        {
            "id": stop.id,
            "delivery_id": stop.delivery_id,
            "delivery_no": stop.delivery.delivery_no,
            "delivery_date": stop.delivery.delivery_date.isoformat(),
            "store_id": stop.store_id,
            "store_name": stop.store.name,
            "status": stop.status,
            "receiver_name": stop.receiver_name,
            "items": items,
        }
    )


def rebuild_invoice_for_store(store_id: int, biz_date: date):
    signed_items = (
        db.session.query(DeliveryItem, DeliverySignedItem)
        .join(DeliveryStop, DeliveryStop.id == DeliveryItem.delivery_stop_id)
        .join(Delivery, Delivery.id == DeliveryStop.delivery_id)
        .join(DeliverySignedItem, DeliverySignedItem.delivery_item_id == DeliveryItem.id)
        .filter(DeliveryStop.store_id == store_id)
        .filter(Delivery.delivery_date == biz_date)
        .filter(DeliveryStop.status == "signed")
        .all()
    )

    if not signed_items:
        return None

    inv = ARInvoice.query.filter_by(store_id=store_id, biz_date=biz_date).first()
    if not inv:
        inv = ARInvoice(invoice_no=gen_no("AR"), store_id=store_id, biz_date=biz_date, status="open")
        db.session.add(inv)
        db.session.flush()
    else:
        ARInvoiceLine.query.filter_by(invoice_id=inv.id).delete()

    amount_goods = Decimal("0")
    amount_deduction = Decimal("0")
    lines_by_product = {}

    for di, si in signed_items:
        pid = di.product_id
        if pid not in lines_by_product:
            lines_by_product[pid] = {
                "unit_price": d(di.unit_price),
                "qty_should": Decimal("0"),
                "qty_signed": Decimal("0"),
                "qty_return": Decimal("0"),
                "qty_short": Decimal("0"),
            }
        lines_by_product[pid]["qty_should"] += d(di.qty_should)
        lines_by_product[pid]["qty_signed"] += d(si.qty_signed)
        lines_by_product[pid]["qty_return"] += d(si.qty_return)
        lines_by_product[pid]["qty_short"] += d(si.qty_short)

    for pid, agg in lines_by_product.items():
        unit_price = agg["unit_price"]
        qty_should = agg["qty_should"]
        qty_signed = agg["qty_signed"]
        qty_return = agg["qty_return"]
        qty_short = agg["qty_short"]

        goods = qty_should * unit_price
        deduction = (qty_return + qty_short) * unit_price
        receivable = goods - deduction  # = signed * price

        amount_goods += goods
        amount_deduction += deduction

        line = ARInvoiceLine(
            invoice_id=inv.id,
            product_id=pid,
            qty_signed=qty_signed,
            unit_price=unit_price,
            amount_line=receivable,
            qty_return=qty_return,
            amount_return=qty_return * unit_price,
            qty_short=qty_short,
            amount_short=qty_short * unit_price,
        )
        db.session.add(line)

    inv.amount_goods = amount_goods
    inv.amount_deduction = amount_deduction
    inv.amount_receivable = amount_goods - amount_deduction

    paid = d(inv.amount_paid)
    if paid <= 0:
        inv.status = "open"
    elif paid < d(inv.amount_receivable):
        inv.status = "partially_paid"
    else:
        inv.status = "paid"

    db.session.commit()
    return inv


@app.post("/api/stops/<int:stop_id>/sign")
def api_stop_sign(stop_id: int):
    stop = db.session.get(DeliveryStop, stop_id)
    if not stop:
        return json_err("站点不存在", 404)
    body = request.get_json(force=True, silent=True) or {}
    stop.receiver_name = (body.get("receiver_name") or "").strip()
    items = body.get("items") or []
    if not isinstance(items, list) or not items:
        return json_err("items 不能为空（数组）")

    # 建立映射
    by_id = {it.id: it for it in stop.items}
    for row in items:
        try:
            delivery_item_id = int(row.get("delivery_item_id"))
            qty_signed = d(row.get("qty_signed"))
            qty_return = d(row.get("qty_return"))
            short_reason = (row.get("short_reason") or "").strip()
            return_reason = (row.get("return_reason") or "").strip()
        except Exception:
            return json_err("items里有参数格式不正确")

        di = by_id.get(delivery_item_id)
        if not di:
            return json_err(f"delivery_item_id 不属于该站点：{delivery_item_id}")

        qty_should = d(di.qty_should)
        if qty_signed < 0 or qty_return < 0:
            return json_err("数量不能为负数")
        if qty_signed + qty_return > qty_should:
            return json_err("实收+退货不能超过应送")
        qty_short = qty_should - qty_signed - qty_return

        si = di.signed
        if not si:
            si = DeliverySignedItem(delivery_item_id=di.id)
            db.session.add(si)
        si.qty_signed = qty_signed
        si.qty_return = qty_return
        si.qty_short = qty_short
        si.short_reason = short_reason
        si.return_reason = return_reason

    stop.status = "signed"
    stop.signed_at = datetime.utcnow()
    db.session.commit()

    inv = rebuild_invoice_for_store(stop.store_id, stop.delivery.delivery_date)
    return json_ok({"invoice_id": inv.id, "invoice_no": inv.invoice_no} if inv else None)


@app.get("/api/ar")
def api_ar_list():
    rows = ARInvoice.query.order_by(ARInvoice.id.desc()).limit(200).all()
    return json_ok(
        [
            {
                "id": r.id,
                "invoice_no": r.invoice_no,
                "store_id": r.store_id,
                "store_name": r.store.name,
                "biz_date": r.biz_date.isoformat(),
                "status": r.status,
                "amount_receivable": float(r.amount_receivable),
                "amount_paid": float(r.amount_paid),
            }
            for r in rows
        ]
    )


@app.get("/api/ar/<int:invoice_id>")
def api_ar_detail(invoice_id: int):
    inv = db.session.get(ARInvoice, invoice_id)
    if not inv:
        return json_err("应收单不存在", 404)
    return json_ok(
        {
            "id": inv.id,
            "invoice_no": inv.invoice_no,
            "store_id": inv.store_id,
            "store_name": inv.store.name,
            "biz_date": inv.biz_date.isoformat(),
            "status": inv.status,
            "amount_goods": float(inv.amount_goods),
            "amount_deduction": float(inv.amount_deduction),
            "amount_receivable": float(inv.amount_receivable),
            "amount_paid": float(inv.amount_paid),
            "lines": [
                {
                    "product_name": ln.product.name,
                    "unit_price": float(ln.unit_price),
                    "qty_signed": float(ln.qty_signed),
                    "qty_return": float(ln.qty_return),
                    "qty_short": float(ln.qty_short),
                    "amount_line": float(ln.amount_line),
                }
                for ln in inv.lines
            ],
        }
    )


@app.post("/api/payments")
def api_payment_create():
    body = request.get_json(force=True, silent=True) or {}
    try:
        store_id = int(body.get("store_id"))
        invoice_id = int(body.get("invoice_id"))
        amount = d(body.get("amount"))
        pay_date = parse_date(body.get("pay_date") or date.today().isoformat())
        method = (body.get("method") or "cash").strip()
    except Exception:
        return json_err("参数不正确")
    if amount <= 0:
        return json_err("amount 必须大于0")
    inv = db.session.get(ARInvoice, invoice_id)
    if not inv:
        return json_err("应收单不存在", 404)
    if inv.store_id != store_id:
        return json_err("门店与应收单不匹配")

    p = Payment(
        payment_no=gen_no("PM"),
        store_id=store_id,
        pay_date=pay_date,
        method=method,
        amount=amount,
        reference_no=(body.get("reference_no") or "").strip(),
        received_by=(body.get("received_by") or "").strip(),
    )
    db.session.add(p)
    db.session.flush()

    alloc = PaymentAllocation(payment_id=p.id, invoice_id=inv.id, amount_allocated=amount)
    db.session.add(alloc)

    inv.amount_paid = d(inv.amount_paid) + amount
    if d(inv.amount_paid) >= d(inv.amount_receivable):
        inv.status = "paid"
    else:
        inv.status = "partially_paid"
    db.session.commit()
    return json_ok({"payment_id": p.id, "payment_no": p.payment_no, "invoice_status": inv.status})


@app.get("/api/branch-daily")
def api_branch_daily_list():
    account, err = require_login()
    if err:
        return err
    try:
        biz_date = parse_date(request.args.get("biz_date") or date.today().isoformat())
    except Exception:
        return json_err("biz_date 参数不正确")

    rows = BranchDailyEntry.query.filter_by(biz_date=biz_date).order_by(BranchDailyEntry.id.desc()).all()
    if account.role != "admin":
        rows = [r for r in rows if r.store_id == account.store_id]
    return json_ok(
        [
            {
                "id": r.id,
                "store_id": r.store_id,
                "store_name": r.store.name,
                "biz_date": r.biz_date.isoformat(),
                "received_amount": float(r.received_amount),
                "loss_amount": float(r.loss_amount),
                "loss_note": r.loss_note,
                "loss_item_count": len(r.loss_items),
            }
            for r in rows
        ]
    )


@app.get("/api/branch-daily/form")
def api_branch_daily_form():
    account, err = require_login()
    if err:
        return err
    try:
        store_id = int(request.args.get("store_id"))
        biz_date = parse_date(request.args.get("biz_date") or date.today().isoformat())
    except Exception:
        return json_err("store_id / biz_date 参数不正确")
    if not account_can_access_store(account, store_id):
        return json_err("无权查看该门店数据", 403)

    entry = BranchDailyEntry.query.filter_by(store_id=store_id, biz_date=biz_date).first()
    loss_map = {}
    if entry:
        for loss in entry.loss_items:
            loss_map[loss.delivery_item_id] = {
                "qty_loss": float(loss.qty_loss),
                "amount_loss": float(loss.amount_loss),
            }

    items = []
    stops = (
        DeliveryStop.query.join(Delivery, Delivery.id == DeliveryStop.delivery_id)
        .filter(DeliveryStop.store_id == store_id)
        .filter(Delivery.delivery_date == biz_date)
        .order_by(Delivery.id.desc(), DeliveryStop.id.asc())
        .all()
    )
    for stop in stops:
        for item in stop.items:
            saved = loss_map.get(item.id, {})
            items.append(
                {
                    "delivery_no": stop.delivery.delivery_no,
                    "delivery_item_id": item.id,
                    "product_id": item.product_id,
                    "product_name": item.product.name,
                    "qty_should": float(item.qty_should),
                    "unit_price": float(item.unit_price),
                    "qty_loss": saved.get("qty_loss", 0),
                    "amount_loss": saved.get("amount_loss", 0),
                }
            )
    return json_ok(
        {
            "store_id": store_id,
            "biz_date": biz_date.isoformat(),
            "received_amount": float(entry.received_amount) if entry else 0,
            "loss_amount": float(entry.loss_amount) if entry else 0,
            "loss_note": entry.loss_note if entry else "",
            "items": items,
        }
    )


@app.post("/api/branch-daily")
def api_branch_daily_upsert():
    account, err = require_login()
    if err:
        return err
    body = request.get_json(force=True, silent=True) or {}
    try:
        store_id = int(body.get("store_id"))
        biz_date = parse_date(body.get("biz_date") or date.today().isoformat())
        received_amount = d(body.get("received_amount"))
    except Exception:
        return json_err("参数不正确")
    if not account_can_access_store(account, store_id):
        return json_err("无权填写该门店数据", 403)
    if received_amount < 0:
        return json_err("收回金额不能小于0")

    store = db.session.get(Store, store_id)
    if not store:
        return json_err("门店不存在", 404)

    entry = BranchDailyEntry.query.filter_by(store_id=store_id, biz_date=biz_date).first()
    if not entry:
        entry = BranchDailyEntry(store_id=store_id, biz_date=biz_date)
        db.session.add(entry)
        db.session.flush()

    BranchDailyLossItem.query.filter_by(entry_id=entry.id).delete()
    total_loss_amount = Decimal("0")
    loss_items = body.get("loss_items") or []
    if not isinstance(loss_items, list):
        return json_err("loss_items 必须是数组")
    for row in loss_items:
        try:
            delivery_item_id = int(row.get("delivery_item_id"))
            qty_loss = d(row.get("qty_loss"))
        except Exception:
            return json_err("损失明细参数不正确")
        if qty_loss < 0:
            return json_err("烂掉数量不能小于0")
        if qty_loss == 0:
            continue
        di = db.session.get(DeliveryItem, delivery_item_id)
        if not di:
            return json_err("送货明细不存在", 404)
        if di.stop.store_id != store_id or di.stop.delivery.delivery_date != biz_date:
            return json_err("损失明细不属于该门店当天送货", 400)
        if qty_loss > d(di.qty_should):
            return json_err("烂掉数量不能超过送货数量")
        amount_loss = qty_loss * d(di.unit_price)
        total_loss_amount += amount_loss
        db.session.add(
            BranchDailyLossItem(
                entry_id=entry.id,
                delivery_item_id=di.id,
                product_id=di.product_id,
                qty_loss=qty_loss,
                unit_price=d(di.unit_price),
                amount_loss=amount_loss,
            )
        )

    entry.received_amount = received_amount
    entry.loss_amount = total_loss_amount
    entry.loss_note = (body.get("loss_note") or "").strip()
    db.session.commit()

    return json_ok({"id": entry.id, "store_name": store.name, "loss_amount": float(total_loss_amount)})


def build_branch_daily_report(biz_date: date, account: UserAccount | None = None):
    deliveries = Delivery.query.filter_by(delivery_date=biz_date).order_by(Delivery.id.desc()).all()
    branch_entries = BranchDailyEntry.query.filter_by(biz_date=biz_date).all()

    store_map = {}
    loss_details = []
    delivery_details = []

    def ensure_store_row(store_id: int, store_name: str):
        if store_id not in store_map:
            store_map[store_id] = {
                "store_id": store_id,
                "store_name": store_name,
                "variety_count": 0,
                "total_qty": Decimal("0"),
                "sent_amount": Decimal("0"),
                "received_amount": Decimal("0"),
                "loss_amount": Decimal("0"),
                "loss_note": "",
            }
        return store_map[store_id]

    for delivery in deliveries:
        for stop in delivery.stops:
            if account and account.role != "admin" and stop.store_id != account.store_id:
                continue
            row = ensure_store_row(stop.store_id, stop.store.name)
            varieties = set()
            for item in stop.items:
                row["total_qty"] += d(item.qty_should)
                row["sent_amount"] += d(item.qty_should) * d(item.unit_price)
                varieties.add(item.product_id)
                delivery_details.append(
                    {
                        "store_id": stop.store_id,
                        "store_name": stop.store.name,
                        "delivery_no": stop.delivery.delivery_no,
                        "product_name": item.product.name,
                        "qty_should": float(item.qty_should),
                        "unit_price": float(item.unit_price),
                        "amount": float(d(item.qty_should) * d(item.unit_price)),
                    }
                )
            row["variety_count"] += len(varieties)

    for entry in branch_entries:
        if account and account.role != "admin" and entry.store_id != account.store_id:
            continue
        row = ensure_store_row(entry.store_id, entry.store.name)
        row["received_amount"] += d(entry.received_amount)
        row["loss_amount"] += d(entry.loss_amount)
        if entry.loss_note:
            row["loss_note"] = entry.loss_note
        for loss in entry.loss_items:
            loss_details.append(
                {
                    "store_id": entry.store_id,
                    "store_name": entry.store.name,
                    "product_id": loss.product_id,
                    "product_name": loss.product.name,
                    "delivery_no": loss.delivery_item.stop.delivery.delivery_no if loss.delivery_item else "",
                    "qty_loss": float(loss.qty_loss),
                    "unit_price": float(loss.unit_price),
                    "amount_loss": float(loss.amount_loss),
                    "loss_note": entry.loss_note,
                }
            )

    stores = []
    sent_store_count = 0
    total_sent_amount = Decimal("0")
    total_received_amount = Decimal("0")
    total_loss_amount = Decimal("0")
    total_balance_amount = Decimal("0")

    for row in store_map.values():
        balance = row["sent_amount"] - row["received_amount"] - row["loss_amount"]
        if row["sent_amount"] > 0:
            sent_store_count += 1
        total_sent_amount += row["sent_amount"]
        total_received_amount += row["received_amount"]
        total_loss_amount += row["loss_amount"]
        total_balance_amount += balance
        stores.append(
            {
                "store_id": row["store_id"],
                "store_name": row["store_name"],
                "variety_count": row["variety_count"],
                "total_qty": float(row["total_qty"]),
                "sent_amount": float(row["sent_amount"]),
                "received_amount": float(row["received_amount"]),
                "loss_amount": float(row["loss_amount"]),
                "balance_amount": float(balance),
                "loss_note": row["loss_note"],
            }
        )

    stores.sort(key=lambda x: (-x["sent_amount"], x["store_name"]))
    loss_details.sort(key=lambda x: (x["store_name"], x["product_name"], x["delivery_no"]))
    delivery_details.sort(key=lambda x: (x["store_name"], x["delivery_no"], x["product_name"]))
    return {
        "biz_date": biz_date.isoformat(),
        "summary": {
            "store_count": len(stores),
            "sent_store_count": sent_store_count,
            "sent_amount": float(total_sent_amount),
            "received_amount": float(total_received_amount),
            "loss_amount": float(total_loss_amount),
            "balance_amount": float(total_balance_amount),
        },
        "stores": stores,
        "loss_details": loss_details,
        "delivery_details": delivery_details,
    }


@app.get("/api/reports/branch-daily")
def api_report_branch_daily():
    account, err = require_login()
    if err:
        return err
    try:
        biz_date = parse_date(request.args.get("biz_date") or date.today().isoformat())
    except Exception:
        return json_err("biz_date 参数不正确")
    return json_ok(build_branch_daily_report(biz_date, account))


@app.get("/report-print")
def report_print():
    account = get_current_account()
    if not account or not account.active:
        return "请先登录", 401
    try:
        biz_date = parse_date(request.args.get("biz_date") or date.today().isoformat())
    except Exception:
        biz_date = date.today()

    report = build_branch_daily_report(biz_date, account)
    rows_html = "".join(
        f"""
        <tr>
          <td>{row['store_name']}</td>
          <td>{row['variety_count']}</td>
          <td>{row['total_qty']:.2f}</td>
          <td>{row['sent_amount']:.2f}</td>
          <td>{row['received_amount']:.2f}</td>
          <td>{row['loss_amount']:.2f}</td>
          <td>{row['balance_amount']:.2f}</td>
          <td>{row['loss_note']}</td>
        </tr>
        """
        for row in report["stores"]
    )
    delivery_rows_html = "".join(
        f"""
        <tr>
          <td>{row['store_name']}</td>
          <td>{row['delivery_no']}</td>
          <td>{row['product_name']}</td>
          <td>{row['qty_should']:.2f}</td>
          <td>{row['unit_price']:.2f}</td>
          <td>{row['amount']:.2f}</td>
        </tr>
        """
        for row in report["delivery_details"]
    )
    loss_rows_html = "".join(
        f"""
        <tr>
          <td>{row['store_name']}</td>
          <td>{row['product_name']}</td>
          <td>{row['delivery_no']}</td>
          <td>{row['qty_loss']:.2f}</td>
          <td>{row['unit_price']:.2f}</td>
          <td>{row['amount_loss']:.2f}</td>
          <td>{row['loss_note']}</td>
        </tr>
        """
        for row in report["loss_details"]
    )
    s = report["summary"]
    html = f"""
    <!doctype html>
    <html lang="zh">
    <head>
      <meta charset="utf-8">
      <title>分门店日报 {report['biz_date']}</title>
      <style>
        body {{ font-family: "Segoe UI", Arial, sans-serif; margin: 24px; color:#222; }}
        h1 {{ margin: 0 0 8px; font-size: 28px; }}
        h2 {{ margin: 28px 0 10px; font-size: 18px; color:#0d6efd; border-left:4px solid #0d6efd; padding-left:8px; }}
        .meta {{ margin-bottom: 16px; color:#555; }}
        table {{ width: 100%; border-collapse: collapse; }}
        th, td {{ border: 1px solid #cfd4da; padding: 8px; text-align: left; font-size: 12px; }}
        th {{ background: #f1f3f5; }}
        .summary {{ display: grid; grid-template-columns: repeat(3, minmax(120px, 1fr)); gap: 8px; margin: 12px 0 20px; }}
        .summary div {{ border: 1px solid #dbe4ff; background:#f8fbff; padding: 10px; border-radius:8px; }}
        .header {{ display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px; }}
        .header-right {{ text-align:right; color:#666; }}
        @media print {{ .print-btn {{ display: none; }} }}
      </style>
    </head>
    <body>
      <button class="print-btn" onclick="window.print()">导出PDF / 打印</button>
      <div class="header">
        <div>
          <h1>总店 / 分店营业日报</h1>
          <div class="meta">日期：{report['biz_date']}</div>
        </div>
        <div class="header-right">
          <div>系统导出报表</div>
          <div>{datetime.now().strftime('%Y-%m-%d %H:%M')}</div>
        </div>
      </div>
      <div class="summary">
        <div>门店数：{s['store_count']}</div>
        <div>送货总金额：{s['sent_amount']:.2f}</div>
        <div>收回总金额：{s['received_amount']:.2f}</div>
        <div>损失总金额：{s['loss_amount']:.2f}</div>
        <div>差额：{s['balance_amount']:.2f}</div>
        <div>有送货门店：{s['sent_store_count']}</div>
      </div>
      <h2>总店订单 / 送货明细</h2>
      <table>
        <thead>
          <tr>
            <th>门店</th>
            <th>配送单</th>
            <th>面包</th>
            <th>数量</th>
            <th>单价</th>
            <th>金额</th>
          </tr>
        </thead>
        <tbody>{delivery_rows_html}</tbody>
      </table>
      <h2>分门店汇总</h2>
      <table>
        <thead>
          <tr>
            <th>门店</th>
            <th>几款</th>
            <th>总数量</th>
            <th>送货金额</th>
            <th>收回金额</th>
            <th>损失金额</th>
            <th>差额</th>
            <th>损失备注</th>
          </tr>
        </thead>
        <tbody>{rows_html}</tbody>
      </table>
      <h2>烂面包明细</h2>
      <table>
        <thead>
          <tr>
            <th>门店</th>
            <th>面包</th>
            <th>配送单</th>
            <th>烂掉数量</th>
            <th>单价</th>
            <th>损失金额</th>
            <th>备注</th>
          </tr>
        </thead>
        <tbody>{loss_rows_html}</tbody>
      </table>
    </body>
    </html>
    """
    return html


@app.get("/api/reports/daily")
def api_report_daily():
    try:
        biz_date = parse_date(request.args.get("biz_date") or date.today().isoformat())
    except Exception:
        return json_err("biz_date 参数不正确")

    deliveries = Delivery.query.filter_by(delivery_date=biz_date).order_by(Delivery.id.desc()).all()
    invoices = ARInvoice.query.filter_by(biz_date=biz_date).all()
    payments = Payment.query.filter_by(pay_date=biz_date).all()

    sent_store_ids = set()
    signed_store_ids = set()
    total_sent_amount = Decimal("0")
    total_return_amount = Decimal("0")
    total_short_amount = Decimal("0")
    store_map = {}

    def ensure_store_row(store_id: int, store_name: str):
        if store_id not in store_map:
            store_map[store_id] = {
                "store_id": store_id,
                "store_name": store_name,
                "sent_amount": Decimal("0"),
                "signed_amount": Decimal("0"),
                "return_amount": Decimal("0"),
                "short_amount": Decimal("0"),
                "receivable": Decimal("0"),
                "paid_today": Decimal("0"),
                "unpaid": Decimal("0"),
                "delivery_count": 0,
                "signed_count": 0,
            }
        return store_map[store_id]

    for delivery in deliveries:
        for stop in delivery.stops:
            row = ensure_store_row(stop.store_id, stop.store.name)
            row["delivery_count"] += 1
            sent_store_ids.add(stop.store_id)
            stop_sent_amount = Decimal("0")
            stop_signed_amount = Decimal("0")
            stop_return_amount = Decimal("0")
            stop_short_amount = Decimal("0")

            for item in stop.items:
                line_amount = d(item.qty_should) * d(item.unit_price)
                stop_sent_amount += line_amount

                if item.signed:
                    stop_signed_amount += d(item.signed.qty_signed) * d(item.unit_price)
                    stop_return_amount += d(item.signed.qty_return) * d(item.unit_price)
                    stop_short_amount += d(item.signed.qty_short) * d(item.unit_price)

            row["sent_amount"] += stop_sent_amount
            total_sent_amount += stop_sent_amount

            if stop.status == "signed":
                signed_store_ids.add(stop.store_id)
                row["signed_count"] += 1
                row["signed_amount"] += stop_signed_amount
                row["return_amount"] += stop_return_amount
                row["short_amount"] += stop_short_amount
                total_return_amount += stop_return_amount
                total_short_amount += stop_short_amount

    total_receivable = Decimal("0")
    total_paid = Decimal("0")
    total_unpaid = Decimal("0")

    for inv in invoices:
        row = ensure_store_row(inv.store_id, inv.store.name)
        row["receivable"] += d(inv.amount_receivable)
        row["unpaid"] += d(inv.amount_receivable) - d(inv.amount_paid)
        total_receivable += d(inv.amount_receivable)
        total_unpaid += d(inv.amount_receivable) - d(inv.amount_paid)

    for pay in payments:
        row = ensure_store_row(pay.store_id, pay.store.name)
        row["paid_today"] += d(pay.amount)
        total_paid += d(pay.amount)

    rows = []
    for store_id, row in store_map.items():
        rows.append(
            {
                "store_id": store_id,
                "store_name": row["store_name"],
                "delivery_count": row["delivery_count"],
                "signed_count": row["signed_count"],
                "sent_amount": float(row["sent_amount"]),
                "signed_amount": float(row["signed_amount"]),
                "return_amount": float(row["return_amount"]),
                "short_amount": float(row["short_amount"]),
                "receivable": float(row["receivable"]),
                "paid_today": float(row["paid_today"]),
                "unpaid": float(row["unpaid"]),
            }
        )
    rows.sort(key=lambda x: (-x["sent_amount"], x["store_name"]))

    return json_ok(
        {
            "biz_date": biz_date.isoformat(),
            "summary": {
                "sent_store_count": len(sent_store_ids),
                "signed_store_count": len(signed_store_ids),
                "unsigned_store_count": max(len(sent_store_ids) - len(signed_store_ids), 0),
                "delivery_count": len(deliveries),
                "sent_amount": float(total_sent_amount),
                "return_amount": float(total_return_amount),
                "short_amount": float(total_short_amount),
                "receivable_amount": float(total_receivable),
                "paid_amount": float(total_paid),
                "unpaid_amount": float(total_unpaid),
            },
            "stores": rows,
        }
    )


# -----------------------------
# CLI
# -----------------------------

def initdb():
    db.create_all()
    migrate_schema()
    admin = UserAccount.query.filter_by(username="admin").first()
    if not admin:
        db.session.add(
            UserAccount(
                username="admin",
                password_hash=generate_password_hash("admin123"),
                role="admin",
                display_name="总店管理员",
                active=True,
            )
        )
    for store in Store.query.all():
        ensure_store_account(store)
    db.session.commit()
    print("DB initialized:", DB_PATH)


if __name__ == "__main__":
    with app.app_context():
        db.create_all()
        migrate_schema()
        if len(sys.argv) >= 2 and sys.argv[1] == "initdb":
            initdb()
            sys.exit(0)
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5001")), debug=True)

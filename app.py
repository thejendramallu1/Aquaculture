import argparse
import hmac
import json
import os
import re
import secrets
import sqlite3
import sys
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path

from flask import Flask, g, jsonify, request, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash


BASE_DIR = Path(__file__).resolve().parent
ROLES = {"farmer", "vendor", "management", "analyst", "admin"}
SELF_REGISTER_ROLES = {"farmer", "vendor"}
TEAM_ROLES = {"management", "analyst"}
FISH_SPECIES = {"Nile tilapia", "Atlantic salmon", "Common carp", "Other"}
WATER_TYPES = {"Freshwater", "Brackish", "Saltwater"}
CULTURE_SYSTEMS = {"Pond", "Cage", "Tank", "Raceway", "Other"}
FEED_CATEGORIES = {"Natural", "Organic", "Artificial"}
FEED_PREFERENCES = FEED_CATEGORIES | {"Any suitable feed"}
STATUS_VALUES = {"approved", "rejected"}
EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
DUMMY_PASSWORD_HASH = generate_password_hash("invalid-password-for-timing-only")

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('farmer', 'vendor', 'management', 'analyst', 'admin')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'rejected')),
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS farm_requests (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    farm TEXT NOT NULL,
    fish TEXT NOT NULL,
    water TEXT NOT NULL,
    culture TEXT NOT NULL,
    fish_count INTEGER NOT NULL CHECK (fish_count > 0),
    feed_need_kg REAL NOT NULL CHECK (feed_need_kg > 0),
    feed_preference TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('awaiting', 'approved', 'rejected')),
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inventory (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    species_json TEXT NOT NULL,
    waters_json TEXT NOT NULL,
    source TEXT NOT NULL,
    quantity_kg REAL NOT NULL CHECK (quantity_kg > 0),
    price_per_kg REAL NOT NULL CHECK (price_per_kg >= 0),
    vendor TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('awaiting', 'approved', 'rejected')),
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recommendations (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL REFERENCES farm_requests(id),
    feed_id TEXT NOT NULL REFERENCES inventory(id),
    score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
    reasons_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('awaitingAdmin', 'published', 'declined')),
    created_at TEXT NOT NULL,
    published_at TEXT
);
CREATE TABLE IF NOT EXISTS login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip_hash TEXT NOT NULL,
    attempted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_user ON farm_requests(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_inventory_user ON inventory(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_recommendations_status ON recommendations(status);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time ON login_attempts(ip_hash, attempted_at);
"""


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def database_connection(path):
    connection = sqlite3.connect(path, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = WAL")
    return connection


def create_app(database_path=None, secret_key=None):
    app = Flask(__name__)
    app.config.update(
        SECRET_KEY=secret_key or os.environ.get("AQUASUPPLY_SECRET_KEY") or secrets.token_hex(32),
        SETUP_TOKEN=os.environ.get("AQUASUPPLY_SETUP_TOKEN", ""),
        DATABASE=str(database_path or os.environ.get("AQUASUPPLY_DB") or BASE_DIR / "instance" / "aquasupply.sqlite3"),
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=os.environ.get("AQUASUPPLY_COOKIE_SECURE", "").lower() in {"1", "true", "yes"},
        PERMANENT_SESSION_LIFETIME=8 * 60 * 60,
        MAX_CONTENT_LENGTH=64 * 1024,
    )
    Path(app.config["DATABASE"]).parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(app.config["DATABASE"])
    try:
        connection.executescript(SCHEMA)
    finally:
        connection.close()

    @app.before_request
    def prepare_api_request():
        if not request.path.startswith("/api/"):
            return
        g.db = database_connection(app.config["DATABASE"])
        if "csrf_token" not in session:
            session["csrf_token"] = secrets.token_urlsafe(32)
        user_id = session.get("user_id")
        g.user = None
        if user_id is not None:
            row = g.db.execute(
                "SELECT id, name, email, role, status FROM users WHERE id = ?",
                (user_id,),
            ).fetchone()
            if row and row["status"] == "active":
                g.user = row
            else:
                session.clear()
                session["csrf_token"] = secrets.token_urlsafe(32)

    @app.teardown_request
    def close_api_connection(_error):
        connection = g.pop("db", None)
        if connection is not None:
            connection.close()

    @app.after_request
    def add_security_headers(response):
        if request.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
            response.headers["Vary"] = "Cookie"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; connect-src 'self'; object-src 'none'; "
            "base-uri 'self'; frame-ancestors 'none'"
        )
        if app.config["SESSION_COOKIE_SECURE"]:
            response.headers["Strict-Transport-Security"] = "max-age=31536000"
        return response

    @app.get("/")
    def index():
        return send_from_directory(BASE_DIR, "index.html")

    @app.get("/healthz")
    def health_check():
        connection = None
        try:
            connection = database_connection(app.config["DATABASE"])
            connection.execute("SELECT 1").fetchone()
            return jsonify(status="ok")
        except sqlite3.Error:
            app.logger.exception("Database health check failed")
            return jsonify(error="Service unavailable."), 503
        finally:
            if connection is not None:
                connection.close()

    @app.get("/styles.css")
    def stylesheet():
        return send_from_directory(BASE_DIR, "styles.css")

    @app.get("/app.js")
    def javascript():
        return send_from_directory(BASE_DIR, "app.js")

    @app.get("/api/session")
    def current_session():
        administrator_exists = g.db.execute(
            "SELECT 1 FROM users WHERE role = 'admin' LIMIT 1"
        ).fetchone() is not None
        return jsonify(
            user=public_user(g.user),
            csrfToken=session["csrf_token"],
            setupRequired=not administrator_exists,
            setupTokenRequired=bool(app.config["SETUP_TOKEN"]),
        )

    @app.post("/api/setup/administrator")
    @csrf_protected
    def setup_first_administrator():
        data = json_body()
        if data is None:
            return jsonify(error="A JSON request body is required."), 400
        name = clean_text(data.get("name"), 80)
        email = normalize_email(data.get("email"))
        password = data.get("password")
        if not name or not email or not EMAIL_PATTERN.fullmatch(email):
            return jsonify(error="Enter a valid name and email address."), 400
        if not valid_password(password):
            return jsonify(error="Use a password between 12 and 128 characters."), 400
        expected_setup_token = app.config["SETUP_TOKEN"]
        supplied_setup_token = data.get("setupToken")
        if expected_setup_token and (
            not isinstance(supplied_setup_token, str)
            or not hmac.compare_digest(expected_setup_token, supplied_setup_token)
        ):
            return jsonify(error="The first-administrator setup token is not valid."), 403

        try:
            g.db.execute("BEGIN IMMEDIATE")
            administrator_exists = g.db.execute(
                "SELECT 1 FROM users WHERE role = 'admin' LIMIT 1"
            ).fetchone() is not None
            if administrator_exists:
                g.db.rollback()
                return jsonify(error="An administrator already exists. Sign in using the administrator workspace."), 409
            cursor = g.db.execute(
                "INSERT INTO users (name, email, password_hash, role, status, created_at) "
                "VALUES (?, ?, ?, 'admin', 'active', ?)",
                (name, email, generate_password_hash(password), utc_now()),
            )
            administrator = g.db.execute(
                "SELECT id, name, email, role, status FROM users WHERE id = ?",
                (cursor.lastrowid,),
            ).fetchone()
            g.db.commit()
        except sqlite3.IntegrityError:
            g.db.rollback()
            return jsonify(error="An account with that email already exists."), 409
        except sqlite3.Error:
            g.db.rollback()
            app.logger.exception("Could not complete first administrator setup")
            return jsonify(error="Administrator setup failed. Please try again."), 500

        session.clear()
        session["user_id"] = administrator["id"]
        session["csrf_token"] = secrets.token_urlsafe(32)
        session.permanent = True
        return jsonify(user=public_user(administrator), csrfToken=session["csrf_token"]), 201

    @app.post("/api/login")
    @csrf_protected
    def login():
        data = json_body()
        if data is None:
            return jsonify(error="A JSON request body is required."), 400

        role = data.get("role")
        email = normalize_email(data.get("email"))
        password = data.get("password")
        if role not in ROLES or not email or not isinstance(password, str) or len(password) > 256:
            return jsonify(error="Email, password, or role is not valid."), 400

        ip_hash = hmac.new(
            app.config["SECRET_KEY"].encode(),
            (request.remote_addr or "unknown").encode(),
            "sha256",
        ).hexdigest()
        recent_attempts = g.db.execute(
            "SELECT COUNT(*) AS count FROM login_attempts "
            "WHERE ip_hash = ? AND datetime(attempted_at) >= datetime('now', '-15 minutes')",
            (ip_hash,),
        ).fetchone()["count"]
        if recent_attempts >= 10:
            return jsonify(error="Too many sign-in attempts. Try again in 15 minutes."), 429
        g.db.execute("INSERT INTO login_attempts (ip_hash, attempted_at) VALUES (?, ?)", (ip_hash, utc_now()))

        user = g.db.execute(
            "SELECT id, name, email, password_hash, role, status FROM users WHERE email = ?",
            (email,),
        ).fetchone()
        password_hash = user["password_hash"] if user else DUMMY_PASSWORD_HASH
        password_matches = check_password_hash(password_hash, password)
        if not user or not password_matches or user["role"] != role:
            g.db.commit()
            return jsonify(error="Email, password, or selected workspace is not valid."), 401
        if user["status"] != "active":
            g.db.commit()
            return jsonify(error="This account is awaiting management approval or has been declined."), 403

        g.db.execute("DELETE FROM login_attempts WHERE ip_hash = ?", (ip_hash,))
        g.db.commit()
        session.clear()
        session["user_id"] = user["id"]
        session["csrf_token"] = secrets.token_urlsafe(32)
        session.permanent = True
        return jsonify(user=public_user(user), csrfToken=session["csrf_token"])

    @app.post("/api/register")
    @csrf_protected
    def register():
        data = json_body()
        if data is None:
            return jsonify(error="A JSON request body is required."), 400
        role = data.get("role")
        name = clean_text(data.get("name"), 80)
        email = normalize_email(data.get("email"))
        password = data.get("password")
        if role not in SELF_REGISTER_ROLES:
            return jsonify(error="Only farmer and feed vendor accounts can self-register."), 400
        if not name or not email or not EMAIL_PATTERN.fullmatch(email):
            return jsonify(error="Enter a valid name and email address."), 400
        if not valid_password(password):
            return jsonify(error="Use a password between 12 and 128 characters."), 400
        try:
            g.db.execute(
                "INSERT INTO users (name, email, password_hash, role, status, created_at) "
                "VALUES (?, ?, ?, ?, 'pending', ?)",
                (name, email, generate_password_hash(password), role, utc_now()),
            )
            g.db.commit()
        except sqlite3.IntegrityError:
            return jsonify(error="An account with that email already exists."), 409
        return jsonify(message="Registration submitted. Management must approve your account before sign-in."), 201

    @app.post("/api/logout")
    @csrf_protected
    @login_required()
    def logout():
        session.clear()
        session["csrf_token"] = secrets.token_urlsafe(32)
        return jsonify(message="Signed out.", csrfToken=session["csrf_token"])

    @app.get("/api/data")
    @login_required()
    def get_data():
        user = g.user
        role = user["role"]
        if role == "farmer":
            requests = query_requests("WHERE r.user_id = ?", (user["id"],))
            inventory = query_inventory("WHERE i.status = 'approved'")
            recommendations = query_recommendations(
                "WHERE rec.status = 'published' AND r.user_id = ?", (user["id"],)
            )
        elif role == "vendor":
            requests = []
            inventory = query_inventory("WHERE i.user_id = ?", (user["id"],))
            recommendations = []
        elif role == "management":
            requests = query_requests("")
            inventory = query_inventory("")
            recommendations = []
        elif role == "analyst":
            requests = query_requests("WHERE r.status = 'approved'")
            inventory = query_inventory("WHERE i.status = 'approved'")
            recommendations = []
        else:
            requests = query_requests("")
            inventory = query_inventory("")
            recommendations = query_recommendations("WHERE rec.status = 'awaitingAdmin'")

        result = {
            "requests": requests,
            "inventory": inventory,
            "recommendations": recommendations,
            "pendingAccounts": [],
            "accounts": [],
        }
        if role == "management":
            result["pendingAccounts"] = query_users("WHERE status = 'pending'")
        if role == "admin":
            result["accounts"] = query_users("")
        return jsonify(result)

    @app.get("/api/accounts/pending")
    @login_required("management")
    def pending_accounts():
        return jsonify(accounts=query_users("WHERE status = 'pending'"))

    @app.patch("/api/accounts/<int:account_id>/status")
    @csrf_protected
    @login_required("management")
    def update_account_status(account_id):
        data = json_body()
        status = data.get("status") if data else None
        if status not in STATUS_VALUES:
            return jsonify(error="Choose approved or rejected."), 400
        cursor = g.db.execute(
            "UPDATE users SET status = ? WHERE id = ? AND role IN ('farmer', 'vendor') AND status = 'pending'",
            ("active" if status == "approved" else "rejected", account_id),
        )
        if not cursor.rowcount:
            return jsonify(error="Pending farmer or vendor account not found."), 404
        g.db.commit()
        return jsonify(message="Account status updated.")

    @app.post("/api/accounts")
    @csrf_protected
    @login_required("admin")
    def create_team_account():
        data = json_body()
        if data is None:
            return jsonify(error="A JSON request body is required."), 400
        name = clean_text(data.get("name"), 80)
        email = normalize_email(data.get("email"))
        password = data.get("password")
        role = data.get("role")
        if not name or not email or not EMAIL_PATTERN.fullmatch(email):
            return jsonify(error="Enter a valid name and email address."), 400
        if role not in TEAM_ROLES:
            return jsonify(error="Administrators can provision management or analysis team accounts here."), 400
        if not valid_password(password):
            return jsonify(error="Use a password between 12 and 128 characters."), 400
        try:
            g.db.execute(
                "INSERT INTO users (name, email, password_hash, role, status, created_at) "
                "VALUES (?, ?, ?, ?, 'active', ?)",
                (name, email, generate_password_hash(password), role, utc_now()),
            )
            g.db.commit()
        except sqlite3.IntegrityError:
            return jsonify(error="An account with that email already exists."), 409
        return jsonify(message=f"{role_title(role)} account created."), 201

    @app.post("/api/requests")
    @csrf_protected
    @login_required("farmer")
    def create_request():
        data = json_body()
        if data is None:
            return jsonify(error="A JSON request body is required."), 400
        name = clean_text(data.get("farm"), 80)
        fish = data.get("fish")
        water = data.get("water")
        culture = data.get("culture")
        preference = data.get("feedPreference")
        fish_count = positive_integer(data.get("fishCount"))
        feed_need = positive_number(data.get("feedNeedKg"))
        if not name or fish not in FISH_SPECIES or water not in WATER_TYPES or culture not in CULTURE_SYSTEMS:
            return jsonify(error="Complete the farm name, species, water type, and culture system."), 400
        if preference not in FEED_PREFERENCES or fish_count is None or feed_need is None:
            return jsonify(error="Enter a valid fish count, feed quantity, and feed preference."), 400
        request_id = secrets.token_urlsafe(18)
        g.db.execute(
            "INSERT INTO farm_requests "
            "(id, user_id, farm, fish, water, culture, fish_count, feed_need_kg, feed_preference, notes, status, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting', ?)",
            (
                request_id,
                g.user["id"],
                name,
                fish,
                water,
                culture,
                fish_count,
                feed_need,
                preference,
                clean_text(data.get("notes"), 400) or "",
                utc_now(),
            ),
        )
        g.db.commit()
        return jsonify(message="Farm request submitted for management review.", id=request_id), 201

    @app.patch("/api/requests/<request_id>/status")
    @csrf_protected
    @login_required("management")
    def update_request_status(request_id):
        data = json_body()
        status = data.get("status") if data else None
        if status not in STATUS_VALUES:
            return jsonify(error="Choose approved or rejected."), 400
        cursor = g.db.execute(
            "UPDATE farm_requests SET status = ? WHERE id = ? AND status = 'awaiting'",
            (status, request_id),
        )
        if not cursor.rowcount:
            return jsonify(error="Pending farm request not found."), 404
        g.db.commit()
        return jsonify(message="Farm request status updated.")

    @app.post("/api/inventory")
    @csrf_protected
    @login_required("vendor")
    def create_inventory():
        data = json_body()
        if data is None:
            return jsonify(error="A JSON request body is required."), 400
        name = clean_text(data.get("name"), 80)
        vendor_name = clean_text(data.get("vendor"), 80)
        category = data.get("category")
        species = data.get("species")
        water = data.get("water")
        source = clean_text(data.get("source"), 140)
        quantity = positive_number(data.get("quantityKg"))
        price = nonnegative_number(data.get("pricePerKg"))
        if (
            not name or not vendor_name or not source or category not in FEED_CATEGORIES
            or species not in (FISH_SPECIES - {"Other"}) | {"All species"}
            or water not in WATER_TYPES or quantity is None or price is None
        ):
            return jsonify(error="Complete the feed details with valid stock and price values."), 400
        item_id = secrets.token_urlsafe(18)
        g.db.execute(
            "INSERT INTO inventory "
            "(id, user_id, name, category, species_json, waters_json, source, quantity_kg, price_per_kg, vendor, status, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting', ?)",
            (
                item_id,
                g.user["id"],
                name,
                category,
                json.dumps([species]),
                json.dumps([water]),
                source,
                quantity,
                price,
                vendor_name,
                utc_now(),
            ),
        )
        g.db.commit()
        return jsonify(message="Feed stock submitted for management review.", id=item_id), 201

    @app.patch("/api/inventory/<item_id>/status")
    @csrf_protected
    @login_required("management")
    def update_inventory_status(item_id):
        data = json_body()
        status = data.get("status") if data else None
        if status not in STATUS_VALUES:
            return jsonify(error="Choose approved or rejected."), 400
        cursor = g.db.execute(
            "UPDATE inventory SET status = ? WHERE id = ? AND status = 'awaiting'",
            (status, item_id),
        )
        if not cursor.rowcount:
            return jsonify(error="Pending supplier stock not found."), 404
        g.db.commit()
        return jsonify(message="Supplier stock status updated.")

    @app.post("/api/recommendations")
    @csrf_protected
    @login_required("analyst")
    def create_recommendation():
        data = json_body()
        request_id = data.get("requestId") if data else None
        farm_request = g.db.execute(
            "SELECT * FROM farm_requests WHERE id = ? AND status = 'approved'",
            (request_id,),
        ).fetchone()
        if not farm_request:
            return jsonify(error="Approved farm request not found."), 404
        already_exists = g.db.execute(
            "SELECT 1 FROM recommendations WHERE request_id = ? AND status != 'declined'",
            (request_id,),
        ).fetchone()
        if already_exists:
            return jsonify(error="A recommendation is already awaiting review or published for this request."), 409
        candidates = g.db.execute("SELECT * FROM inventory WHERE status = 'approved'").fetchall()
        if not candidates:
            return jsonify(error="No approved supplier stock is available for matching."), 409
        matches = [score_match(farm_request, candidate) for candidate in candidates]
        best = sorted(matches, key=lambda match: (-match["score"], match["feed"]["name"].casefold()))[0]
        recommendation_id = secrets.token_urlsafe(18)
        g.db.execute(
            "INSERT INTO recommendations "
            "(id, request_id, feed_id, score, reasons_json, status, created_at) "
            "VALUES (?, ?, ?, ?, ?, 'awaitingAdmin', ?)",
            (
                recommendation_id,
                request_id,
                best["feed"]["id"],
                best["score"],
                json.dumps(best["reasons"]),
                utc_now(),
            ),
        )
        g.db.commit()
        return jsonify(message="Recommendation prepared for administrator review.", id=recommendation_id), 201

    @app.patch("/api/recommendations/<recommendation_id>/status")
    @csrf_protected
    @login_required("admin")
    def update_recommendation_status(recommendation_id):
        data = json_body()
        status = data.get("status") if data else None
        if status not in {"published", "declined"}:
            return jsonify(error="Choose published or declined."), 400
        published_at = utc_now() if status == "published" else None
        cursor = g.db.execute(
            "UPDATE recommendations SET status = ?, published_at = ? "
            "WHERE id = ? AND status = 'awaitingAdmin'",
            (status, published_at, recommendation_id),
        )
        if not cursor.rowcount:
            return jsonify(error="Recommendation awaiting review not found."), 404
        g.db.commit()
        return jsonify(message="Recommendation status updated.")

    return app


def csrf_protected(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        expected = session.get("csrf_token")
        supplied = request.headers.get("X-CSRF-Token", "")
        if not expected or not supplied or not hmac.compare_digest(expected, supplied):
            return jsonify(error="Your session token is missing or expired. Refresh and try again."), 400
        return view(*args, **kwargs)

    return wrapped


def login_required(*roles):
    def decorator(view):
        @wraps(view)
        def wrapped(*args, **kwargs):
            if getattr(g, "user", None) is None:
                return jsonify(error="Sign in to continue."), 401
            if roles and g.user["role"] not in roles:
                return jsonify(error="Your account does not have permission for this action."), 403
            return view(*args, **kwargs)

        return wrapped

    return decorator


def json_body():
    value = request.get_json(silent=True)
    return value if isinstance(value, dict) else None


def public_user(user):
    if user is None:
        return None
    return {
        "id": user["id"],
        "name": user["name"],
        "email": user["email"],
        "role": user["role"],
        "status": user["status"],
    }


def role_title(role):
    return {
        "farmer": "Farmer / client",
        "vendor": "Feed vendor",
        "management": "Management",
        "analyst": "Analysis team",
        "admin": "Administrator",
    }.get(role, "Account")


def normalize_email(value):
    return value.strip().casefold() if isinstance(value, str) else ""


def clean_text(value, max_length):
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value or len(value) > max_length:
        return None
    return value


def valid_password(value):
    return isinstance(value, str) and 12 <= len(value) <= 128


def positive_integer(value):
    if isinstance(value, bool):
        return None
    try:
        numeric_value = float(value)
    except (TypeError, ValueError):
        return None
    if not numeric_value.is_integer() or not 0 < numeric_value <= 2_147_483_647:
        return None
    return int(numeric_value)


def positive_number(value):
    number = finite_number(value)
    return number if number is not None and 0 < number <= 100_000_000 else None


def nonnegative_number(value):
    number = finite_number(value)
    return number if number is not None and 0 <= number <= 100_000_000 else None


def finite_number(value):
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number and abs(number) != float("inf") else None


def row_date(value):
    return value[:10] if value else None


def query_users(where, params=()):
    rows = g.db.execute(
        f"SELECT id, name, email, role, status, created_at FROM users {where} ORDER BY created_at DESC",
        params,
    ).fetchall()
    return [
        {
            "id": row["id"],
            "name": row["name"],
            "email": row["email"],
            "role": row["role"],
            "status": row["status"],
            "createdAt": row_date(row["created_at"]),
        }
        for row in rows
    ]


def query_requests(where, params=()):
    rows = g.db.execute(
        "SELECT r.*, u.name AS owner_name FROM farm_requests r "
        "JOIN users u ON u.id = r.user_id "
        f"{where} ORDER BY r.created_at DESC",
        params,
    ).fetchall()
    return [
        {
            "id": row["id"],
            "farm": row["farm"],
            "fish": row["fish"],
            "water": row["water"],
            "culture": row["culture"],
            "fishCount": row["fish_count"],
            "feedNeedKg": row["feed_need_kg"],
            "feedPreference": row["feed_preference"],
            "notes": row["notes"],
            "owner": row["owner_name"],
            "status": row["status"],
            "createdAt": row_date(row["created_at"]),
        }
        for row in rows
    ]


def query_inventory(where, params=()):
    rows = g.db.execute(
        "SELECT i.*, u.name AS account_name FROM inventory i "
        "JOIN users u ON u.id = i.user_id "
        f"{where} ORDER BY i.created_at DESC",
        params,
    ).fetchall()
    return [serialize_inventory(row) for row in rows]


def serialize_inventory(row):
    return {
        "id": row["id"],
        "name": row["name"],
        "category": row["category"],
        "species": json.loads(row["species_json"]),
        "waters": json.loads(row["waters_json"]),
        "source": row["source"],
        "quantityKg": row["quantity_kg"],
        "pricePerKg": row["price_per_kg"],
        "vendor": row["vendor"],
        "owner": row["account_name"],
        "status": row["status"],
        "createdAt": row_date(row["created_at"]),
    }


def query_recommendations(where, params=()):
    rows = g.db.execute(
        "SELECT rec.*, "
        "r.id AS r_id, r.farm AS r_farm, r.fish AS r_fish, r.water AS r_water, "
        "r.culture AS r_culture, r.feed_need_kg AS r_feed_need_kg, r.user_id AS r_user_id, "
        "u.name AS r_owner, "
        "i.id AS i_id, i.name AS i_name, i.category AS i_category, i.species_json AS i_species, "
        "i.waters_json AS i_waters, i.source AS i_source, i.quantity_kg AS i_quantity_kg, "
        "i.price_per_kg AS i_price_per_kg, i.vendor AS i_vendor, i.status AS i_status, "
        "i.created_at AS i_created_at, vendor_user.name AS i_owner "
        "FROM recommendations rec "
        "JOIN farm_requests r ON r.id = rec.request_id "
        "JOIN users u ON u.id = r.user_id "
        "JOIN inventory i ON i.id = rec.feed_id "
        "JOIN users vendor_user ON vendor_user.id = i.user_id "
        f"{where} ORDER BY rec.created_at DESC",
        params,
    ).fetchall()
    recommendations = []
    for row in rows:
        recommendations.append(
            {
                "id": row["id"],
                "requestId": row["request_id"],
                "feedId": row["feed_id"],
                "score": row["score"],
                "reasons": json.loads(row["reasons_json"]),
                "status": row["status"],
                "createdAt": row_date(row["created_at"]),
                "publishedAt": row_date(row["published_at"]),
                "request": {
                    "id": row["r_id"],
                    "farm": row["r_farm"],
                    "fish": row["r_fish"],
                    "water": row["r_water"],
                    "culture": row["r_culture"],
                    "feedNeedKg": row["r_feed_need_kg"],
                    "owner": row["r_owner"],
                },
                "feed": {
                    "id": row["i_id"],
                    "name": row["i_name"],
                    "category": row["i_category"],
                    "species": json.loads(row["i_species"]),
                    "waters": json.loads(row["i_waters"]),
                    "source": row["i_source"],
                    "quantityKg": row["i_quantity_kg"],
                    "pricePerKg": row["i_price_per_kg"],
                    "vendor": row["i_vendor"],
                    "owner": row["i_owner"],
                    "status": row["i_status"],
                    "createdAt": row_date(row["i_created_at"]),
                },
            }
        )
    return recommendations


def score_match(farm_request, feed):
    species = json.loads(feed["species_json"])
    waters = json.loads(feed["waters_json"])
    score = 0
    reasons = []
    if farm_request["fish"] in species:
        score += 45
        reasons.append(f"Species listed for {farm_request['fish']} (+45)")
    elif "All species" in species:
        score += 25
        reasons.append("Supplier lists broad species compatibility (+25)")
    else:
        reasons.append("Species not listed by supplier (+0)")
    if farm_request["water"] in waters:
        score += 25
        reasons.append(f"{farm_request['water']} water type listed (+25)")
    else:
        reasons.append(f"{farm_request['water']} water type not listed (+0)")
    if farm_request["feed_preference"] == "Any suitable feed" or farm_request["feed_preference"] == feed["category"]:
        score += 20
        reasons.append(f"{feed['category']} feed matches preference (+20)")
    else:
        reasons.append(f"{feed['category']} feed differs from preference (+0)")
    if feed["quantity_kg"] >= farm_request["feed_need_kg"]:
        score += 10
        reasons.append("Listed stock meets requested quantity (+10)")
    else:
        reasons.append(f"Only {feed['quantity_kg']:g} kg listed; less than requested (+0)")
    return {"feed": dict(feed), "score": score, "reasons": reasons}


def create_admin_account(email, name, password, database_path):
    if not EMAIL_PATTERN.fullmatch(normalize_email(email)):
        raise ValueError("Enter a valid email address.")
    if not clean_text(name, 80):
        raise ValueError("Enter a name of at most 80 characters.")
    if not valid_password(password):
        raise ValueError("Use a password between 12 and 128 characters.")
    connection = database_connection(database_path)
    try:
        connection.execute(
            "INSERT INTO users (name, email, password_hash, role, status, created_at) "
            "VALUES (?, ?, ?, 'admin', 'active', ?)",
            (name.strip(), normalize_email(email), generate_password_hash(password), utc_now()),
        )
        connection.commit()
    except sqlite3.IntegrityError as error:
        raise ValueError("An account with that email already exists.") from error
    finally:
        connection.close()


def run_cli():
    parser = argparse.ArgumentParser(description="Run AquaSupply or create its first administrator.")
    parser.add_argument("command", nargs="?", choices=["serve", "create-admin"], default="serve")
    parser.add_argument("--email", help="Administrator email for create-admin")
    parser.add_argument("--name", help="Administrator name for create-admin")
    args = parser.parse_args()

    database_path = app.config["DATABASE"]
    if args.command == "create-admin":
        email = args.email or input("Administrator email: ").strip()
        name = args.name or input("Administrator name: ").strip()
        import getpass

        password = getpass.getpass("Administrator password (12+ characters): ")
        repeated = getpass.getpass("Repeat password: ")
        if password != repeated:
            print("Passwords do not match.", file=sys.stderr)
            return 1
        try:
            create_admin_account(email, name, password, database_path)
        except ValueError as error:
            print(str(error), file=sys.stderr)
            return 1
        print(f"Administrator account created for {normalize_email(email)}.")
        return 0

    if not os.environ.get("AQUASUPPLY_SECRET_KEY"):
        print(
            "Warning: AQUASUPPLY_SECRET_KEY is not set; sign-in sessions will expire when the server restarts.",
            file=sys.stderr,
        )
    app.run(host=os.environ.get("AQUASUPPLY_HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "5000")), debug=False)
    return 0


app = create_app()


if __name__ == "__main__":
    raise SystemExit(run_cli())

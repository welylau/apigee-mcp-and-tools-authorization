import os
import re
import random
import logging
from collections import Counter
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import List, Literal, Optional
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Query, Header, Path, Request
from fastapi.exceptions import RequestValidationError
from fastapi.encoders import jsonable_encoder
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from google.api_core import exceptions as gcp_exceptions
from pydantic import BaseModel, ConfigDict, Field
from google.cloud import firestore

from auth import Principal, current_principal

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("coffee-shop-backend")

PROJECT_ID = os.getenv("GOOGLE_CLOUD_PROJECT", os.getenv("GCP_PROJECT", "YOUR_GCP_PROJECT_ID"))
DATABASE_ID = os.getenv("FIRESTORE_DATABASE", "(default)")
ORDERS_COLLECTION = os.getenv("ORDERS_COLLECTION", "coffee_orders")

# --- Human-in-the-loop order approval ---------------------------------------
# The API gateway marks an order that needs a person to approve it by sending
# X-Order-Status: PENDING_APPROVAL. Only values in this set are accepted from
# the header; anything else is ignored and the order is saved as IN_PROGRESS.
STATUS_IN_PROGRESS = "IN_PROGRESS"
STATUS_PENDING_APPROVAL = "PENDING_APPROVAL"
STATUS_REJECTED = "REJECTED"
ACCEPTED_INITIAL_STATUSES = {STATUS_PENDING_APPROVAL}

# --- Caller identity and authorisation --------------------------------------
# Cloud Run IAM decides who may reach this service (the Apigee service account
# plus named operators). That is not a user identity, so every non-public
# route also requires the user's Keycloak access token, which the
# Biscuit-Coffee-Shop proxy forwards in X-User-Token. auth.py verifies it
# (RS256 + JWKS, issuer, audience, expiry) and it is the ONLY source of the
# caller's email, name and scopes; X-User-Email / X-User-Name / X-User-Scope
# headers are ignored. The gateway also checks scopes per operation; the
# checks here apply the same rules to the verified token.
STATUS_READY = "READY"
STATUS_COMPLETED = "COMPLETED"
STATUS_CANCELLED = "CANCELLED"
OrderStatus = Literal["PENDING_APPROVAL", "REJECTED", "IN_PROGRESS", "READY", "COMPLETED", "CANCELLED"]
# Orders in these states change only through decideOrder.
DECISION_ONLY_STATUSES = {STATUS_PENDING_APPROVAL, STATUS_REJECTED}
# Staff progress updates (updateOrderStatus). Anything not listed -> 409.
ALLOWED_TRANSITIONS = {
    STATUS_IN_PROGRESS: {STATUS_READY, STATUS_CANCELLED},
    STATUS_READY: {STATUS_COMPLETED, STATUS_CANCELLED},
}
ID_PATTERN = r"^[A-Za-z0-9_-]{1,64}$"
EMAIL_PATTERN = r"^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,}$"
NAME_PATTERN = r"^[^\x00-\x1f\x7f<>{}\[\]`]{1,80}$"
PHONE_PATTERN = r"^[0-9+()\- ]{3,20}$"
# Filters a manager may use on GET /orders (same allow-list as the gateway).
ORDER_FILTER_KEYS = {"email", "name", "loyalty_id", "status"}
ORDER_ID_ATTEMPTS = 5


def _env_cents(name: str, default: str) -> int:
    """Dollar amount from env (e.g. "50.00") as integer cents."""
    raw = os.getenv(name) or default
    try:
        cents = int((Decimal(raw.strip()) * 100).to_integral_value(rounding=ROUND_HALF_UP))
    except (InvalidOperation, ValueError):
        logger.warning(f"Bad {name}={raw!r}; using {default}")
        cents = int(Decimal(default) * 100)
    return cents


def _money_display(cents: int) -> str:
    """"100" for whole dollars, "99.50" otherwise (as the gateway's checkOrderValue.js)."""
    return str(cents // 100) if cents % 100 == 0 else f"{cents / 100:.2f}"


# Order value rules, same as the gateway (JS-CheckOrderValue): a customer
# order at or above ORDER_CAP is refused (422 order_limit_exceeded), and one
# at or above APPROVAL_THRESHOLD waits for staff approval. Applied here too so
# a caller that reaches the backend without the gateway's checks (or without
# X-Order-Status) cannot skip them.
APPROVAL_THRESHOLD_CENTS = _env_cents("APPROVAL_THRESHOLD", "50.00")
ORDER_CAP_CENTS = _env_cents("ORDER_CAP", "100.00")
DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")

db: Optional[firestore.Client] = None

# Initial Seed Data
SEED_MENU = [
    {"id": "item-1-s", "name": "Latte", "size": "small", "price": 3.25},
    {"id": "item-1-m", "name": "Latte", "size": "medium", "price": 3.75},
    {"id": "item-1-l", "name": "Latte", "size": "large", "price": 4.25},
    {"id": "item-2-s", "name": "Americano", "size": "small", "price": 3.00},
    {"id": "item-2-m", "name": "Americano", "size": "medium", "price": 3.50},
    {"id": "item-2-l", "name": "Americano", "size": "large", "price": 3.75},
    {"id": "item-3-s", "name": "Cappuccino", "size": "small", "price": 3.50},
    {"id": "item-3-m", "name": "Cappuccino", "size": "medium", "price": 4.00},
    {"id": "item-3-l", "name": "Cappuccino", "size": "large", "price": 4.50},
    {"id": "item-4-s", "name": "Caramel Macchiato", "size": "small", "price": 4.75},
    {"id": "item-4-m", "name": "Caramel Macchiato", "size": "medium", "price": 5.00},
    {"id": "item-4-l", "name": "Caramel Macchiato", "size": "large", "price": 5.25},
    {"id": "item-5-s", "name": "Cold Brew", "size": "small", "price": 4.00},
    {"id": "item-5-m", "name": "Cold Brew", "size": "medium", "price": 4.50},
    {"id": "item-5-l", "name": "Cold Brew", "size": "large", "price": 5.00},
    {"id": "item-6-s", "name": "Mocha", "size": "small", "price": 4.25},
    {"id": "item-6-m", "name": "Mocha", "size": "medium", "price": 4.65},
    {"id": "item-6-l", "name": "Mocha", "size": "large", "price": 4.95},
    {"id": "item-7-s", "name": "Flat White", "size": "small", "price": 4.00},
    {"id": "item-7-m", "name": "Flat White", "size": "medium", "price": 4.50},
    {"id": "item-7-l", "name": "Flat White", "size": "large", "price": 4.75},
    {"id": "item-8-s", "name": "Cortado", "size": "small", "price": 3.25},
    {"id": "item-8-m", "name": "Cortado", "size": "medium", "price": 3.50},
    {"id": "item-8-l", "name": "Cortado", "size": "large", "price": 3.75},
    {"id": "item-9-s", "name": "Chai Latte", "size": "small", "price": 3.75},
    {"id": "item-9-m", "name": "Chai Latte", "size": "medium", "price": 4.25},
    {"id": "item-9-l", "name": "Chai Latte", "size": "large", "price": 4.75},
    {"id": "item-10-single", "name": "Espresso", "size": "single", "price": 2.50},
    {"id": "item-10-double", "name": "Espresso", "size": "double", "price": 3.25}
]

SEED_EMPLOYEES = [
    {"id": "emp-101", "name": "Jordan Smith", "phone": "555-010-2345", "email": "jordan.smith@gmail.com"},
    {"id": "emp-102", "name": "Casey Montgomery", "phone": "555-012-9876", "email": "casey.m@gmail.com"},
    {"id": "emp-103", "name": "Alex Rivera", "phone": "555-015-4433", "email": "arivera@hotmail.com"},
    {"id": "emp-104", "name": "Taylor Chen", "phone": "555-018-7766", "email": "tchen.design@gmail.com"},
    {"id": "emp-105", "name": "Morgan Pierce", "phone": "555-019-1122", "email": "mpierce@yahoo.com"},
    {"id": "emp-106", "name": "Riley Vance", "phone": "555-020-5588", "email": "rvance@sky.com"},
    {"id": "emp-107", "name": "Jamie Thorne", "phone": "555-021-3344", "email": "j.thorne@gmail.com"},
    {"id": "emp-108", "name": "Skyler Brooks", "phone": "555-022-6677", "email": "sbrooks@hotmail.com"}
]

SEED_HOURS = [
    {"day": "Monday", "open": "07:00", "close": "19:00", "hours": "7:00 AM - 7:00 PM"},
    {"day": "Tuesday", "open": "07:00", "close": "19:00", "hours": "7:00 AM - 7:00 PM"},
    {"day": "Wednesday", "open": "07:00", "close": "19:00", "hours": "7:00 AM - 7:00 PM"},
    {"day": "Thursday", "open": "07:00", "close": "19:00", "hours": "7:00 AM - 7:00 PM"},
    {"day": "Friday", "open": "07:00", "close": "21:00", "hours": "7:00 AM - 9:00 PM"},
    {"day": "Saturday", "open": "08:00", "close": "21:00", "hours": "8:00 AM - 9:00 PM"},
    {"day": "Sunday", "open": "08:00", "close": "18:00", "hours": "8:00 AM - 6:00 PM"}
]

SEED_ORDERS = [
    {
        "order_id": "67449",
        "email": "customer@biscuit-coffee.com",
        "name": "John Smith",
        "loyalty_id": "L-83983",
        "items": [{"item_id": "item-1-s", "quantity": 1}],
        "status": "IN_PROGRESS",
        "eta_minutes": 9,
        "total_amount": 3.25
    },
    {
        "order_id": "10001",
        "email": "customer@example.com",
        "name": "David",
        "loyalty_id": "L-12345",
        "items": [{"item_id": "item-1-s", "quantity": 2}],
        "status": "COMPLETE",
        "total_amount": 6.50
    },
    {
        "order_id": "10002",
        "email": "customer@example.com",
        "name": "David",
        "loyalty_id": "L-12345",
        "items": [
            {"item_id": "item-2-s", "quantity": 1},
            {"item_id": "item-3-m", "quantity": 2}
        ],
        "status": "IN_PROGRESS",
        "eta_minutes": 7,
        "total_amount": 11.00
    }
]

SEED_LOYALTY = [
    {
        "loyalty_id": "L-83983",
        "email": "customer@biscuit-coffee.com",
        "name": "John Smith",
        "phone": "555-019-8833",
        "points": 180
    },
    {
        "loyalty_id": "L-12345",
        "email": "customer@example.com",
        "name": "David",
        "phone": "555-010-9999",
        "points": 250
    }
]

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_iso(value) -> Optional[datetime]:
    try:
        dt = datetime.fromisoformat(str(value))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def require_staff(principal: Principal) -> None:
    """Staff order operations: biscuit_coffee_staff or biscuit_coffee_manager."""
    if not principal.is_staff:
        raise HTTPException(status_code=403, detail={"message": "Staff access required"})


def require_manager(principal: Principal) -> None:
    """Employee, store and stats operations: biscuit_coffee_manager only."""
    if not principal.is_manager:
        raise HTTPException(status_code=403, detail={"message": "Store manager access required"})


def _caller_email(principal: Principal) -> str:
    """Verified email of the caller (from the token), or 403."""
    if not principal.email:
        raise HTTPException(status_code=403, detail={"message": "Caller identity missing"})
    return principal.email


def _order_not_found(order_id: str) -> HTTPException:
    return HTTPException(status_code=404, detail={"message": f"Order {order_id} not found"})


def _can_see_order(principal: Principal, order: dict) -> bool:
    """Staff and managers see every order; anyone else only their own (by verified email)."""
    if principal.is_staff:
        return True
    owner = str(order.get("email") or "").strip().lower()
    return bool(principal.email) and owner == principal.email


def decide_order(order_id: str, approved: bool, decided_by: str, channel: str,
                 reason: Optional[str] = None, expected_status: Optional[str] = None) -> dict:
    """Record an approve/reject decision for an order that is waiting for approval.

    Called by decideOrder (staff app). A Firestore transaction makes sure only
    the first decision for an order counts; any later decision gets 409.
    """
    client = get_firestore_client()
    doc_ref = client.collection(ORDERS_COLLECTION).document(order_id)
    decision = "APPROVED" if approved else "REJECTED"

    @firestore.transactional
    def _apply(txn):
        snap = doc_ref.get(transaction=txn)
        if not snap.exists:
            raise HTTPException(status_code=404, detail={"message": f"Order {order_id} not found"})
        data = snap.to_dict() or {}
        current = data.get("status")
        if expected_status and current != expected_status:
            raise HTTPException(
                status_code=409,
                detail={"message": f"Order {order_id} changed: it is now {current}, not {expected_status}"},
            )
        if current != STATUS_PENDING_APPROVAL:
            raise HTTPException(
                status_code=409,
                detail={"message": f"Order {order_id} is not waiting for approval (status {current})"},
            )
        now = _now_iso()
        new_status = STATUS_IN_PROGRESS if approved else STATUS_REJECTED
        approval = {"decision": decision, "decided_by": decided_by, "channel": channel, "decided_at": now}
        if reason:
            approval["reason"] = reason
        history = list(data.get("status_history") or [])
        history.append({"status": new_status, "by": approval["decided_by"], "at": now})
        update = {"status": new_status, "approval": approval, "status_history": history}
        txn.update(doc_ref, update)
        return update

    update = _apply(client.transaction())
    approval = update["approval"]
    logger.info(f"Order {order_id} {approval['decision']} via {approval['channel']}")
    return {
        "order_id": order_id,
        "status": update["status"],
        "decision": approval["decision"],
        "decided_by": approval["decided_by"],
        "channel": approval["channel"],
    }


def get_firestore_client() -> firestore.Client:
    global db
    if db is None:
        logger.info(f"Connecting to Firestore: project={PROJECT_ID}, database={DATABASE_ID}")
        db = firestore.Client(project=PROJECT_ID, database=DATABASE_ID)
    return db

def init_database():
    try:
        client = get_firestore_client()
        logger.info("Verifying and seeding Firestore collections if empty...")

        # 1. Menu
        menu_ref = client.collection("menu")
        if len(list(menu_ref.limit(1).stream())) == 0:
            logger.info(f"Seeding {len(SEED_MENU)} menu items...")
            batch = client.batch()
            for item in SEED_MENU:
                doc_ref = menu_ref.document(item["id"])
                batch.set(doc_ref, item)
            batch.commit()

        # 2. Employees
        emp_ref = client.collection("employees")
        if len(list(emp_ref.limit(1).stream())) == 0:
            logger.info(f"Seeding {len(SEED_EMPLOYEES)} employees...")
            batch = client.batch()
            for emp in SEED_EMPLOYEES:
                doc_ref = emp_ref.document(emp["id"])
                batch.set(doc_ref, emp)
            batch.commit()

        # 3. Store Info
        store_ref = client.collection("store_info")
        loc_doc = store_ref.document("location").get()
        if not loc_doc.exists:
            logger.info("Seeding store location...")
            store_ref.document("location").set({"address": "123 Biscuit Lane, Coffee Town, CT 06001"})
        hours_doc = store_ref.document("hours").get()
        if not hours_doc.exists:
            logger.info("Seeding store hours...")
            store_ref.document("hours").set({"days": SEED_HOURS})

        # 4. Loyalty Accounts
        loyalty_ref = client.collection("loyalty_accounts")
        for acc in SEED_LOYALTY:
            doc_ref = loyalty_ref.document(acc["email"])
            if not doc_ref.get().exists:
                doc_ref.set(acc)

        # 5. Orders
        orders_ref = client.collection(ORDERS_COLLECTION)
        if len(list(orders_ref.limit(1).stream())) == 0:
            logger.info(f"Seeding sample coffee orders into {ORDERS_COLLECTION}...")
            batch = client.batch()
            for order in SEED_ORDERS:
                doc_ref = orders_ref.document(order["order_id"])
                batch.set(doc_ref, order)
            batch.commit()

        logger.info("Firestore initialization and seeding check completed.")
    except Exception as e:
        logger.error(f"Error during Firestore initialization: {e}", exc_info=True)

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_database()
    yield

app = FastAPI(title="Biscuit Coffee Shop Backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Customer requests (placeOrder, signUpLoyalty) reach this service through the
# agent, so a bad body gets 400 with a sentence the agent can relay
# ("quantity: Input should be less than or equal to 50") instead of FastAPI's
# 422 dump. Other routes keep the standard 422.
CUSTOMER_BODY_ROUTES = {("POST", "/orders"), ("POST", "/loyalty/signup")}


@app.exception_handler(RequestValidationError)
async def _validation_error(request: Request, exc: RequestValidationError):
    if (request.method, request.url.path) not in CUSTOMER_BODY_ROUTES:
        return await request_validation_exception_handler(request, exc)
    problems = []
    for err in exc.errors()[:5]:
        where = ".".join(str(p) for p in err.get("loc", ()) if p != "body") or "request"
        problems.append(f"{where}: {err.get('msg', 'invalid value')}")
    return JSONResponse(
        status_code=400,
        content=jsonable_encoder({"detail": {"message": "Invalid request - " + "; ".join(problems)}}),
    )

# Models
class OrderItem(BaseModel):
    item_id: str = Field(..., pattern=ID_PATTERN)
    quantity: int = Field(..., ge=1, le=50)

class PlaceOrderRequest(BaseModel):
    items: List[OrderItem] = Field(..., min_length=1, max_length=20)
    # Accepted for older clients but IGNORED: the order's email and name always
    # come from the verified token (a caller cannot order as someone else).
    email: Optional[str] = Field(None, max_length=254)
    name: Optional[str] = Field(None, max_length=80)

class SignUpLoyaltyRequest(BaseModel):
    # email is optional: customers are always enrolled under their verified
    # token email; only a store manager may enrol another address.
    email: Optional[str] = Field(None, max_length=254, pattern=EMAIL_PATTERN)
    name: Optional[str] = Field(None, max_length=80, pattern=NAME_PATTERN)
    phone: Optional[str] = Field(None, pattern=PHONE_PATTERN)

@app.get("/health")
def health():
    return {"status": "ok", "project": PROJECT_ID, "database": DATABASE_ID}

@app.get("/")
def root():
    return {"name": "Biscuit Coffee Shop API", "status": "running"}

@app.get("/location")
def get_location():
    client = get_firestore_client()
    doc = client.collection("store_info").document("location").get()
    if doc.exists:
        return doc.to_dict()
    return {"address": "123 Biscuit Lane, Coffee Town, CT 06001"}

@app.get("/hours")
def get_hours():
    client = get_firestore_client()
    doc = client.collection("store_info").document("hours").get()
    if doc.exists:
        data = doc.to_dict()
        return data.get("days", SEED_HOURS)
    return SEED_HOURS

@app.get("/menu")
def get_menu():
    client = get_firestore_client()
    items = []
    for doc in client.collection("menu").stream():
        item = doc.to_dict()
        # available=false means sold out (set by a manager via updateMenuItem).
        item["available"] = item.get("available", True) is not False
        items.append(item)
    if not items:
        return [{**item, "available": True} for item in SEED_MENU]
    return items

@app.get("/employees")
def list_employees(principal: Principal = Depends(current_principal)):
    require_manager(principal)
    client = get_firestore_client()
    employees = []
    for doc in client.collection("employees").stream():
        employees.append(doc.to_dict())
    if not employees:
        return SEED_EMPLOYEES
    return sorted(employees, key=lambda x: x.get("id", ""))

@app.get("/orders")
def list_orders(
    filter: Optional[str] = Query(None, max_length=250, description="Format 'key:value' e.g. email:customer@example.com"),
    email: Optional[str] = Query(None, max_length=254),
    name: Optional[str] = Query(None, max_length=80),
    loyalty_id: Optional[str] = Query(None, max_length=40),
    principal: Principal = Depends(current_principal),
):
    """Managers may filter across customers; everyone else sees only their own orders."""
    client = get_firestore_client()
    orders_ref = client.collection(ORDERS_COLLECTION)

    filter_key = None
    filter_val = None
    if principal.is_manager:
        if filter and ":" in filter:
            parts = filter.split(":", 1)
            filter_key = parts[0].strip()
            filter_val = parts[1].strip()
            if filter_key not in ORDER_FILTER_KEYS:
                raise HTTPException(status_code=400, detail={
                    "message": "Unsupported filter key. Supported keys: email, name, loyalty_id, status."})
        elif email:
            filter_key, filter_val = "email", email.strip()
        elif name:
            filter_key, filter_val = "name", name.strip()
        elif loyalty_id:
            filter_key, filter_val = "loyalty_id", loyalty_id.strip()
    else:
        # Any caller-supplied filter is ignored: the list is pinned to the
        # verified email (the gateway pins it too, see AM-PinOrderFilter).
        filter_key, filter_val = "email", _caller_email(principal)

    orders = []
    if filter_key and filter_val:
        query = orders_ref.where(filter_key, "==", filter_val)
        for doc in query.stream():
            orders.append(doc.to_dict())
    else:
        for doc in orders_ref.stream():
            orders.append(doc.to_dict())

    # Fallback to seed if empty
    if not orders and not filter_key:
        return SEED_ORDERS
    return orders


def _price_list(client) -> dict:
    """item id -> menu entry (Firestore menu, or the seed menu if it is empty)."""
    items = {}
    for doc in client.collection("menu").stream():
        data = doc.to_dict() or {}
        if data.get("id"):
            items[data["id"]] = data
    return items or {item["id"]: item for item in SEED_MENU}


def _new_order_id(client, order_data: dict) -> str:
    """Write the order under a fresh 5-digit id; never overwrite an existing order.

    create() fails if the document already exists, so a collision just draws
    another id (up to ORDER_ID_ATTEMPTS times).
    """
    for _ in range(ORDER_ID_ATTEMPTS):
        order_id = str(random.randint(10000, 99999))
        try:
            client.collection(ORDERS_COLLECTION).document(order_id).create({**order_data, "order_id": order_id})
            return order_id
        except gcp_exceptions.AlreadyExists:
            logger.warning(f"Order id {order_id} already taken, drawing another")
    raise HTTPException(status_code=503, detail={"message": "Could not allocate an order number, please try again"})


@app.post("/orders")
def place_order(
    order_req: PlaceOrderRequest,
    principal: Principal = Depends(current_principal),
    x_order_status: Optional[str] = Header(None, alias="X-Order-Status")
):
    if not principal.is_customer:
        raise HTTPException(status_code=403, detail={"message": "Customer access required"})
    # Identity comes only from the verified token; body email/name are ignored.
    customer_email = _caller_email(principal)
    customer_name = principal.name or "Valued Customer"

    client = get_firestore_client()
    menu_items = _price_list(client)

    unknown = sorted({item.item_id for item in order_req.items if item.item_id not in menu_items})
    if unknown:
        raise HTTPException(
            status_code=400,
            detail={"message": "Sorry, these items are not on the menu: " + ", ".join(unknown)
                    + ". Please choose something from the menu."},
        )

    sold_out = []
    for item in order_req.items:
        entry = menu_items[item.item_id]
        if entry.get("available", True) is False:
            label = " ".join(str(p) for p in (entry.get("size"), entry.get("name")) if p) or item.item_id
            sold_out.append(f"{label} ({item.item_id})")
    if sold_out:
        raise HTTPException(
            status_code=400,
            detail={"message": "Sorry, sold out right now: " + ", ".join(sold_out)
                    + ". Please choose something else from the menu."},
        )

    # Calculate total (integer cents, so the stored figure has no float drift).
    total_cents = 0
    for item in order_req.items:
        total_cents += round(float(menu_items[item.item_id].get("price") or 0) * 100) * item.quantity
    total_amount = round(total_cents / 100, 2)

    # Order value rules (defence in depth; the gateway applies them first).
    # Same body and status as the gateway's RF-Order-Limit-Exceeded, so the
    # agent sees one message whichever layer refuses the order.
    if total_cents >= ORDER_CAP_CENTS:
        logger.info(f"Order refused: total {total_cents}c >= cap {ORDER_CAP_CENTS}c")
        return JSONResponse(status_code=422, content={
            "error": "order_limit_exceeded",
            "message": f"This order comes to ${total_cents / 100:.2f}, and online orders must be under "
                       f"${_money_display(ORDER_CAP_CENTS)}. Please visit the shop to place a large order "
                       "with our staff.",
        })

    # Check loyalty id
    loyalty_id = None
    acc_doc = client.collection("loyalty_accounts").document(customer_email).get()
    if acc_doc.exists:
        loyalty_id = acc_doc.to_dict().get("loyalty_id")

    requested_status = (x_order_status or "").strip().upper()
    status = requested_status if requested_status in ACCEPTED_INITIAL_STATUSES else STATUS_IN_PROGRESS
    if total_cents >= APPROVAL_THRESHOLD_CENTS:
        # Needs staff approval even if the X-Order-Status header is missing.
        status = STATUS_PENDING_APPROVAL

    order_data = {
        "email": customer_email,
        "name": customer_name,
        "loyalty_id": loyalty_id or "L-12345",
        "items": [item.model_dump() for item in order_req.items],
        "status": status,
        "eta_minutes": random.randint(5, 9),
        "total_amount": total_amount,
        "created_at": _now_iso(),
    }

    order_id = _new_order_id(client, order_data)
    logger.info(f"Order placed: {order_id} ({status})")
    # total_amount is returned so the API gateway can quote the price back to the
    # customer. It is the same figure written to Firestore above, which keeps the
    # confirmation the customer sees in step with the order actually recorded.
    return {
        "order_id": order_id,
        "message": "Order successfully placed",
        "total_amount": total_amount,
        "status": status,
    }

@app.get("/orders/{order_id}")
def get_order(
    order_id: str = Path(..., pattern=ID_PATTERN),
    principal: Principal = Depends(current_principal),
):
    client = get_firestore_client()
    doc = client.collection(ORDERS_COLLECTION).document(order_id).get()
    # Same 404 for "missing" and "not yours", so order ids cannot be probed.
    if not doc.exists or not _can_see_order(principal, doc.to_dict() or {}):
        raise _order_not_found(order_id)
    return doc.to_dict()

@app.delete("/orders/{order_id}")
def cancel_order(
    order_id: str = Path(..., pattern=ID_PATTERN),
    principal: Principal = Depends(current_principal),
):
    client = get_firestore_client()
    doc_ref = client.collection(ORDERS_COLLECTION).document(order_id)
    doc = doc_ref.get()
    if not doc.exists:
        # Still return success or 404
        return {"message": "Order has been cancelled successfully"}
    if not _can_see_order(principal, doc.to_dict() or {}):
        raise _order_not_found(order_id)
    doc_ref.delete()
    return {"message": "Order has been cancelled successfully"}


def _loyalty_email(principal: Principal, requested: Optional[str]) -> str:
    """Customers act on their own account; staff/managers may name another email."""
    if requested and principal.is_staff:
        return requested.strip().lower()
    return _caller_email(principal)


@app.post("/loyalty/signup")
def signup_loyalty(req: SignUpLoyaltyRequest, principal: Principal = Depends(current_principal)):
    email = req.email.strip().lower() if (req.email and principal.is_manager) else _caller_email(principal)
    name = (req.name or "").strip() or principal.name or "Valued Customer"
    client = get_firestore_client()
    doc_ref = client.collection("loyalty_accounts").document(email)
    existing = doc_ref.get()
    if existing.exists:
        loyalty_id = existing.to_dict().get("loyalty_id")
    else:
        loyalty_id = f"L-{random.randint(10000, 99999)}"
        acc_data = {
            "loyalty_id": loyalty_id,
            "email": email,
            "name": name,
            "phone": (req.phone or "").strip(),
            "points": 100
        }
        doc_ref.set(acc_data)
        logger.info(f"Created loyalty account {loyalty_id}")

    return {
        "loyalty_id": loyalty_id,
        "message": "Successfully signed up for loyalty program."
    }

@app.get("/loyalty/balance")
def get_loyalty_balance(
    email: Optional[str] = Query(None, max_length=254, description="The user's email address (customers: ignored, always their own)"),
    principal: Principal = Depends(current_principal),
):
    client = get_firestore_client()
    doc = client.collection("loyalty_accounts").document(_loyalty_email(principal, email)).get()
    if doc.exists:
        return {"points": doc.to_dict().get("points", 150)}
    return {"points": 150}

@app.get("/rewards/{email}")
def get_rewards(email: str = Path(..., max_length=254), principal: Principal = Depends(current_principal)):
    return get_loyalty_balance(email=email, principal=principal)


# =============================================================================
# Staff app (/staff/*). Reached only through the Biscuit-Coffee-Shop proxy,
# which checks the scope per operation; the require_* calls repeat the check
# against the verified token.
# =============================================================================
class StaffStatusRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["IN_PROGRESS", "READY", "COMPLETED", "CANCELLED"]
    # Optional optimistic-concurrency check: 409 if the order is no longer in
    # this status (e.g. someone else moved it since the board was loaded).
    expected_status: Optional[OrderStatus] = None


class StaffDecisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    decision: Literal["APPROVE", "REJECT"]
    reason: Optional[str] = Field(None, max_length=500)
    expected_status: Optional[OrderStatus] = None


class StoreHoursRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    day: str = Field(..., min_length=3, max_length=12)
    open: Optional[str] = None
    close: Optional[str] = None
    closed: bool = False


class MenuItemPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    price: Optional[float] = Field(None, gt=0, le=100)
    name: Optional[str] = Field(None, min_length=1, max_length=60)
    available: Optional[bool] = None


def _order_sort_key(order: dict):
    return (str(order.get("created_at") or ""), str(order.get("order_id") or ""))


@app.get("/staff/orders")
def staff_list_orders(
    status: Optional[str] = Query(None, max_length=20, description="Order status, e.g. PENDING_APPROVAL"),
    customer: Optional[str] = Query(None, max_length=120, description="Customer email (exact) or name (contains)"),
    limit: int = Query(50, ge=1, le=200),
    principal: Principal = Depends(current_principal),
):
    require_staff(principal)
    client = get_firestore_client()
    orders = [doc.to_dict() for doc in client.collection(ORDERS_COLLECTION).stream()]
    if status:
        wanted = status.strip().upper()
        orders = [o for o in orders if str(o.get("status", "")).upper() == wanted]
    if customer:
        needle = customer.strip().lower()
        orders = [o for o in orders
                  if str(o.get("email", "")).lower() == needle or needle in str(o.get("name", "")).lower()]
    orders.sort(key=_order_sort_key, reverse=True)
    return orders[:limit]


@app.get("/staff/orders/{order_id}")
def staff_get_order(
    order_id: str = Path(..., pattern=ID_PATTERN),
    principal: Principal = Depends(current_principal),
):
    require_staff(principal)
    doc = get_firestore_client().collection(ORDERS_COLLECTION).document(order_id).get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail={"message": f"Order {order_id} not found"})
    return doc.to_dict()


@app.post("/staff/orders/{order_id}/status")
def staff_update_order_status(
    body: StaffStatusRequest,
    order_id: str = Path(..., pattern=ID_PATTERN),
    principal: Principal = Depends(current_principal),
):
    require_staff(principal)
    actor = _caller_email(principal)
    client = get_firestore_client()
    doc_ref = client.collection(ORDERS_COLLECTION).document(order_id)

    @firestore.transactional
    def _apply(txn):
        snap = doc_ref.get(transaction=txn)
        if not snap.exists:
            raise HTTPException(status_code=404, detail={"message": f"Order {order_id} not found"})
        data = snap.to_dict() or {}
        current = data.get("status")
        if body.expected_status and current != body.expected_status:
            raise HTTPException(
                status_code=409,
                detail={"message": f"Order {order_id} changed: it is now {current}, not {body.expected_status}"},
            )
        if current in DECISION_ONLY_STATUSES:
            raise HTTPException(
                status_code=409,
                detail={"message": f"Order {order_id} is {current}; use decideOrder for orders waiting for "
                                   "approval, and rejected orders cannot be changed"},
            )
        if body.status not in ALLOWED_TRANSITIONS.get(current, set()):
            allowed = sorted(ALLOWED_TRANSITIONS.get(current, set()))
            raise HTTPException(
                status_code=409,
                detail={"message": f"Order {order_id} cannot go from {current} to {body.status}"
                                   + (f" (allowed: {', '.join(allowed)})" if allowed else "")},
            )
        now = _now_iso()
        history = list(data.get("status_history") or [])
        history.append({"status": body.status, "by": actor, "at": now})
        update = {"status": body.status, "status_history": history, "updated_at": now, "updated_by": actor}
        txn.update(doc_ref, update)
        return current

    previous = _apply(client.transaction())
    logger.info(f"Order {order_id} status {previous} -> {body.status} by staff")
    return {"order_id": order_id, "previous_status": previous, "status": body.status, "updated_by": actor}


@app.post("/staff/orders/{order_id}/decision")
def staff_decide_order(
    body: StaffDecisionRequest,
    order_id: str = Path(..., pattern=ID_PATTERN),
    principal: Principal = Depends(current_principal),
):
    """Approve or reject an order that is waiting for approval.

    The decision is applied directly (Firestore transaction in decide_order), so
    the response carries the final status. A second decision gets 409.
    """
    require_staff(principal)
    actor = _caller_email(principal)
    approved = body.decision == "APPROVE"
    reason = (body.reason or "").strip() or None
    return decide_order(order_id, approved, actor, "staff-ui", reason, body.expected_status)


@app.get("/staff/employees/{employee_id}")
def staff_get_employee(
    employee_id: str = Path(..., pattern=ID_PATTERN),
    principal: Principal = Depends(current_principal),
):
    require_manager(principal)
    doc = get_firestore_client().collection("employees").document(employee_id).get()
    data = doc.to_dict() if doc.exists else next((e for e in SEED_EMPLOYEES if e["id"] == employee_id), None)
    if not data:
        raise HTTPException(status_code=404, detail={"message": f"Employee {employee_id} not found"})
    # Personal data: return only the directory fields.
    return {k: data.get(k) for k in ("id", "name", "phone", "email")}


def _to_12h(hhmm: str) -> str:
    hour, minute = (int(p) for p in hhmm.split(":"))
    suffix = "AM" if hour < 12 else "PM"
    return f"{hour % 12 or 12}:{minute:02d} {suffix}"


@app.put("/staff/store/hours")
def staff_update_store_hours(
    body: StoreHoursRequest,
    principal: Principal = Depends(current_principal),
):
    require_manager(principal)
    actor = _caller_email(principal)
    day = next((d for d in DAYS if d.lower() == body.day.strip().lower()), None)
    if not day:
        raise HTTPException(status_code=400, detail={"message": "day must be one of " + ", ".join(DAYS)})
    if body.closed:
        if body.open or body.close:
            raise HTTPException(status_code=400, detail={"message": "Send either closed=true or open/close, not both"})
        entry = {"day": day, "closed": True, "hours": "Closed"}
    else:
        if not (body.open and body.close and HHMM.match(body.open) and HHMM.match(body.close)):
            raise HTTPException(status_code=400, detail={"message": "open and close must be HH:MM (24-hour), e.g. 07:00"})
        if body.close <= body.open:
            raise HTTPException(status_code=400, detail={"message": "close must be later than open"})
        entry = {"day": day, "open": body.open, "close": body.close,
                 "hours": f"{_to_12h(body.open)} - {_to_12h(body.close)}"}

    doc_ref = get_firestore_client().collection("store_info").document("hours")
    snap = doc_ref.get()
    days = list((snap.to_dict() or {}).get("days") or SEED_HOURS) if snap.exists else [dict(d) for d in SEED_HOURS]
    days = [d for d in days if d.get("day") != day] + [entry]
    days.sort(key=lambda d: DAYS.index(d["day"]) if d.get("day") in DAYS else 99)
    doc_ref.set({"days": days, "updated_at": _now_iso(), "updated_by": actor})
    logger.info(f"Store hours for {day} updated by manager")
    return {"updated": entry, "days": days}


@app.patch("/staff/menu/{item_id}")
def staff_update_menu_item(
    body: MenuItemPatch,
    item_id: str = Path(..., pattern=ID_PATTERN),
    principal: Principal = Depends(current_principal),
):
    require_manager(principal)
    actor = _caller_email(principal)
    changes = body.model_dump(exclude_none=True)
    if not changes:
        raise HTTPException(status_code=400, detail={"message": "Send at least one of price, name, available"})
    if "price" in changes:
        changes["price"] = round(float(changes["price"]), 2)
    if "name" in changes:
        changes["name"] = changes["name"].strip()
    doc_ref = get_firestore_client().collection("menu").document(item_id)
    snap = doc_ref.get()
    if not snap.exists:
        raise HTTPException(status_code=404, detail={"message": f"Menu item {item_id} not found"})
    doc_ref.update({**changes, "updated_at": _now_iso(), "updated_by": actor})
    item = {**(snap.to_dict() or {}), **changes}
    item["available"] = item.get("available", True) is not False
    logger.info(f"Menu item {item_id} updated by manager: {sorted(changes)}")
    return item


@app.get("/staff/stats")
def staff_sales_stats(
    days: int = Query(7, ge=1, le=365),
    principal: Principal = Depends(current_principal),
):
    require_manager(principal)
    client = get_firestore_client()
    since = datetime.now(timezone.utc) - timedelta(days=days)
    all_orders = [doc.to_dict() for doc in client.collection(ORDERS_COLLECTION).stream()]
    names = {}
    for doc in client.collection("menu").stream():
        m = doc.to_dict()
        names[m.get("id")] = " ".join(str(p) for p in (m.get("size"), m.get("name")) if p)

    in_window, undated = [], 0
    for order in all_orders:
        created = _parse_iso(order.get("created_at")) if order.get("created_at") else None
        if created is None:
            undated += 1
        elif created >= since:
            in_window.append(order)

    by_status = Counter(str(o.get("status", "UNKNOWN")) for o in in_window)
    not_revenue = {STATUS_REJECTED, STATUS_CANCELLED, STATUS_PENDING_APPROVAL}
    revenue = sum(float(o.get("total_amount") or 0) for o in in_window if o.get("status") not in not_revenue)
    items = Counter()
    for o in in_window:
        if o.get("status") in (STATUS_REJECTED, STATUS_CANCELLED):
            continue
        for it in o.get("items") or []:
            items[it.get("item_id")] += int(it.get("quantity") or 0)
    return {
        "days": days,
        "since": since.isoformat(),
        "order_count": len(in_window),
        "revenue": round(revenue, 2),
        "average_order_value": round(revenue / max(1, sum(1 for o in in_window if o.get("status") not in not_revenue)), 2),
        "by_status": dict(by_status),
        "top_items": [{"item_id": i, "name": names.get(i, i), "quantity": q} for i, q in items.most_common(5)],
        "pending_approval_count": sum(1 for o in all_orders if o.get("status") == STATUS_PENDING_APPROVAL),
        "orders_without_timestamp": undated,
    }

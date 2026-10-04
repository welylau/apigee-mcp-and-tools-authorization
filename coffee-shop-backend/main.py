import os
import re
import random
import logging
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import List, Literal, Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query, Header, Path
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field
from google.cloud import firestore

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

# --- Staff / manager authorisation ------------------------------------------
# The API gateway (Biscuit-Coffee-Shop proxy) verifies the Keycloak JWT and
# forwards its scope claim as X-User-Scope; only the gateway's service account
# can invoke this Cloud Run service. The gateway already checks scopes per
# operation; the checks here are defence in depth.
SCOPE_STAFF = "biscuit_coffee_staff"
SCOPE_MANAGER = "biscuit_coffee_manager"
STATUS_READY = "READY"
STATUS_COMPLETED = "COMPLETED"
STATUS_CANCELLED = "CANCELLED"
# Orders in these states change only through decideOrder.
DECISION_ONLY_STATUSES = {STATUS_PENDING_APPROVAL, STATUS_REJECTED}
ID_PATTERN = r"^[A-Za-z0-9_-]{1,64}$"
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


def _scopes(x_user_scope: Optional[str]) -> set:
    return set((x_user_scope or "").split())


def require_staff(x_user_scope: Optional[str]) -> None:
    """Staff order operations: biscuit_coffee_staff or biscuit_coffee_manager."""
    if not ({SCOPE_STAFF, SCOPE_MANAGER} & _scopes(x_user_scope)):
        raise HTTPException(status_code=403, detail={"message": "Staff access required"})


def require_manager(x_user_scope: Optional[str]) -> None:
    """Employee, store and stats operations: biscuit_coffee_manager only."""
    if SCOPE_MANAGER not in _scopes(x_user_scope):
        raise HTTPException(status_code=403, detail={"message": "Store manager access required"})


def _staff_actor(x_user_email: Optional[str]) -> str:
    email = (x_user_email or "").strip().lower()
    if not email:
        raise HTTPException(status_code=403, detail={"message": "Caller identity missing"})
    return email


def decide_order(order_id: str, approved: bool, decided_by: str, channel: str,
                 reason: Optional[str] = None) -> dict:
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

# Models
class OrderItem(BaseModel):
    item_id: str
    quantity: int

class PlaceOrderRequest(BaseModel):
    items: List[OrderItem]
    email: Optional[str] = None
    name: Optional[str] = None

class SignUpLoyaltyRequest(BaseModel):
    email: str
    name: str
    phone: Optional[str] = None

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
def list_employees(x_user_scope: Optional[str] = Header(None, alias="X-User-Scope")):
    require_manager(x_user_scope)
    client = get_firestore_client()
    employees = []
    for doc in client.collection("employees").stream():
        employees.append(doc.to_dict())
    if not employees:
        return SEED_EMPLOYEES
    return sorted(employees, key=lambda x: x.get("id", ""))

@app.get("/orders")
def list_orders(
    filter: Optional[str] = Query(None, description="Format 'key:value' e.g. email:customer@example.com"),
    email: Optional[str] = Query(None),
    name: Optional[str] = Query(None),
    loyalty_id: Optional[str] = Query(None),
    x_user_email: Optional[str] = Header(None, alias="X-User-Email"),
    x_user_scope: Optional[str] = Header(None, alias="X-User-Scope")
):
    client = get_firestore_client()
    orders_ref = client.collection(ORDERS_COLLECTION)
    
    filter_key = None
    filter_val = None
    if filter and ":" in filter:
        parts = filter.split(":", 1)
        filter_key = parts[0].strip()
        filter_val = parts[1].strip()
    elif email:
        filter_key = "email"
        filter_val = email.strip()
    elif name:
        filter_key = "name"
        filter_val = name.strip()
    elif loyalty_id:
        filter_key = "loyalty_id"
        filter_val = loyalty_id.strip()
    elif x_user_email and (not x_user_scope or "biscuit_coffee_manager" not in x_user_scope):
        filter_key = "email"
        filter_val = x_user_email.strip()

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

@app.post("/orders")
def place_order(
    order_req: PlaceOrderRequest,
    x_user_email: Optional[str] = Header(None, alias="X-User-Email"),
    x_user_name: Optional[str] = Header(None, alias="X-User-Name"),
    x_order_status: Optional[str] = Header(None, alias="X-Order-Status")
):
    client = get_firestore_client()
    order_id = str(random.randint(10000, 99999))
    
    # Calculate total
    total_amount = 0.0
    menu_dict = {}
    menu_items = {}
    for doc in client.collection("menu").stream():
        data = doc.to_dict()
        menu_dict[data.get("id")] = data.get("price", 3.50)
        menu_items[data.get("id")] = data

    sold_out = []
    for item in order_req.items:
        entry = menu_items.get(item.item_id) or {}
        if entry.get("available", True) is False:
            label = " ".join(str(p) for p in (entry.get("size"), entry.get("name")) if p) or item.item_id
            sold_out.append(f"{label} ({item.item_id})")
    if sold_out:
        raise HTTPException(
            status_code=400,
            detail={"message": "Sorry, sold out right now: " + ", ".join(sold_out)
                    + ". Please choose something else from the menu."},
        )

    for item in order_req.items:
        price = menu_dict.get(item.item_id, 3.50)
        total_amount += price * item.quantity

    total_amount = round(total_amount, 2)

    customer_email = order_req.email or x_user_email or "customer@example.com"
    customer_name = order_req.name or x_user_name or "Valued Customer"

    # Check loyalty id
    loyalty_id = None
    if customer_email:
        acc_doc = client.collection("loyalty_accounts").document(customer_email.lower()).get()
        if acc_doc.exists:
            loyalty_id = acc_doc.to_dict().get("loyalty_id")

    requested_status = (x_order_status or "").strip().upper()
    status = requested_status if requested_status in ACCEPTED_INITIAL_STATUSES else STATUS_IN_PROGRESS

    order_data = {
        "order_id": order_id,
        "email": customer_email,
        "name": customer_name,
        "loyalty_id": loyalty_id or "L-12345",
        "items": [item.model_dump() if hasattr(item, "model_dump") else item.dict() for item in order_req.items],
        "status": status,
        "eta_minutes": random.randint(5, 9),
        "total_amount": total_amount,
        "created_at": _now_iso(),
    }

    client.collection(ORDERS_COLLECTION).document(order_id).set(order_data)
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
def get_order(order_id: str):
    client = get_firestore_client()
    doc = client.collection(ORDERS_COLLECTION).document(order_id).get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail={"message": f"Order {order_id} not found"})
    return doc.to_dict()

@app.delete("/orders/{order_id}")
def cancel_order(order_id: str):
    client = get_firestore_client()
    doc_ref = client.collection(ORDERS_COLLECTION).document(order_id)
    doc = doc_ref.get()
    if not doc.exists:
        # Still return success or 404
        return {"message": "Order has been cancelled successfully"}
    doc_ref.delete()
    return {"message": "Order has been cancelled successfully"}


@app.post("/loyalty/signup")
def signup_loyalty(req: SignUpLoyaltyRequest):
    client = get_firestore_client()
    doc_ref = client.collection("loyalty_accounts").document(req.email.lower())
    existing = doc_ref.get()
    if existing.exists:
        loyalty_id = existing.to_dict().get("loyalty_id")
    else:
        loyalty_id = f"L-{random.randint(10000, 99999)}"
        acc_data = {
            "loyalty_id": loyalty_id,
            "email": req.email,
            "name": req.name,
            "phone": req.phone or "",
            "points": 100
        }
        doc_ref.set(acc_data)
        logger.info(f"Created loyalty account for {req.email}: {loyalty_id}")

    return {
        "loyalty_id": loyalty_id,
        "message": "Successfully signed up for loyalty program."
    }

@app.get("/loyalty/balance")
def get_loyalty_balance(email: str = Query(..., description="The user's email address")):
    client = get_firestore_client()
    doc = client.collection("loyalty_accounts").document(email.lower()).get()
    if doc.exists:
        return {"points": doc.to_dict().get("points", 150)}
    return {"points": 150}

@app.get("/rewards/{email}")
def get_rewards(email: str):
    return get_loyalty_balance(email=email)


# =============================================================================
# Staff app (/staff/*). Reached only through the Biscuit-Coffee-Shop proxy,
# which checks the scope per operation; the require_* calls repeat the check.
# =============================================================================
class StaffStatusRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["IN_PROGRESS", "READY", "COMPLETED", "CANCELLED"]


class StaffDecisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    decision: Literal["APPROVE", "REJECT"]
    reason: Optional[str] = Field(None, max_length=500)


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
    x_user_scope: Optional[str] = Header(None, alias="X-User-Scope"),
):
    require_staff(x_user_scope)
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
    x_user_scope: Optional[str] = Header(None, alias="X-User-Scope"),
):
    require_staff(x_user_scope)
    doc = get_firestore_client().collection(ORDERS_COLLECTION).document(order_id).get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail={"message": f"Order {order_id} not found"})
    return doc.to_dict()


@app.post("/staff/orders/{order_id}/status")
def staff_update_order_status(
    body: StaffStatusRequest,
    order_id: str = Path(..., pattern=ID_PATTERN),
    x_user_email: Optional[str] = Header(None, alias="X-User-Email"),
    x_user_scope: Optional[str] = Header(None, alias="X-User-Scope"),
):
    require_staff(x_user_scope)
    actor = _staff_actor(x_user_email)
    client = get_firestore_client()
    doc_ref = client.collection(ORDERS_COLLECTION).document(order_id)

    @firestore.transactional
    def _apply(txn):
        snap = doc_ref.get(transaction=txn)
        if not snap.exists:
            raise HTTPException(status_code=404, detail={"message": f"Order {order_id} not found"})
        data = snap.to_dict() or {}
        current = data.get("status")
        if current in DECISION_ONLY_STATUSES:
            raise HTTPException(
                status_code=409,
                detail={"message": f"Order {order_id} is {current}; use decideOrder for orders waiting for "
                                   "approval, and rejected orders cannot be changed"},
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
    x_user_email: Optional[str] = Header(None, alias="X-User-Email"),
    x_user_scope: Optional[str] = Header(None, alias="X-User-Scope"),
):
    """Approve or reject an order that is waiting for approval.

    The decision is applied directly (Firestore transaction in decide_order), so
    the response carries the final status. A second decision gets 409.
    """
    require_staff(x_user_scope)
    actor = _staff_actor(x_user_email)
    approved = body.decision == "APPROVE"
    reason = (body.reason or "").strip() or None
    return decide_order(order_id, approved, actor, "staff-ui", reason)


@app.get("/staff/employees/{employee_id}")
def staff_get_employee(
    employee_id: str = Path(..., pattern=ID_PATTERN),
    x_user_scope: Optional[str] = Header(None, alias="X-User-Scope"),
):
    require_manager(x_user_scope)
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
    x_user_email: Optional[str] = Header(None, alias="X-User-Email"),
    x_user_scope: Optional[str] = Header(None, alias="X-User-Scope"),
):
    require_manager(x_user_scope)
    actor = _staff_actor(x_user_email)
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
    x_user_email: Optional[str] = Header(None, alias="X-User-Email"),
    x_user_scope: Optional[str] = Header(None, alias="X-User-Scope"),
):
    require_manager(x_user_scope)
    actor = _staff_actor(x_user_email)
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
    x_user_scope: Optional[str] = Header(None, alias="X-User-Scope"),
):
    require_manager(x_user_scope)
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

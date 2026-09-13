import os
import random
import logging
from typing import List, Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from google.cloud import firestore

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("coffee-shop-backend")

PROJECT_ID = os.getenv("GOOGLE_CLOUD_PROJECT", os.getenv("GCP_PROJECT", "YOUR_GCP_PROJECT_ID"))
DATABASE_ID = os.getenv("FIRESTORE_DATABASE", "(default)")
ORDERS_COLLECTION = os.getenv("ORDERS_COLLECTION", "coffee_orders")

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
        items.append(doc.to_dict())
    if not items:
        return SEED_MENU
    return items

@app.get("/employees")
def list_employees():
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
    x_user_name: Optional[str] = Header(None, alias="X-User-Name")
):
    client = get_firestore_client()
    order_id = str(random.randint(10000, 99999))
    
    # Calculate total
    total_amount = 0.0
    menu_dict = {}
    for doc in client.collection("menu").stream():
        data = doc.to_dict()
        menu_dict[data.get("id")] = data.get("price", 3.50)

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

    order_data = {
        "order_id": order_id,
        "email": customer_email,
        "name": customer_name,
        "loyalty_id": loyalty_id or "L-12345",
        "items": [item.model_dump() if hasattr(item, "model_dump") else item.dict() for item in order_req.items],
        "status": "IN_PROGRESS",
        "eta_minutes": random.randint(5, 9),
        "total_amount": total_amount
    }

    client.collection(ORDERS_COLLECTION).document(order_id).set(order_data)
    logger.info(f"Order placed: {order_id}")
    return {"order_id": order_id, "message": "Order successfully placed"}

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

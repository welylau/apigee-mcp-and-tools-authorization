# Mock Database for Biscuit Coffee

HOURS = {
    "Monday": "7:00 AM - 6:00 PM",
    "Tuesday": "7:00 AM - 6:00 PM",
    "Wednesday": "7:00 AM - 6:00 PM",
    "Thursday": "7:00 AM - 6:00 PM",
    "Friday": "7:00 AM - 8:00 PM",
    "Saturday": "8:00 AM - 8:00 PM",
    "Sunday": "8:00 AM - 4:00 PM"
}

MENU = {
    "Espresso": 3.00,
    "Latte": 4.50,
    "Cappuccino": 4.25,
    "Americano": 3.50,
    "Mucha": 5.00,
    "Cold Brew": 4.00,
    "Biscuit": 2.50,
    "Chocolate Chip Cookie": 3.00,
    "Croissant": 3.50
}

# Format: email -> { "name": str, "loyalty_points": int, "payment_method": str }
USERS = {}

# Format: order_id -> { "email": str, "items": list, "status": str }
ORDERS = {}

from . import mock_db
import uuid
def get_menu() -> str:
    """Returns the coffee shop menu."""
    menu_str = "Menu:\n"
    for item, price in mock_db.MENU.items():
        menu_str += f"{item}: ${price:.2f}\n"
    return menu_str

def sign_up_loyalty(email: str, name: str) -> str:
    """Signs up a user for loyalty rewards.
    
    Args:
        email: The user's email address.
        name: The user's name.
    """
    if email in mock_db.USERS:
        return f"User with email {email} is already registered."
    mock_db.USERS[email] = {
        "name": name,
        "loyalty_points": 0,
        "payment_method": None
    }
    return f"Successfully signed up {name} for loyalty rewards."

def get_reward_balance(email: str) -> str:
    """Checks the reward balance for a user.
    
    Args:
        email: The user's email address.
    """
    if email not in mock_db.USERS:
        return f"User with email {email} not found. Please sign up first."
    user = mock_db.USERS[email]
    return f"User {user['name']} has {user['loyalty_points']} points."

def get_hours_of_operation() -> str:
    """Returns the coffee shop's hours of operation."""
    hours_str = "Hours of Operation:\n"
    for day, hours in mock_db.HOURS.items():
        hours_str += f"{day}: {hours}\n"
    return hours_str

def add_payment_method(email: str, payment_details: str) -> str:
    """Adds a payment method for a user.
    
    Args:
        email: The user's email address.
        payment_details: The payment details (e.g., 'Visa ending in 1234').
    """
    if email not in mock_db.USERS:
        return f"User with email {email} not found. Please sign up first."
    mock_db.USERS[email]["payment_method"] = payment_details
    return f"Successfully added payment method for {email}."

def place_order(email: str, items: list[str]) -> str:
    """Places an order for a user.
    
    Args:
        email: The user's email address.
        items: A list of items to order.
    """
    if email not in mock_db.USERS:
        return f"User with email {email} not found. Please sign up first."
    
    user = mock_db.USERS[email]
    if not user["payment_method"]:
        return f"Please add a payment method before placing an order."
    
    for item in items:
        if item not in mock_db.MENU:
            return f"Item '{item}' is not on the menu."
    
    order_id = str(uuid.uuid4())[:8]
    mock_db.ORDERS[order_id] = {
        "email": email,
        "items": items,
        "status": "Received"
    }
    
    # Add some loyalty points (e.g., 10 points per order)
    user["loyalty_points"] += 10
    
    return f"Order placed successfully! Your order ID is {order_id}."

def get_order_status(order_id: str) -> str:
    """Checks the status of an existing order.
    
    Args:
        order_id: The ID of the order.
    """
    if order_id not in mock_db.ORDERS:
        return f"Order with ID {order_id} not found."
    order = mock_db.ORDERS[order_id]
    return f"Status of order {order_id}: {order['status']}."

def cancel_order(order_id: str) -> str:
    """Cancels an existing order.
    
    Args:
        order_id: The ID of the order.
    """
    if order_id not in mock_db.ORDERS:
        return f"Order with ID {order_id} not found."
    order = mock_db.ORDERS[order_id]
    if order["status"] == "Cancelled":
        return f"Order {order_id} is already cancelled."
    if order["status"] in ["Completed", "Out for Delivery"]:
        return f"Cannot cancel order {order_id} as it is already {order['status']}."
    
    order["status"] = "Cancelled"
    return f"Order {order_id} has been successfully cancelled."

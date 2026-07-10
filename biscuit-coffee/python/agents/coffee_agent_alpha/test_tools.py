from . import tools
from . import mock_db

def test():
    print("Testing tools...")
    
    # Test hours
    print(tools.get_hours_of_operation())
    
    # Test menu
    print(tools.get_menu())
    
    # Test loyalty signup
    print(tools.sign_up_loyalty("test@example.com", "Test User"))
    print(tools.get_reward_balance("test@example.com"))
    
    # Test add payment method
    print(tools.add_payment_method("test@example.com", "Visa 1234"))
    
    # Test place order
    print(tools.place_order("test@example.com", ["Espresso", "Biscuit"]))
    
    # Test order status
    orders = list(mock_db.ORDERS.keys())
    if orders:
        order_id = orders[0]
        print(tools.get_order_status(order_id))
        
        # Test cancel order
        print(tools.cancel_order(order_id))
        print(tools.get_order_status(order_id))
    else:
        print("No orders placed.")

if __name__ == "__main__":
    test()

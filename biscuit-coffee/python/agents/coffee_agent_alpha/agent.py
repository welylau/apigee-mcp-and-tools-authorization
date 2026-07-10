import os
from dotenv import load_dotenv
from google.adk.agents import Agent
from .tools import (
    sign_up_loyalty,
    get_reward_balance,
    get_hours_of_operation,
    get_menu,
    add_payment_method,
    place_order,
    get_order_status,
    cancel_order
)

load_dotenv()

MODEL_ID=os.getenv("MODEL_NAME")

# Define the Biscuit Coffee agent
root_agent = Agent(
    name="BiscuitCoffeeAgent",
    model=MODEL_ID,
    instruction=(
        "You are a helpful assistant for Biscuit Coffee shop. "
        "You can help users sign up for loyalty rewards, check their reward balance, "
        "lookup hours of operation, browse the menu, add a payment method, and place orders. "
        "You can also check the status of existing orders and cancel them. "
        "Be friendly and helpful."
    ),
    description="An online ordering agent for Biscuit Coffee.",
    tools=[
        sign_up_loyalty,
        get_reward_balance,
        get_hours_of_operation,
        get_menu,
        add_payment_method,
        place_order,
        get_order_status,
        cancel_order
    ]
)

if __name__ == "__main__":
    print("Agent defined successfully.")
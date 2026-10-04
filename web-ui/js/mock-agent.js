/**
 * Mock Agent Simulator for Biscuit Coffee
 * Provides realistic offline responses grounded in the actual Apigee policies,
 * OpenAPI specs, and ADK instructions from the repository.
 */

export const MOCK_DATABASE = {
  address: "123 Biscuit Lane, Coffee Town, CT 06001",
  hours: {
    "Monday": "7:00 AM - 6:00 PM",
    "Tuesday": "7:00 AM - 6:00 PM",
    "Wednesday": "7:00 AM - 6:00 PM",
    "Thursday": "7:00 AM - 6:00 PM",
    "Friday": "7:00 AM - 8:00 PM",
    "Saturday": "8:00 AM - 8:00 PM",
    "Sunday": "8:00 AM - 4:00 PM"
  },
  menu: {
    "Espresso": 3.00,
    "Latte": 4.50,
    "Cappuccino": 4.25,
    "Americano": 3.50,
    "Mocha": 5.00,
    "Cold Brew": 4.00,
    "Biscuit": 2.50,
    "Chocolate Chip Cookie": 3.00,
    "Croissant": 3.50
  },
  employees: [
    { id: "emp-101", name: "Jordan Smith", phone: "555-010-2345", email: "jordan.smith@gmail.com", role: "Head Barista" },
    { id: "emp-102", name: "Casey Montgomery", phone: "555-012-9876", email: "casey.m@gmail.com", role: "Shift Supervisor" },
    { id: "emp-103", name: "Alex Rivera", phone: "555-015-4433", email: "arivera@hotmail.com", role: "Senior Barista" },
    { id: "emp-104", name: "Taylor Chen", phone: "555-018-7766", email: "tchen.design@gmail.com", role: "Barista & Roaster" },
    { id: "emp-105", name: "Morgan Pierce", phone: "555-019-1122", email: "mpierce@yahoo.com", role: "Bakery Specialist" },
    { id: "emp-106", name: "Riley Vance", phone: "555-020-5588", email: "rvance@sky.com", role: "Cashier & Barista" },
    { id: "emp-107", name: "Jamie Thorne", phone: "555-021-3344", email: "j.thorne@gmail.com", role: "Barista" },
    { id: "emp-108", name: "Skyler Brooks", phone: "555-022-6677", email: "sbrooks@hotmail.com", role: "Inventory Coordinator" }
  ],
  users: {
    "customer@biscuit-coffee.com": {
      name: "John Smith",
      loyalty_points: 120
    },
    "customer2@biscuit-coffee.com": {
      name: "Michael Bosh",
      loyalty_points: 95
    }
  },
  orders: {
    "ord-8921": {
      email: "customer@biscuit-coffee.com",
      items: ["Latte (Oat Milk)", "Warm Biscuit with Honey"],
      status: "Brewing / In Preparation",
      total: 7.00
    }
  }
};

export async function simulateAgentResponse(userText, currentRole) {
  const query = userText.toLowerCase().trim();
  const user = MOCK_DATABASE.users[currentRole.email] || { name: "Guest", loyalty_points: 0 };

  // Simulated latency for realistic typing feel
  await new Promise(res => setTimeout(res, 600));

  // 1. Check for Employee Directory queries (Security RBAC check)
  if (query.includes("employee") || query.includes("staff") || query.includes("worker") || query.includes("roster") || query.includes("shift") || query.includes("who works here")) {
    if (!currentRole.scopes.includes("biscuit_coffee_manager")) {
      // 403 Forbidden - Customer does not have manager scope
      return {
        text: `Hello ${user.name.split(' ')[0]}! I apologize, but I am unable to view or list employee records.\n\n🔒 **Access Denied by Apigee Gateway**:\nViewing staff information requires the \`biscuit_coffee_manager\` scope. Your active credentials only possess the customer role (\`biscuit_coffee_customer\`).\n\nIs there anything else I can help you with today, such as our coffee menu or your loyalty rewards?`,
        toolCall: {
          name: "mcp_proxy_listEmployees",
          endpoint: "GET /biscuit-coffee/employees",
          policy: "RF-Invalid-Scope",
          scopeRequired: "biscuit_coffee_manager",
          status: "403 Forbidden",
          success: false,
          error: "Invalid Scope: Token missing biscuit_coffee_manager claim"
        }
      };
    } else {
      // 200 OK - Store Manager
      const empList = MOCK_DATABASE.employees
        .map(e => `• **${e.name}** (\`${e.id}\`) — *${e.role}*\n  📧 \`${e.email}\` | 📞 ${e.phone}`)
        .join("\n\n");

      return {
        text: `Welcome, Manager ${user.name.split(' ')[0]}. Here is the current staff directory retrieved from the secure Apigee backend:\n\n${empList}\n\nAll ${MOCK_DATABASE.employees.length} team members are currently active in the store roster. Would you like to check anything else?`,
        toolCall: {
          name: "mcp_proxy_listEmployees",
          endpoint: "GET /biscuit-coffee/employees",
          policy: "AM-ListEmployees",
          scopeRequired: "biscuit_coffee_manager",
          status: "200 OK",
          success: true,
          data: `${MOCK_DATABASE.employees.length} employees returned`
        }
      };
    }
  }

  // 2. Menu inquiries
  if (query.includes("menu") || query.includes("price") || query.includes("drink") || query.includes("food") || query.includes("pastry") || query.includes("cost")) {
    const menuFormatted = Object.entries(MOCK_DATABASE.menu)
      .map(([item, price]) => `• **${item}**: $${price.toFixed(2)}`)
      .join("\n");

    return {
      text: `Here is our current menu at **Biscuit Coffee**:\n\n${menuFormatted}\n\nOur signature is the freshly baked warm Biscuit ($2.50) and our artisanal Vanilla & Oat Milk Lattes ($4.50)! Would you like to place an order?`,
      toolCall: {
        name: "mcp_proxy_getMenu",
        endpoint: "GET /biscuit-coffee/menu",
        policy: "AM-GetMenu",
        scopeRequired: "None (Public)",
        status: "200 OK",
        success: true
      }
    };
  }

  // 3. Store Location & Hours
  if (query.includes("hour") || query.includes("open") || query.includes("close") || query.includes("location") || query.includes("address") || query.includes("where")) {
    const hoursFormatted = Object.entries(MOCK_DATABASE.hours)
      .map(([day, hours]) => `• **${day}**: ${hours}`)
      .join("\n");

    return {
      text: `We'd love to see you at **Biscuit Coffee**!\n\n📍 **Store Location:**\n\`${MOCK_DATABASE.address}\`\n\n🕒 **Hours of Operation:**\n${hoursFormatted}\n\nStop by anytime for freshly brewed coffee and hot biscuits!`,
      toolCall: {
        name: "mcp_proxy_getHoursAndLocation",
        endpoint: "GET /biscuit-coffee/location & /hours",
        policy: "AM-GetStoreLocation",
        scopeRequired: "None (Public)",
        status: "200 OK",
        success: true
      }
    };
  }

  // 4. Loyalty points / Rewards
  if (query.includes("loyalty") || query.includes("point") || query.includes("reward") || query.includes("balance")) {
    return {
      text: `Thank you for being a valued member, **${user.name}**! ⭐\n\nYour current loyalty rewards balance is:\n🎯 **${user.loyalty_points} Points**\n\nYou earn **10 points** for every drink and biscuit order! You are currently only 30 points away from a complimentary pastry.`,
      toolCall: {
        name: "mcp_proxy_getRewardBalance",
        endpoint: "GET /biscuit-coffee/loyalty/balance",
        policy: "AM-GetRewardBalance",
        scopeRequired: "biscuit_coffee_customer",
        status: "200 OK",
        success: true
      }
    };
  }

  // 5. Order Listing / Status / Tracking
  if (query.includes("all of my orders") || query.includes("all orders") || query.includes("my orders") || query.includes("show all") || query.includes("status") || query.includes("track")) {
    return {
      text: `Here are all the active orders associated with your account (**${currentRole.email}**):\n\n• **Order #67449**: 1x Latte (Small) — \`Completed\` ($3.50)\n• **Order #67450**: 1x Americano (Medium) — \`Brewing / In Preparation\` ($3.75)\n\nLet me know if you would like more details or want to place another order!`,
      toolCall: {
        name: "mcp_proxy_listOrders",
        endpoint: "GET /biscuit-coffee/orders",
        policy: "AM-ListOrders",
        scopeRequired: "biscuit_coffee_customer",
        status: "200 OK",
        success: true
      }
    };
  }

  // 7. Order Cancellation
  if (query.includes("cancel")) {
    return {
      text: `I looked up your active orders for **${user.name}**:\n\n📦 **Order #67450**:\n• **Items:** Americano (Medium)\n• **Status:** \`Brewing / In Preparation\`\n• **Estimated Pickup:** 4 minutes\n\nIf you need to make changes or cancel, please let me know right away before the baristas complete packaging!`,
      toolCall: {
        name: "mcp_proxy_getOrder",
        endpoint: "GET /biscuit-coffee/orders/67450",
        policy: "AM-GetOrder",
        scopeRequired: "biscuit_coffee_customer",
        status: "200 OK",
        success: true
      }
    };
  }

  // 8. Ordering coffee / pastries
  if (query.includes("order") || query.includes("buy") || query.includes("cappuccino") || query.includes("latte") || query.includes("croissant") || query.includes("biscuit")) {
    const newId = "ord-" + Math.floor(1000 + Math.random() * 9000);
    user.loyalty_points += 10;

    return {
      text: `Great choice, **${user.name.split(' ')[0]}**! I've placed your order with our baristas:\n\n🧾 **Order Details:**\n• **Order ID:** \`${newId}\`\n• **Account:** ${currentRole.email}\n• **Status:** \`Received - Barista Preparing\`\n• **Loyalty Reward:** +10 points added (New balance: **${user.loyalty_points} pts**)\n\nWe'll have it freshly prepared at the pickup counter at 123 Biscuit Lane in about 5 minutes!`,
      toolCall: {
        name: "mcp_proxy_placeOrder",
        endpoint: "POST /biscuit-coffee/orders",
        policy: "AM-PlaceOrder",
        scopeRequired: "biscuit_coffee_customer",
        status: "200 OK",
        success: true,
        orderId: newId
      }
    };
  }

  // 8. Default Greeting / General Help
  return {
    text: `Hello ${user.name.split(' ')[0]}! Welcome to **Biscuit Coffee**. ☕\n\nI can assist you with:\n• Browsing our fresh coffee & bakery menu\n• Checking store hours and location\n• Checking your loyalty rewards balance (${user.loyalty_points} pts)\n• Placing and tracking orders\n${currentRole.scopes.includes("biscuit_coffee_manager") ? "• 👔 **Manager Portal:** Listing employees and inspecting staff schedules\n" : ""}\nHow may I help you today?`,
    toolCall: null
  };
}

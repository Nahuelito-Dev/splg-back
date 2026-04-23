#!/bin/bash
BASE_URL="http://localhost:3000/api"
CYLINDER_ID="9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"
EMAIL="test.user.$RANDOM-$(date +%s)@example.com"

echo "--- Starting Full Flow Test (Bash) ---"

# 1. Create Time Slot
echo "[1] Creating Time Slot..."
SLOT_RES=$(curl -s -X POST "$BASE_URL/time-slot" -H "Content-Type: application/json" -d '{"name":"Mañana","startTime":"09:00","endTime":"13:00","capacity":50}')
SLOT_ID=$(echo $SLOT_RES | jq -r '.time_slot_id')

if [ "$SLOT_ID" == "null" ]; then
  echo "❌ Failed to create slot: $SLOT_RES"
  exit 1
fi
echo "✅ Slot Created: $SLOT_ID"

# 2. Create Customer
echo "[2] Creating Customer ($EMAIL)..."
USER_RES=$(curl -s -X POST "$BASE_URL/users/customer-registration" -H "Content-Type: application/json" -d "{\"email\":\"$EMAIL\",\"password\":\"Password123!\",\"full_name\":\"Test User\",\"phone_number\":\"+54911$RANDOM$RANDOM\",\"lat_lang\":\"-34.6037,-58.3816\"}")
USER_ID=$(echo $USER_RES | jq -r '.user_id')

if [ "$USER_ID" == "null" ]; then
  echo "❌ Failed to create user: $USER_RES"
  exit 1
fi
echo "✅ Customer Created: $USER_ID"

# 3. Create Address
echo "[3] Creating Address..."
ADDR_RES=$(curl -s -X POST "$BASE_URL/user-address" -H "Content-Type: application/json" -d "{\"user_id\":\"$USER_ID\",\"street\":\"Av. Corrientes\",\"number\":\"1234\",\"city\":\"Buenos Aires\",\"province\":\"CABA\",\"latitude\":-34.6037,\"longitude\":-58.3816,\"alias\":\"Casa\",\"floor\":\"1\",\"apartment\":\"A\",\"description\":\"Test Bash\"}")
ADDR_ID=$(echo $ADDR_RES | jq -r '.address_id')

if [ "$ADDR_ID" == "null" ]; then
  echo "❌ Failed to create address: $ADDR_RES"
  exit 1
fi
echo "✅ Address Created: $ADDR_ID"

# 4. Promo
echo "[4] Updating Promo..."
curl -s -X PATCH "$BASE_URL/gascylinder/$CYLINDER_ID" -H "Content-Type: application/json" -d '{"promotions":[{"quantity":2,"discountPercentage":10}]}' > /dev/null
echo "✅ Promo Updated"

# 5. Order
echo "[5] Creating Order..."
ORDER_RES=$(curl -s -X POST "$BASE_URL/orders" -H "Content-Type: application/json" -d "{\"customerId\":\"$USER_ID\",\"addressId\":\"$ADDR_ID\",\"timeSlotId\":\"$SLOT_ID\",\"paymentMethod\":\"TRANSFER\",\"items\":[{\"gasCylinderId\":\"$CYLINDER_ID\",\"quantity\":2}]}")
ORDER_ID=$(echo $ORDER_RES | jq -r '.order_id')
TOTAL=$(echo $ORDER_RES | jq -r '.totalAmount')

if [ "$ORDER_ID" == "null" ]; then
  echo "❌ Failed to create order: $ORDER_RES"
  exit 1
fi

echo "✅ Order Created: $ORDER_ID"
echo "💰 Total Amount: $TOTAL"

# Check Logic
if [[ "$TOTAL" == "16830" ]]; then
  echo "🎉 SUCCESS: Total Amount matches expected 16830"
else
  echo "❌ FAILURE: Expected 16830, got $TOTAL"
fi

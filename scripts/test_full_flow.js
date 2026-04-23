const crypto = require('crypto');

const BASE_URL = 'http://localhost:3000/api';
const CYLINDER_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'; // 10kg

async function run() {
    try {
        console.log('--- Starting Full Flow Test ---');

        // 1. Create Time Slot
        console.log('\n[1] Creating Time Slot...');
        const slotRes = await fetch(`${BASE_URL}/time-slot`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                startTime: '09:00',
                endTime: '13:00',
                capacity: 50
            })
        });
        const slot = await slotRes.json();
        if (!slotRes.ok) throw new Error(`Slot failed: ${JSON.stringify(slot)}`);
        console.log('✅ Slot Created:', slot.slot_id);

        // 2. Create Customer
        const email = `test.user.${crypto.randomUUID().slice(0, 8)}@example.com`;
        console.log(`\n[2] Creating Customer (${email})...`);
        const userRes = await fetch(`${BASE_URL}/users/customer-registration`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email,
                password: 'Password123!',
                full_name: 'Test User',
                phone_number: '+54911' + Math.floor(10000000 + Math.random() * 90000000),
                lat_lang: '-34.6037,-58.3816'
            })
        });
        const user = await userRes.json();
        if (!userRes.ok) throw new Error(`User failed: ${JSON.stringify(user)}`);
        // usersService.createCustomerWithUser returns the User entity which has user_id
        const customerId = user.user_id;
        console.log('✅ Customer Created:', customerId);

        // 3. Create Address
        console.log('\n[3] Creating Address...');
        const addressRes = await fetch(`${BASE_URL}/user-address`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user_id: customerId,
                street: 'Av. Corrientes',
                number: '1234',
                city: 'Buenos Aires',
                province: 'CABA',
                latitude: -34.6037,
                longitude: -58.3816,
                alias: 'Casa',
                floor: '1',
                apartment: 'A',
                description: 'Test'
            })
        });
        const address = await addressRes.json();
        if (!addressRes.ok) throw new Error(`Address failed: ${JSON.stringify(address)}`);
        const addressId = address.address_id;
        console.log('✅ Address Created:', addressId);

        // 4. Update Promo: Buy 2 get 10% off
        console.log('\n[4] updating Promo for Cylinder...');
        const promoRes = await fetch(`${BASE_URL}/gascylinder/${CYLINDER_ID}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                promotions: [
                    { quantity: 2, discountPercentage: 10 }
                ]
            })
        });
        const cylinder = await promoRes.json();
        if (!promoRes.ok) throw new Error(`Promo failed: ${JSON.stringify(cylinder)}`);
        console.log('✅ Promo Updated');

        // 5. Create Order
        console.log('\n[5] Creating Order...');
        // Buy 2 units.
        // Price: 8500 * 2 = 17000.
        // Discount 10%: 17000 * 0.9 = 15300.
        // Surcharge (Transfer 10%): 15300 * 1.1 = 16830.
        const orderRes = await fetch(`${BASE_URL}/orders`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                customerId: customerId,
                addressId: addressId,
                timeSlotId: slot.slot_id,
                paymentMethod: 'TRANSFER',
                items: [
                    { gasCylinderId: CYLINDER_ID, quantity: 2 }
                ]
            })
        });
        const order = await orderRes.json();
        if (!orderRes.ok) throw new Error(`Order failed: ${JSON.stringify(order)}`);

        console.log('✅ Order Created:', order.order_id);
        console.log('💰 Total Amount:', order.totalAmount);

        const expected = 16830;
        if (Math.abs(order.totalAmount - expected) < 0.1) {
            console.log('🎉 SUCCESS: Total Amount matches expected calculation (16830).');
        } else {
            console.error(`❌ FAILURE: Expected ${expected}, got ${order.totalAmount}`);
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
    }
}

run();

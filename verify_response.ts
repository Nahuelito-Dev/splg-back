import { Order, OrderStatus, PaymentType, PaymentMethod, PaymentStatus } from './src/order/entities/order.entity';
import { OrderMapper } from './src/order/order.mapper';
import { UserAddress } from './src/user-addres/entities/user-addres.entity';
import { TimeSlot } from './src/time-slot/entities/time-slot.entity';
import { instanceToPlain } from 'class-transformer';

// Mock Data
const address = new UserAddress();
address.address_id = 'addr-123';
address.street = 'Av. Libertador 1234';
address.city = 'Buenos Aires';
address.latitude = '-34.123456';
address.longitude = '-58.123456';
address.formattedAddress = 'Av. Libertador 1234, CABA';
address.additionalInstructions = 'Timbre 2B';

const timeSlot = new TimeSlot();
timeSlot.startTime = '09:00';
timeSlot.endTime = '13:00';

const order = new Order();
order.order_id = 'order-uuid-123';
order.totalAmount = 15500.50;
order.status = OrderStatus.ON_THE_WAY; // Should map to 'out_for_delivery'
order.paymentType = PaymentType.ONLINE; // Should map to 'online'
order.createdAt = new Date('2025-01-30T10:00:00Z');
order.deliveryInstructions = 'Dejar en porteria';
order.notes = 'Llamar antes';
order.address = address;
order.timeSlot = timeSlot;
order.items = []; // Empty for brevity

// Run Map
const dto = OrderMapper.toDto(order);

// Simulate Serialization (what NestJS does usually)
const plain = instanceToPlain(dto);

console.log(JSON.stringify(plain, null, 2));

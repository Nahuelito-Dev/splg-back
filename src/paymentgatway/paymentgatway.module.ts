import { Module } from '@nestjs/common';
import { PaymentgatwayService } from './paymentgatway.service';
import { PaymentgatwayController } from './paymentgatway.controller';

@Module({
  controllers: [PaymentgatwayController],
  providers: [PaymentgatwayService],
})
export class PaymentgatwayModule {}

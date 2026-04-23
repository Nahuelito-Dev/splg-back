import { Injectable } from '@nestjs/common';
import { CreatePaymentgatwayDto } from './dto/create-paymentgatway.dto';
import { UpdatePaymentgatwayDto } from './dto/update-paymentgatway.dto';

@Injectable()
export class PaymentgatwayService {
  create(createPaymentgatwayDto: CreatePaymentgatwayDto) {
    return 'This action adds a new paymentgatway';
  }

  findAll() {
    return `This action returns all paymentgatway`;
  }

  findOne(id: number) {
    return `This action returns a #${id} paymentgatway`;
  }

  update(id: number, updatePaymentgatwayDto: UpdatePaymentgatwayDto) {
    return `This action updates a #${id} paymentgatway`;
  }

  remove(id: number) {
    return `This action removes a #${id} paymentgatway`;
  }
}

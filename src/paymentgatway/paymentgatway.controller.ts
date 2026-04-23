import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { PaymentgatwayService } from './paymentgatway.service';
import { CreatePaymentgatwayDto } from './dto/create-paymentgatway.dto';
import { UpdatePaymentgatwayDto } from './dto/update-paymentgatway.dto';

@Controller('paymentgatway')
export class PaymentgatwayController {
  constructor(private readonly paymentgatwayService: PaymentgatwayService) {}

  @Post()
  create(@Body() createPaymentgatwayDto: CreatePaymentgatwayDto) {
    return this.paymentgatwayService.create(createPaymentgatwayDto);
  }

  @Get()
  findAll() {
    return this.paymentgatwayService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.paymentgatwayService.findOne(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updatePaymentgatwayDto: UpdatePaymentgatwayDto) {
    return this.paymentgatwayService.update(+id, updatePaymentgatwayDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.paymentgatwayService.remove(+id);
  }
}

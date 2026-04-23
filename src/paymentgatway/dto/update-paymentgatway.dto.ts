import { PartialType } from '@nestjs/mapped-types';
import { CreatePaymentgatwayDto } from './create-paymentgatway.dto';

export class UpdatePaymentgatwayDto extends PartialType(CreatePaymentgatwayDto) {}

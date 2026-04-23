import { Test, TestingModule } from '@nestjs/testing';
import { PaymentgatwayController } from './paymentgatway.controller';
import { PaymentgatwayService } from './paymentgatway.service';

describe('PaymentgatwayController', () => {
  let controller: PaymentgatwayController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentgatwayController],
      providers: [PaymentgatwayService],
    }).compile();

    controller = module.get<PaymentgatwayController>(PaymentgatwayController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { PaymentgatwayService } from './paymentgatway.service';

describe('PaymentgatwayService', () => {
  let service: PaymentgatwayService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PaymentgatwayService],
    }).compile();

    service = module.get<PaymentgatwayService>(PaymentgatwayService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});

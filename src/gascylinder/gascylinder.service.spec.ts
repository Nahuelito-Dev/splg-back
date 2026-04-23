import { Test, TestingModule } from '@nestjs/testing';
import { GascylinderService } from './gascylinder.service';

describe('GascylinderService', () => {
  let service: GascylinderService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [GascylinderService],
    }).compile();

    service = module.get<GascylinderService>(GascylinderService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});

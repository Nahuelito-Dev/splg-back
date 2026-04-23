import { Test, TestingModule } from '@nestjs/testing';
import { GascylinderController } from './gascylinder.controller';
import { GascylinderService } from './gascylinder.service';

describe('GascylinderController', () => {
  let controller: GascylinderController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [GascylinderController],
      providers: [GascylinderService],
    }).compile();

    controller = module.get<GascylinderController>(GascylinderController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});

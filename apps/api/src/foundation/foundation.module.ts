import { Module } from '@nestjs/common';
import { FoundationController } from './foundation.controller.js';
import { FoundationService } from './foundation.service.js';

@Module({
  controllers: [FoundationController],
  providers: [FoundationService],
})
export class FoundationModule {}

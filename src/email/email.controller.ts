// src/email/email.controller.ts
import {
  Controller,
  Post,
  Body,
  Get,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { EmailService } from './email.service';
import { Public } from '../common/decorators/isPublic.decorator';
import { SendPasswordResetDto } from './dto/send-password-reset.dto';
import { ChangeEmailDto } from './dto/change-email.dto';
import { TestEmailDto } from './dto/test-email.dto';

@ApiTags('Email')
@Controller('email')
export class EmailController {
  constructor(private readonly emailService: EmailService) {}

  @Public()
  @Post('password-reset')
  @ApiOperation({ summary: 'Send password reset email' })
  @ApiResponse({
    status: 200,
    description: 'Password reset email sent successfully',
  })
  @HttpCode(HttpStatus.OK)
  async sendPasswordReset(@Body() body: SendPasswordResetDto) {
    return await this.emailService.sendPasswordResetEmail(body.email);
  }

  @Post('change-email')
  @ApiOperation({ summary: 'Change user email' })
  @ApiResponse({
    status: 200,
    description: 'Email change initiated successfully',
  })
  async changeEmail(@Body() body: ChangeEmailDto) {
    return await this.emailService.changeEmail(
      body.currentEmail,
      body.newEmail,
      body.idToken,
    );
  }

  // En email.controller.ts - AGREGAR ESTE ENDPOINT TEMPORAL
  @Public()
  @Post('test')
  @ApiOperation({ summary: 'Test email service functionality' })
  async testEmailService(@Body() body: TestEmailDto) {
    return await this.emailService.testEmailService(body.email);
  }
}

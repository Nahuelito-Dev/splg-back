// src/notifications/notifications.controller.ts - VERSIÓN CORREGIDA
import { Controller, Post, Body, Get, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';

@ApiTags('Notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationService: NotificationsService) {}

  @Post('send-test')
  @ApiOperation({ summary: 'Send a test notification' })
  @ApiResponse({ status: 200, description: 'Notification sent' })
  async sendTestNotification(
    @Body() body: { token: string; title: string; body: string },
  ) {
    return await this.notificationService.sendTestNotification(
      body.token,
      body.title,
      body.body,
    );
  }

  @Post('order-confirmation')
  @ApiOperation({ summary: 'Send order confirmation notification' })
  @ApiResponse({ status: 200, description: 'Notification sent' })
  async sendOrderConfirmation(
    @Body() body: { customerId: string; orderId: string; token?: string },
  ) {
    // Este método debería ser implementado en el servicio
    return await this.notificationService.sendOrderConfirmation(
      body.customerId,
      body.orderId,
      body.token,
    );
  }

  @Get('user/:userId')
  @ApiOperation({ summary: 'Get notification tokens for user' })
  @ApiResponse({ status: 200, description: 'Tokens found' })
  async getUserTokens(@Param('userId') userId: string) {
    return await this.notificationService.getUserNotificationTokens(userId);
  }

  @Post('token')
  @ApiOperation({ summary: 'Save notification token for user' })
  @ApiResponse({ status: 200, description: 'Token saved' })
  async saveToken(
    @Body() body: { userId: string; token: string; platform: string },
  ) {
    return await this.notificationService.saveNotificationToken(
      body.userId,
      body.token,
      body.platform,
    );
  }
}

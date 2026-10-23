import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import type { OtpPurpose } from '@workbench/contracts';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { AppConfig } from './config';
import { ApiException } from './http';

const PURPOSE_LABEL: Record<OtpPurpose, string> = {
  register: '注册账号',
  login: '登录账号',
  reset: '重置密码',
};

@Injectable()
export class MailService implements OnApplicationShutdown {
  private readonly transport: Transporter;

  constructor(@Inject(AppConfig) private readonly config: AppConfig) {
    this.transport = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPassword } : undefined,
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 10_000,
      tls: { minVersion: 'TLSv1.2' },
    });
  }

  async sendCode(email: string, purpose: OtpPurpose, code: string): Promise<void> {
    try {
      const result = await this.transport.sendMail({
        from: this.config.smtpFrom,
        to: email,
        subject: `四层工作台 · ${PURPOSE_LABEL[purpose]}验证码`,
        text: `你的${PURPOSE_LABEL[purpose]}验证码为：${code}\n\n验证码 10 分钟内有效，仅可使用一次。请勿向他人透露。\n若非你本人操作，请忽略本邮件。`,
      });
      if (!Array.isArray(result.accepted) || result.accepted.length === 0) {
        throw new Error('SMTP did not accept recipient');
      }
    } catch {
      throw new ApiException('MAIL_UNAVAILABLE', '验证码邮件暂时发送失败，请稍后重试', 503);
    }
  }

  onApplicationShutdown(): void {
    this.transport.close();
  }
}

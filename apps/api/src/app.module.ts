import { Module } from '@nestjs/common';
import { AccountController } from './account.controller';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AppConfig } from './config';
import { DatabaseService } from './database.service';
import { HealthController } from './health.controller';
import { MailService } from './mail.service';
import { WorkItemsController } from './work-items.controller';
import { WorkItemsService } from './work-items.service';
import { InsightsService } from './insights.service';
import { InsightsController } from './insights.controller';
import { HistoryController } from './history.controller';
import { HistoryService } from './history.service';
import { RolloverService } from './rollover.service';
import { RolloverClock } from './rollover-clock';
import { DataController } from './data.controller';
import { DataService } from './data.service';

@Module({
  controllers: [
    AuthController,
    AccountController,
    HealthController,
    WorkItemsController,
    InsightsController,
    HistoryController,
    DataController,
  ],
  providers: [
    AppConfig,
    DatabaseService,
    MailService,
    AuthService,
    WorkItemsService,
    InsightsService,
    HistoryService,
    RolloverService,
    RolloverClock,
    DataService,
  ],
})
export class AppModule {}

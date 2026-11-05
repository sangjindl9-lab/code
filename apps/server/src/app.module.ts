import { Module } from '@nestjs/common';
import { AgentApiController, ProjectsController, PublicController } from './api';
import { AgentGuard, AuthController, AuthService, UserGuard } from './auth';
import { Db } from './db';
import { Pipeline } from './pipeline';
import { Hub } from './realtime';

@Module({
  controllers: [AuthController, ProjectsController, PublicController, AgentApiController],
  providers: [Db, AuthService, UserGuard, AgentGuard, Hub, Pipeline],
})
export class AppModule {}

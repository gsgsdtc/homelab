import { Module } from "@nestjs/common";
import { ModelProviderConnectionTester } from "./model-provider-connection-tester.service";
import { ModelProviderCredentialsService } from "./model-provider-credentials.service";
import { ModelProvidersController } from "./model-providers.controller";
import { ModelProvidersService } from "./model-providers.service";

@Module({
  controllers: [ModelProvidersController],
  providers: [ModelProvidersService, ModelProviderCredentialsService, ModelProviderConnectionTester],
  exports: [ModelProvidersService]
})
export class ModelProvidersModule {}

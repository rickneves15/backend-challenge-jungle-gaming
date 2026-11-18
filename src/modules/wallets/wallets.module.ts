import { Module } from '@nestjs/common';
import { OpenWalletUseCase } from '@/modules/wallets/services/open-wallet.use-case';
import { WalletsController } from '@/modules/wallets/controllers/wallets.controller';
import { PersistenceModule } from '@/shared/infrastructure/persistence/persistence.module';

@Module({
  imports: [PersistenceModule],
  providers: [OpenWalletUseCase],
  controllers: [WalletsController],
  exports: [OpenWalletUseCase],
})
export class WalletsModule {}

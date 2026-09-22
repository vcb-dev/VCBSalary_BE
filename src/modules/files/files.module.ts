import { Module } from '@nestjs/common';
import { SupabaseStorageClient } from './clients/supabase-storage.client';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';

@Module({
  controllers: [FilesController],
  providers: [SupabaseStorageClient, FilesService],
  exports: [FilesService],
})
export class FilesModule {}

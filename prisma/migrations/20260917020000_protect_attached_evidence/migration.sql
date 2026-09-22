-- Minh chứng đã gắn vào traffic là dữ liệu nghiệp vụ/audit và không được xóa dây chuyền.
ALTER TABLE "traffic_record_attachments"
  DROP CONSTRAINT IF EXISTS "traffic_record_attachments_file_attachment_id_fkey";

ALTER TABLE "traffic_record_attachments"
  ADD CONSTRAINT "traffic_record_attachments_file_attachment_id_fkey"
  FOREIGN KEY ("file_attachment_id") REFERENCES "file_attachments"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

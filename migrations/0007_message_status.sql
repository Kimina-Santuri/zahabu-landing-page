-- "Mark done" on the staff Messages page (photos.zahabu.co.ke/admin/messages), for both forms.
ALTER TABLE contact_messages ADD COLUMN done_at TEXT;
ALTER TABLE contact_messages ADD COLUMN done_by TEXT;
ALTER TABLE vendor_enquiries ADD COLUMN done_at TEXT;
ALTER TABLE vendor_enquiries ADD COLUMN done_by TEXT;

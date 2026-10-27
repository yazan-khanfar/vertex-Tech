BEGIN;
CREATE TABLE IF NOT EXISTS sdc."SUPPORT_TICKETS" (
 "Ticket_ID" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 "User_ID" bigint NOT NULL REFERENCES sdc."USER"("User_ID"),
 "Subject" varchar(150) NOT NULL,
 "Message" text NOT NULL,
 "Status" text NOT NULL DEFAULT 'open' CHECK ("Status" IN ('open','replied','closed')),
 "Reply" text,
 "Replied_By" bigint REFERENCES sdc."USER"("User_ID"),
 "Created_At" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "Updated_At" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_support_tickets_user ON sdc."SUPPORT_TICKETS"("User_ID","Created_At" DESC);
COMMIT;

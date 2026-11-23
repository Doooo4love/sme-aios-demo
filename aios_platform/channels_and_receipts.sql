CREATE TABLE IF NOT EXISTS aios_chat_read_receipt (
    tenant TEXT NOT NULL,
    room_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    last_read_seq BIGINT NOT NULL CHECK (last_read_seq >= 0),
    read_at DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (tenant, room_id, subject),
    FOREIGN KEY (tenant, room_id) REFERENCES aios_chat_room(tenant, id)
);

CREATE TABLE IF NOT EXISTS aios_channel_event_dedup (
    tenant TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    external_event_id TEXT NOT NULL,
    received_at DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (tenant, channel_id, external_event_id)
);

CREATE TABLE IF NOT EXISTS aios_channel_binding (
    tenant TEXT NOT NULL,
    subject TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    external_user_id TEXT NOT NULL,
    display_handle TEXT NOT NULL,
    verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
    updated_at DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (tenant, subject, channel_id)
);
CREATE INDEX IF NOT EXISTS aios_channel_binding_lookup
    ON aios_channel_binding(tenant, channel_id, external_user_id);

CREATE TABLE IF NOT EXISTS aios_channel_outbound_log (
    tenant TEXT NOT NULL,
    id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    sender_subject TEXT NOT NULL,
    target_handle TEXT NOT NULL,
    body_preview TEXT NOT NULL,
    body_sha256 TEXT NOT NULL,
    transport_mode TEXT NOT NULL,
    delivery_status TEXT NOT NULL,
    external_message_id TEXT NOT NULL,
    created_at DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (tenant, id),
    UNIQUE (tenant, sender_subject, client_id)
);
CREATE INDEX IF NOT EXISTS aios_channel_outbound_page
    ON aios_channel_outbound_log(tenant, created_at DESC, id DESC);

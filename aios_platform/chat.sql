CREATE TABLE IF NOT EXISTS aios_chat_room (
    tenant TEXT NOT NULL,
    id TEXT NOT NULL,
    owner TEXT NOT NULL,
    title TEXT NOT NULL,
    next_seq BIGINT NOT NULL DEFAULT 1 CHECK (next_seq > 0),
    PRIMARY KEY (tenant, id)
);

CREATE TABLE IF NOT EXISTS aios_chat_member (
    tenant TEXT NOT NULL,
    room_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    from_seq BIGINT NOT NULL CHECK (from_seq > 0),
    PRIMARY KEY (tenant, room_id, subject),
    FOREIGN KEY (tenant, room_id) REFERENCES aios_chat_room(tenant, id)
);
CREATE INDEX IF NOT EXISTS aios_chat_subject_room ON aios_chat_member(tenant, subject, room_id);

CREATE TABLE IF NOT EXISTS aios_chat_message (
    tenant TEXT NOT NULL,
    room_id TEXT NOT NULL,
    seq BIGINT NOT NULL,
    author TEXT NOT NULL,
    client_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (tenant, room_id, seq),
    UNIQUE (tenant, room_id, author, client_id),
    FOREIGN KEY (tenant, room_id) REFERENCES aios_chat_room(tenant, id)
);

/**
 * mentions.ts: pure helpers that turn channel-specific mention payloads into the public
 * `{ user_id, offset, length }` shape (same as `mentionSchema` in routes/chat.ts).
 * Never throw; malformed input yields an empty array.
 */
export interface EventMention { user_id: string; offset: number; length: number; }

function build(items: unknown, pick: (x: any) => [unknown, unknown, unknown]): EventMention[] {
    if (!Array.isArray(items)) return [];
    const out: EventMention[] = [];
    for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const [id, o, l] = pick(item);
        if (id === undefined || id === null || id === '') continue;
        const user_id = String(id);
        const offset = Number(o) || 0;
        const length = Number(l) || 0;
        if (!user_id || length <= 0) continue;
        out.push({ user_id, offset, length });
    }
    return out;
}

/** Zalo (zca-js) mentions: [{ uid, pos, len }]. */
export function fromZaloMentions(raw: unknown): EventMention[] {
    return build(raw, x => [x.uid, x.pos, x.len]);
}

/** Facebook MQTT delta.data.prng: JSON string or array of { i, o, l }. */
export function fromFbPrng(raw: unknown): EventMention[] {
    let value = raw;
    if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { return []; }
    }
    return build(value, x => [x.i, x.o, x.l]);
}

/** Already-normalized mentions (e.g. FBMQTTMessage.mentions): [{ user_id, offset, length }]. */
export function fromEventMentions(raw: unknown): EventMention[] {
    return build(raw, x => [x.user_id, x.offset, x.length]);
}
